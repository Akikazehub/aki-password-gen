import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_SPECIAL_CHARS,
  AMBIGUOUS_CHARS,
  generatePassword,
  generatePassphrase,
  entropyBits,
  passphraseEntropyBits,
  sanitizeSpecialChars,
} from '../lib/generator.mjs';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';

function hasClass(pw, chars) {
  return [...chars].some((c) => pw.includes(c));
}

function hasAdjacentRepeat(pw) {
  for (let i = 1; i < pw.length; i++) {
    if (pw[i - 1] === pw[i]) return true;
  }
  return false;
}

function hasInsecurePattern(pw) {
  const patterns = [
    'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba',
    '01234567890', '09876543210',
    'qwertzuiopasdfghjklyxcvbnm', 'mnbvcxylkjhgfdsapoiuztrewq',
    'qwertyuiopasdfghjklzxcvbnm', 'mnbvcxzlkjhgfdsapoiuytrewq',
    '789_456_123_147_258_369_159_753',
  ];
  for (let i = 0; i <= pw.length - 3; i++) {
    const slice = pw.slice(i, i + 3);
    for (const p of patterns) {
      if (p.includes(slice) || p.toUpperCase().includes(slice)) return true;
    }
  }
  return false;
}

test('legacy defaults match Luzifer/password semantics', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword({ length: 20 });
    assert.equal(pw.length, 20);
    for (const c of pw) {
      assert.ok(!AMBIGUOUS_CHARS.includes(c), `ambiguous char ${c} in ${pw}`);
      assert.ok(LOWER.includes(c) || UPPER.includes(c) || DIGITS.includes(c), `unexpected char ${c}`);
    }
    assert.ok(hasClass(pw, LOWER), `no lowercase in ${pw}`);
    assert.ok(hasClass(pw, UPPER), `no uppercase in ${pw}`);
    assert.ok(hasClass(pw, DIGITS), `no digits in ${pw}`);
    assert.equal(hasAdjacentRepeat(pw), false, `adjacent repeat in ${pw}`);
    assert.equal(hasInsecurePattern(pw), false, `insecure pattern in ${pw}`);
  }
});

test('special=true only draws from legacy special set and requires it', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword({ length: 32, symbols: true });
    for (const c of pw) {
      const ok = LOWER.includes(c) || UPPER.includes(c) || DIGITS.includes(c) || LEGACY_SPECIAL_CHARS.includes(c);
      assert.ok(ok && !AMBIGUOUS_CHARS.includes(c), `unexpected char ${c} in ${pw}`);
    }
    assert.ok(hasClass(pw, LEGACY_SPECIAL_CHARS), `no special char in ${pw}`);
  }
});

test('custom symbol set restricts symbols and implies usability', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword({ length: 24, symbols: true, specialChars: '!@#$%' });
    for (const c of pw) {
      const ok = LOWER.includes(c) || UPPER.includes(c) || DIGITS.includes(c) || '!@#$%'.includes(c);
      assert.ok(ok, `char outside custom pool: ${c} in ${pw}`);
    }
  }
});

test('class toggles are honored', () => {
  for (let i = 0; i < 100; i++) {
    const pw = generatePassword({ length: 16, lowercase: false });
    assert.doesNotMatch(pw, /[a-z]/, `lowercase present in ${pw}`);
    assert.ok(hasClass(pw, UPPER) && hasClass(pw, DIGITS), pw);
  }
  for (let i = 0; i < 100; i++) {
    const pw = generatePassword({ length: 12, lowercase: false, uppercase: false, symbols: false });
    assert.match(pw, /^[1-79]+$/, `non-digit or ambiguous digit in ${pw}`);
  }
});

test('excludeAmbiguous=false allows ambiguous characters', () => {
  let sawZero = false;
  for (let i = 0; i < 500; i++) {
    const pw = generatePassword({ length: 32, excludeAmbiguous: false });
    if (pw.includes('0') || pw.includes('I')) sawZero = true;
    const ok = [...pw].every((c) => LOWER.includes(c) || UPPER.includes(c) || DIGITS.includes(c) || LEGACY_SPECIAL_CHARS.includes(c) || false);
    assert.ok(ok, `char outside full pool in ${pw}`);
  }
  assert.ok(sawZero, 'expected some ambiguous character across 500 draws');
});

test('allowRepeats=true permits adjacent repeats', () => {
  let sawRepeat = false;
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword({ length: 16, lowercase: false, uppercase: false, excludeAmbiguous: false, allowRepeats: true });
    if (hasAdjacentRepeat(pw)) sawRepeat = true;
  }
  assert.ok(sawRepeat, 'expected adjacent repeats across 200 draws');
});

test('length bounds are enforced', () => {
  assert.throws(() => generatePassword({ length: 3 }), /length/);
  assert.throws(() => generatePassword({ length: 129 }), /length/);
  assert.equal(generatePassword({ length: 4 }).length, 4);
  assert.equal(generatePassword({ length: 128 }).length, 128);
});

test('impossible configurations throw', () => {
  assert.throws(() => generatePassword({ symbols: true, specialChars: '' }), /empty/);
  assert.throws(() => generatePassword({ lowercase: false, uppercase: false, digits: false, symbols: false }), /class/);
  assert.throws(() => generatePassword({ symbols: true, specialChars: '0', excludeAmbiguous: true }), /usable/);
});

test('sanitizeSpecialChars dedupes and drops control chars', () => {
  assert.equal(sanitizeSpecialChars('a!a!\x00\x1fb'), 'a!b');
  assert.equal(sanitizeSpecialChars('!!##'), '!#');
});

test('passphrase format, separator, date and uniqueness', () => {
  const plain = generatePassphrase({ words: 4, prependDate: false });
  assert.doesNotMatch(plain, /^\d{8}\./);
  assert.match(plain, /^[A-Z][a-z]+([A-Z][a-z]+){3}$/);

  const dashed = generatePassphrase({ words: 5, separator: '-', prependDate: false });
  assert.equal(dashed.split('-').length, 5);

  const dated = generatePassphrase({ words: 4 });
  assert.match(dated, /^\d{8}\.[A-Z][a-z]+/);

  const words = plain.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
  assert.equal(new Set(words).size, words.length, 'words must be unique');

  assert.throws(() => generatePassphrase({ words: 3 }), /less than 4/);
});

test('entropy estimates are sane', () => {
  const e = entropyBits({ symbols: true });
  assert.ok(e > 120 && e < 130, `unexpected entropy ${e}`);
  const pe = passphraseEntropyBits({ words: 4 });
  assert.ok(pe >= 47 && pe <= 49, `unexpected passphrase entropy ${pe}`);
});
