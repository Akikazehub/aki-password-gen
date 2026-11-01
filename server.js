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
const NOT_FOUND = '404 page not found\n';
const LENGTH_ERROR = 'Please do not use length with more than 128 or fewer than 4 characters!\n';
const AMOUNT_ERROR = 'amount must be between 1 and 100\n';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
// Routine logs are silenced when this module is imported (e.g. by the tests).
const log = isMain ? (msg) => console.log(msg) : () => {};

function parseStrictInt(value, fallback) {
  if (value === null || !INTEGER_RE.test(value)) return fallback;
  // Go's strconv.Atoi errors on out-of-range integers and falls back to the
  // default; mirror that instead of clamping a huge number into the range check.
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
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

function handleGetPassword(res, url) {
  // Go's url.ParseQuery (1.17+) silently drops any query pair whose raw
  // segment contains a literal ';'; mirror that so legacy separator values
  // with an unencoded ';' behave exactly like upstream.
  const rawPairs = url.search.replace(/^\?/, '').split('&').filter((p) => !p.includes(';'));
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
            separator: sp.get('separator') ?? '',
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
    if (req.method !== 'GET') {
      // gorilla/mux answers non-GET with an empty 405 + Allow; mirror it.
      res.writeHead(405, { Allow: 'GET', 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    if (pathname === '/v1/healthz') {
      handleHealthz(res);
    } else if (pathname === '/v1/getPassword') {
      handleGetPassword(res, url);
    } else {
      sendText(res, 404, NOT_FOUND, { api: true });
    }
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    res.end();
    return;
  }
  for (const [route, baseDir, file, contentType] of STATIC_ROUTES) {
    if (pathname === route) {
      sendFile(res, baseDir, file, contentType);
      return;
    }
  }
  sendText(res, 404, NOT_FOUND);
}

export function startServer({ port = Number(process.env.PORT) || 3000 } = {}) {
  const server = http.createServer(handleRequest);
  server.listen(port, '0.0.0.0');
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
