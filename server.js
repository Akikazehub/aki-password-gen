// HTTP server for aki-password-gen: static frontend + a v1-compatible API
// mirroring github.com/Luzifer/password (Go). Zero npm dependencies.
//
//   GET /v1/healthz     -> 200, empty body
//   GET /v1/getPassword -> text/plain password(s), or JSON with format=json
//
// Request logs contain method, path and status only — never the query
// string, which can carry custom symbol sets or generated passwords.

import http from 'node:http';
import { readFile } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  generatePassword,
  generatePassphrase,
  normalizeOptions,
  sanitizeSpecialChars,
  LEGACY_SPECIAL_CHARS,
  MIN_LENGTH,
  MAX_LENGTH,
} from './lib/generator.mjs';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const LIB_DIR = path.join(ROOT_DIR, 'lib');

// Fixed route map: URL path -> [base directory, file, content type].
// Anything not listed here is a 404; files are resolved and verified to
// stay inside their base directory before being read.
const STATIC_ROUTES = [
  ['/', PUBLIC_DIR, 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', PUBLIC_DIR, 'app.js', 'text/javascript; charset=utf-8'],
  ['/style.css', PUBLIC_DIR, 'style.css', 'text/css; charset=utf-8'],
  ['/assets/generator.mjs', LIB_DIR, 'generator.mjs', 'text/javascript; charset=utf-8'],
  ['/assets/xkcd-words.mjs', LIB_DIR, 'xkcd-words.mjs', 'text/javascript; charset=utf-8'],
];

const INTEGER_RE = /^[+-]?\d+$/;
const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;
const NOT_FOUND = '404 page not found\n';
const LENGTH_ERROR = 'Please do not use length with more than 128 or fewer than 4 characters!\n';
const AMOUNT_ERROR = 'amount must be between 1 and 100\n';
const SEPARATOR_ERROR = 'separator must be at most 64 characters\n';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
// Routine logs are silenced when this module is imported (e.g. by the tests).
const log = isMain ? (msg) => console.log(msg) : () => {};

function parseStrictInt(value, fallback) {
  if (value === null || !INTEGER_RE.test(value)) return fallback;
  // Go's strconv.Atoi parses up to int64 (after which the 4..128 range check
  // runs) and errors beyond that, applying the default. Emulate both: values
  // within [2^53, 2^63) must reach the range check (=> 406), larger ones
  // fall back. 15 digits are always below 2^53, so parseInt stays exact.
  if (value.length <= 15) {
    return Number.parseInt(value, 10);
  }
  const big = BigInt(value);
  if (big > INT64_MAX || big < INT64_MIN) return fallback;
  return Number(big);
}

function parseStrictBool(value, fallback) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function sendText(res, status, body, { api = false, allow = null } = {}) {
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  };
  if (api) headers['Access-Control-Allow-Origin'] = '*';
  if (allow) headers.Allow = allow;
  res.writeHead(status, headers);
  res.end(body);
}

