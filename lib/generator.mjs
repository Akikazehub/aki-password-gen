// Isomorphic password generation core, shared by the HTTP API (server.js)
// and the browser frontend (public/app.js via /assets/generator.mjs).
// No dependencies; randomness comes from Web Crypto on both sides.
//
// The legacy profile replicates github.com/Luzifer/password v1 semantics:
//   - pool = lowercase + uppercase + digits (+ special set when enabled)
//   - ambiguous characters I l 0 O B 8 are never drawn
//   - adjacent repeated characters are rejected
//   - keyboard/alphabet sequences of 3 characters are rejected
//   - every enabled character class must appear at least once

import { XKCD_WORDS } from './xkcd-words.mjs';

export const LEGACY_SPECIAL_CHARS = '!#$%&()*+,-_./:;=?@[]^{}~|';
export const AMBIGUOUS_CHARS = 'Il0OB8';
export const MIN_LENGTH = 4;
export const MAX_LENGTH = 128;

const INSECURE_PATTERNS = [
  'abcdefghijklmnopqrstuvwxyz',      // Alphabet
  'zyxwvutsrqponmlkjihgfedcba',      // Alphabet reversed
  '01234567890',                     // Numeric increasing
  '09876543210',                     // Numeric decreasing
  'qwertzuiopasdfghjklyxcvbnm',      // German keyboard layout
  'mnbvcxylkjhgfdsapoiuztrewq',      // German keyboard layout reversed
  'qwertyuiopasdfghjklzxcvbnm',      // US keyboard layout
  'mnbvcxzlkjhgfdsapoiuytrewq',      // US keyboard layout reversed
  '789_456_123_147_258_369_159_753', // Numpad patterns
];

export const DEFAULT_OPTIONS = Object.freeze({
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: false,
  specialChars: LEGACY_SPECIAL_CHARS,
  excludeAmbiguous: true,
  allowRepeats: false,
  avoidSequences: true,
});

// Unbiased random integer in [0, max) via rejection sampling.
function randInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % max;
}

// Keep every character once, drop control characters.
export function sanitizeSpecialChars(str) {
  return [...new Set([...String(str)])].filter((c) => c >= ' ').join('');
}

