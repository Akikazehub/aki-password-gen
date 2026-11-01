// API tests for server.js: starts the real HTTP server on an ephemeral
// port (port 0) and exercises the v1 endpoints with plain fetch.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startServer } from '../server.js';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const AMBIGUOUS = 'Il0OB8';
const LEGACY_SPECIAL = '!#$%&()*+,-_./:;=?@[]^{}~|';

let server;
let base;

before(async () => {
  server = startServer({ port: 0 });
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeIdleConnections?.();
  return new Promise((resolve) => server.close(resolve));
});

const getPassword = (query = '') => fetch(`${base}/v1/getPassword${query}`);

test('GET /v1/healthz returns 200 with an empty body', async () => {
  const res = await fetch(`${base}/v1/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('default request returns legacy 20-char alnum password', async () => {
  for (let i = 0; i < 20; i++) {
    const res = await getPassword();
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').startsWith('text/plain'));
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const body = await res.text();
    assert.equal(body.length, 20);
    assert.ok(!body.endsWith('\n'), 'body must not end with a newline');
    assert.match(body, /[a-z]/, `no lowercase in ${body}`);
    assert.match(body, /[A-Z]/, `no uppercase in ${body}`);
    assert.match(body, /\d/, `no digit in ${body}`);
    for (const c of body) {
      assert.ok(!AMBIGUOUS.includes(c), `ambiguous char ${c} in ${body}`);
    }
  }
});

test('special=true draws from the legacy special set', async () => {
  let withSpecial = 0;
  for (let i = 0; i < 20; i++) {
    const res = await getPassword('?special=true');
    assert.equal(res.status, 200);
    const body = await res.text();
    if ([...LEGACY_SPECIAL].some((c) => body.includes(c))) withSpecial++;
    for (const c of body) {
      const inPool = LOWER.includes(c) || UPPER.includes(c) || DIGITS.includes(c) || LEGACY_SPECIAL.includes(c);
      assert.ok(inPool, `char outside legacy pool: ${c} in ${body}`);
      assert.ok(!AMBIGUOUS.includes(c), `ambiguous char ${c} in ${body}`);
    }
  }
  assert.equal(withSpecial, 20, 'every password must contain a special char');
});

test('length out of bounds returns 406 with the legacy message', async () => {
  for (const l of ['3', '200']) {
    const res = await getPassword(`?length=${l}`);
    assert.equal(res.status, 406);
    assert.equal(
      await res.text(),
      'Please do not use length with more than 128 or fewer than 4 characters!\n',
    );
  }
});

test('non-numeric length falls back to the default of 20', async () => {
  const res = await getPassword('?length=abc');
  assert.equal(res.status, 200);
  assert.equal((await res.text()).length, 20);
});

test('xkcd mode: default date prefix, date=false opt-out, separator dashes', async () => {
  const dated = await (await getPassword('?xkcd=true&length=4')).text();
  assert.match(dated, /^\d{8}\.[A-Z][a-z]+/);

  const plain = await (await getPassword('?xkcd=true&length=4&date=false')).text();
  assert.doesNotMatch(plain, /^\d{8}\./);
  const words = plain.split(/(?<=[a-z])(?=[A-Z])/);
  assert.equal(words.length, 4);
  for (const w of words) assert.match(w, /^[A-Z][a-z]+$/, `not title-cased: ${w}`);
  assert.equal(new Set(words).size, 4, 'words must be unique');

  const dashed = await (await getPassword('?xkcd=true&length=5&separator=-')).text();
  assert.equal(dashed.split('-').length, 5, `expected 4 dashes in ${dashed}`);
});

test('special_chars restricts the symbol pool to the given set', async () => {
  let sawCustom = 0;
  for (let i = 0; i < 20; i++) {
    const res = await getPassword('?special_chars=%21%40');
    assert.equal(res.status, 200);
    const body = await res.text();
    if (body.includes('!') || body.includes('@')) sawCustom++;
    for (const c of body) {
      const inPool = LOWER.includes(c) || UPPER.includes(c) || DIGITS.includes(c) || '!@'.includes(c);
      assert.ok(inPool, `char outside custom pool: ${c} in ${body}`);
      assert.ok(!AMBIGUOUS.includes(c), `ambiguous char ${c} in ${body}`);
    }
  }
  assert.ok(sawCustom > 0, 'expected at least one custom symbol across 20 draws');
});

test('special_chars alone implies symbols=true', async () => {
  let sawSymbol = 0;
  for (let i = 0; i < 20; i++) {
    const res = await getPassword('?special_chars=%21');
    assert.equal(res.status, 200);
    const body = await res.text();
    if (body.includes('!')) sawSymbol++;
    for (const c of body) {
      const inPool = LOWER.includes(c) || UPPER.includes(c) || DIGITS.includes(c) || c === '!';
      assert.ok(inPool, `char outside pool: ${c} in ${body}`);
      assert.ok(!AMBIGUOUS.includes(c), `ambiguous char ${c} in ${body}`);
    }
  }
  assert.ok(sawSymbol > 0, 'symbols must be implied on (expected ! in the output)');
});

test('lowercase=false yields no lowercase letters', async () => {
  for (let i = 0; i < 10; i++) {
    const res = await getPassword('?lowercase=false');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(!/[a-z]/.test(body), `lowercase in ${body}`);
    assert.match(body, /[A-Z]/, `no uppercase in ${body}`);
    assert.match(body, /\d/, `no digit in ${body}`);
  }
});

test('digits-only config yields unambiguous digits only', async () => {
  for (let i = 0; i < 10; i++) {
    const res = await getPassword('?digits=true&lowercase=false&uppercase=false');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body.length, 20);
    for (const c of body) {
      assert.ok('12345679'.includes(c), `unexpected char ${c} in ${body}`);
    }
  }
});

test('amount=5 in text mode returns 5 newline-joined passwords', async () => {
  const res = await getPassword('?amount=5');
  assert.equal(res.status, 200);
  const body = await res.text();
  const parts = body.split('\n');
  assert.equal(parts.length, 5);
  for (const p of parts) assert.equal(p.length, 20, `short password: ${p}`);
});

test('format=json&amount=3 returns a JSON array of 3 strings', async () => {
  const res = await getPassword('?format=json&amount=3');
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').startsWith('application/json'));
  const arr = JSON.parse(await res.text());
  assert.ok(Array.isArray(arr));
  assert.equal(arr.length, 3);
  for (const p of arr) {
    assert.equal(typeof p, 'string');
    assert.equal(p.length, 20);
  }
});

test('amount out of range returns 400 with the legacy message', async () => {
  const res = await getPassword('?amount=200');
  assert.equal(res.status, 400);
  assert.equal(await res.text(), 'amount must be between 1 and 100\n');
});

test('format=json with default amount returns an array of one password', async () => {
  const res = await getPassword('?format=json');
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').startsWith('application/json'));
  const arr = JSON.parse(await res.text());
  assert.equal(arr.length, 1);
  assert.equal(typeof arr[0], 'string');
});

test('API responses carry the CORS header', async () => {
  const res = await getPassword();
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('unknown paths return 404', async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/v1/nope`)).status, 404);
});

test('symbols=true behaves like the legacy special=true alias', async () => {
  const res = await getPassword('?symbols=true');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok([...LEGACY_SPECIAL].some((c) => body.includes(c)), `no special char in ${body}`);
});

test('xkcd word count is range checked like length', async () => {
  const res = await getPassword('?xkcd=true&length=3');
  assert.equal(res.status, 406);
  assert.equal(
    await res.text(),
    'Please do not use length with more than 128 or fewer than 4 characters!\n',
  );
});

test('non-GET requests are rejected with 405', async () => {
  const res = await fetch(`${base}/v1/getPassword`, { method: 'POST' });
  assert.equal(res.status, 405);
});

test('static routes never expose unmapped files and 404 gracefully', async () => {
  for (const p of ['/lib/generator.mjs', '/%2e%2e/server.js', '/app.js.bak', '/server.js']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, `expected 404 for ${p}`);
    await res.text();
  }
  // public/ may be empty while the frontend is built in parallel.
  const root = await fetch(`${base}/`);
  assert.ok(root.status === 200 || root.status === 404);
  if (root.status === 200) {
    assert.ok(root.headers.get('content-type').startsWith('text/html'));
    await root.text();
  }
});