function sendFile(res, baseDir, relative, contentType) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) {
    sendText(res, 404, NOT_FOUND);
    return;
  }
  readFile(target, (err, data) => {
    // Missing files (e.g. an empty public/) degrade to 404, never a crash.
    if (err) {
      sendText(res, 404, NOT_FOUND);
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

function handleHealthz(res) {
  res.writeHead(200, {
    'Content-Length': '0',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.end();
}

// Go's url.ParseQuery (1.17+) silently drops any query pair whose raw segment
// contains a literal ';' or a malformed percent-escape; mirror both so legacy
// separator values behave exactly like upstream.
function isParseablePair(pair) {
  for (let i = 0; i < pair.length; i++) {
    if (pair[i] === ';') return false;
    if (pair[i] === '%') {
      if (!/^[0-9a-fA-F]{2}$/.test(pair.slice(i + 1, i + 3))) return false;
      i += 2;
    }
  }
  return true;
}

function handleGetPassword(res, url) {
  const rawPairs = url.search.replace(/^\?/, '').split('&').filter(isParseablePair);
  const sp = new URLSearchParams(rawPairs.join('&'));

  const length = parseStrictInt(sp.get('length'), 20);
  if (length < MIN_LENGTH || length > MAX_LENGTH) {
    sendText(res, 406, LENGTH_ERROR, { api: true });
    return;
  }

  const amount = parseStrictInt(sp.get('amount'), 1);
  if (amount < 1 || amount > 100) {
    sendText(res, 400, AMOUNT_ERROR, { api: true });
    return;
  }

  // Legacy aliasing: `special` wins over `symbols`; a custom symbol set
  // passed without either flag implies symbols=true.
  const specialRaw = sp.get('special');
  const symbolsRaw = sp.get('symbols');
  const customRaw = sp.get('special_chars') ?? sp.get('custom_symbols');
  let symbols;
  if (specialRaw !== null) symbols = specialRaw === 'true';
  else if (symbolsRaw !== null) symbols = symbolsRaw === 'true';
  else symbols = false;
  if (customRaw !== null && specialRaw === null && symbolsRaw === null) symbols = true;
  const specialChars = customRaw !== null ? sanitizeSpecialChars(customRaw) : LEGACY_SPECIAL_CHARS;

  const xkcd = sp.get('xkcd') === 'true';
  const asJson = sp.get('format') === 'json';

  // A giant separator would amplify into a giant response body (128 words x
  // separator x amount); cap it well below anything useful.
  const separator = sp.get('separator') ?? '';
  if (separator.length > 64) {
    sendText(res, 400, SEPARATOR_ERROR, { api: true });
    return;
  }

  // Configuration mistakes (empty symbol set, every class disabled, ...) are
  // client errors: preflight them so they answer 400 instead of failing with
  // a 500 from the middle of generation.
  const genOptions = xkcd ? null : {
    length,
    lowercase: parseStrictBool(sp.get('lowercase'), true),
    uppercase: parseStrictBool(sp.get('uppercase'), true),
    digits: parseStrictBool(sp.get('digits'), true),
    symbols,
    specialChars,
    excludeAmbiguous: parseStrictBool(sp.get('exclude_ambiguous'), true),
    allowRepeats: parseStrictBool(sp.get('allow_repeats'), false),
    avoidSequences: parseStrictBool(sp.get('avoid_sequences'), true),
  };
  if (genOptions) {
    try {
      normalizeOptions(genOptions);
    } catch (err) {
      sendText(res, 400, `${err.message}\n`, { api: true });
      return;
    }
  }

  const passwords = [];
  try {
    for (let i = 0; i < amount; i++) {
      passwords.push(xkcd
        ? generatePassphrase({
            words: length,
            separator,
            prependDate: sp.get('date') !== 'false',
          })
        : generatePassword(genOptions));
    }
  } catch (err) {
    sendText(res, 500, `generating password: ${err.message}\n`, { api: true });
    return;
  }

  if (asJson) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(passwords));
  } else {
    // Byte-compat: upstream sets exactly `text/plain` on success (no charset).
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(passwords.join('\n'));
  }
}

function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    sendText(res, 400, 'bad request\n');
    return;
  }
  const { pathname } = url;

  res.on('finish', () => log(`${req.method} ${pathname} ${res.statusCode}`));

  if (pathname.startsWith('/v1/')) {
    // Upstream registers healthz without a method restriction, and the router
    // 404s unknown paths before any method gate — mirror both orderings.
    if (pathname === '/v1/healthz') {
      handleHealthz(res);
      return;
    }
    if (pathname !== '/v1/getPassword') {
      sendText(res, 404, NOT_FOUND, { api: true });
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    handleGetPassword(res, url);
    return;
  }

  const route = STATIC_ROUTES.find(([path]) => path === pathname);
  if (!route) {
    sendText(res, 404, NOT_FOUND);
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    res.end();
    return;
  }
  sendFile(res, route[1], route[2], route[3]);
}

export function startServer({ port = Number(process.env.PORT) || 3000 } = {}) {
  const server = http.createServer(handleRequest);
  // No host argument: dual-stack listen (IPv6 + IPv4), like Go's `:3000`.
  server.listen(port);
  server.on('listening', () => {
    log(`aki-password-gen listening on :${server.address().port}`);
  });
  server.on('error', (err) => {
    console.error(`aki-password-gen: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (signal) => {
    log(`received ${signal}, shutting down`);
    server.closeIdleConnections?.();
    server.close(() => process.exit(0));
    // Safety net if a client holds a connection open past the grace period.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (isMain) {
  startServer();
}