// Per-class character pools with ambiguous characters filtered out.
function buildClassPools(opts) {
  const push = (chars) => {
    const filtered = opts.excludeAmbiguous
      ? [...chars].filter((c) => !AMBIGUOUS_CHARS.includes(c)).join('')
      : chars;
    pools.push(filtered);
  };
  const pools = [];
  if (opts.lowercase) push('abcdefghijklmnopqrstuvwxyz');
  if (opts.uppercase) push('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  if (opts.digits) push('0123456789');
  if (opts.symbols) push(opts.specialChars);
  return pools;
}

// Merge raw (partially filled) options over the defaults and sanitize them.
// Throws when the resulting configuration can never yield a password.
export function normalizeOptions(raw = {}) {
  const opts = { ...DEFAULT_OPTIONS };
  for (const key of ['lowercase', 'uppercase', 'digits', 'symbols', 'excludeAmbiguous', 'allowRepeats', 'avoidSequences']) {
    if (raw[key] !== undefined) opts[key] = Boolean(raw[key]);
  }
  if (raw.specialChars !== undefined) opts.specialChars = sanitizeSpecialChars(raw.specialChars);
  if (raw.length !== undefined && typeof raw.length === 'number' && Number.isFinite(raw.length)) {
    opts.length = Math.trunc(raw.length);
  }
  if (opts.length < MIN_LENGTH || opts.length > MAX_LENGTH) {
    throw new Error(`length must be between ${MIN_LENGTH} and ${MAX_LENGTH}`);
  }

  if (opts.symbols && opts.specialChars === '') {
    throw new Error('symbol set is empty');
  }
  const pools = buildClassPools(opts);
  if (pools.length === 0) {
    throw new Error('at least one character class must be enabled');
  }
  if (pools.some((p) => p === '')) {
    throw new Error('one of the enabled character classes has no usable characters');
  }
  return opts;
}

function hasAdjacentRepeat(pw) {
  for (let i = 1; i < pw.length; i++) {
    if (pw[i - 1] === pw[i]) return true;
  }
  return false;
}

function hasInsecurePattern(pw) {
  for (let i = 0; i <= pw.length - 3; i++) {
    const slice = pw.slice(i, i + 3);
    for (const pattern of INSECURE_PATTERNS) {
      if (pattern.includes(slice) || pattern.toUpperCase().includes(slice)) return true;
    }
  }
  return false;
}

// Entropy estimate in bits for strength display.
export function entropyBits(opts) {
  const o = { ...DEFAULT_OPTIONS };
  for (const [key, value] of Object.entries(opts ?? {})) {
    if (value !== undefined) o[key] = value;
  }
  if (o.symbols) {
    o.specialChars = typeof o.specialChars === 'string' ? sanitizeSpecialChars(o.specialChars) : DEFAULT_OPTIONS.specialChars;
  }
  if (!Number.isFinite(o.length)) return 0;
  const pool = buildClassPools(o).join('').length;
  if (pool === 0) return 0;
  return Math.round(o.length * Math.log2(pool));
}

// Generate one random password. Throws on impossible configurations.
export function generatePassword(rawOptions = {}) {
  const opts = normalizeOptions(rawOptions);
  const pools = buildClassPools(opts);
  const pool = pools.join('');
  // Draw by code point so astral-plane symbols (emoji etc.) stay well-formed.
  const chars = [...pool];

  // Fail fast on configurations whose acceptance probability is ~0 (e.g. a
  // 1-character pool with adjacent repeats forbidden): the retry loop would
  // otherwise burn its full budget before throwing.
  if (!opts.allowRepeats && opts.length > 1) {
    const pNoRepeat = chars.length === 1 ? 0 : ((chars.length - 1) / chars.length) ** (opts.length - 1);
    if (pNoRepeat < 1e-7) {
      throw new Error('rules make a valid password practically unreachable');
    }
  }

  for (let attempt = 0; attempt < 10000; attempt++) {
    let pw = '';
    for (let i = 0; i < opts.length; i++) pw += chars[randInt(chars.length)];

    if (!pools.every((p) => [...p].some((c) => pw.includes(c)))) continue;
    if (!opts.allowRepeats && hasAdjacentRepeat(pw)) continue;
    if (opts.avoidSequences && hasInsecurePattern(pw)) continue;
    return pw;
  }
  throw new Error('unable to generate a password matching the requested rules');
}

// XKCD-style passphrase: `words` unique title-cased words joined by
// `separator`, optionally prefixed with the local date as YYYYMMDD.
export function generatePassphrase({ words = 4, separator = '', prependDate = true } = {}) {
  const wordCount = Math.trunc(words);
  if (!Number.isSafeInteger(wordCount) || wordCount < MIN_LENGTH) {
    throw new Error('passphrases with less than 4 words makes no sense');
  }
  if (wordCount > XKCD_WORDS.length) {
    throw new Error('not enough unique words in the word list');
  }

  let prefix = '';
  if (prependDate) {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    prefix = `${now.getFullYear()}${mm}${dd}.`;
  }

  const used = new Set();
  const parts = [];
  while (parts.length < wordCount) {
    const word = XKCD_WORDS[randInt(XKCD_WORDS.length)];
    const title = word[0].toUpperCase() + word.slice(1);
    if (used.has(title)) continue;
    used.add(title);
    parts.push(title);
  }
  return prefix + parts.join(separator);
}

export function passphraseEntropyBits({ words = 4 } = {}) {
  const wordCount = Math.trunc(words);
  if (!Number.isSafeInteger(wordCount) || wordCount < 0) return 0;
  return Math.round(wordCount * Math.log2(XKCD_WORDS.length));
}
