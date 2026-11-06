import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  num, fmt, escapeHtml, formatHours, parseTimeStr, rafDebounce,
  generateJoinCode, toCsv, resizeImageToDataUrl,
} from '../printpricer/js/utils.js';

describe('num', () => {
  it('parses numbers and numeric strings', () => {
    assert.equal(num(3), 3);
    assert.equal(num('2.5'), 2.5);
    assert.equal(num(' 7 '), 7);
    assert.equal(num('-4'), -4);
    assert.equal(num('1e3'), 1000);
  });

  it('returns 0 for missing or non-numeric input', () => {
    for (const v of ['', undefined, null, 'abc', NaN, {}, []]) assert.equal(num(v), 0, String(v));
  });

  it('returns 0 for values that overflow to Infinity', () => {
    assert.equal(num(Infinity), 0);
    assert.equal(num('1e309'), 0);
  });

  it('keeps very large finite values', () => {
    assert.equal(num('1e15'), 1e15);
    assert.equal(num(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  });

  it('stops at the first non-numeric character (parseFloat rules)', () => {
    assert.equal(num('12g'), 12);
    // A thousands separator ends the number: "1,500" is read as 1.
    assert.equal(num('1,500'), 1);
  });
});

describe('fmt', () => {
  it('formats as dollars with two decimals', () => {
    assert.equal(fmt(0), '$0.00');
    assert.equal(fmt(3), '$3.00');
    assert.equal(fmt(12.345678), '$12.35');
    assert.equal(fmt(0.004), '$0.00');
  });

  it('has no thousands separators', () => {
    assert.equal(fmt(1234567.891), '$1234567.89');
  });

  it('formats very large values without exponent notation up to 1e21', () => {
    assert.equal(fmt(1e15), '$1000000000000000.00');
  });

  it('rounds half-cent values up', () => {
    assert.equal(fmt(1.005), '$1.01');
    assert.equal(fmt(2.675), '$2.68');
    assert.equal(fmt(0.125), '$0.13');
    assert.equal(fmt(1e12), '$1000000000000.00');
  });

  it('puts the minus sign before the dollar sign', () => {
    assert.equal(fmt(-0.45), '-$0.45');
    assert.equal(fmt(-1234.5), '-$1234.50');
  });

  it('never shows a negative zero', () => {
    assert.equal(fmt(-0), '$0.00');
    assert.equal(fmt(-0.004), '$0.00');
  });

  it('leaves NaN and Infinity as before', () => {
    assert.equal(fmt(NaN), '$NaN');
    assert.equal(fmt(Infinity), '$Infinity');
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-special characters', () => {
    assert.equal(escapeHtml(`<a href="x">Tom & Jerry's</a>`),
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  });

  it('stringifies non-strings', () => {
    assert.equal(escapeHtml(42), '42');
    assert.equal(escapeHtml(null), 'null');
  });
});

describe('formatHours', () => {
  it('splits hours into h and m', () => {
    assert.equal(formatHours(0), '0h 0m');
    assert.equal(formatHours(1.5), '1h 30m');
    assert.equal(formatHours(2.25), '2h 15m');
    assert.equal(formatHours(100), '100h 0m');
  });

  it('rounds to the nearest minute', () => {
    assert.equal(formatHours(1 + 29.6 / 60), '1h 30m');
  });

  it('carries 60 minutes into the hour',() => {
    assert.equal(formatHours(1.9999), '2h 0m');
  });
});

describe('parseTimeStr', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

  it('reads d / h / m / s parts', () => {
    close(parseTimeStr('1h 23m 45s'), 1 + 23 / 60 + 45 / 3600);
    close(parseTimeStr('1d 2h 3m 4s'), 26 + 3 / 60 + 4 / 3600);
    close(parseTimeStr('45m'), 0.75);
    close(parseTimeStr('30s'), 30 / 3600);
    close(parseTimeStr('2H 5M'), 2 + 5 / 60);
  });

  it('reads h:mm:ss when there are no unit letters', () => {
    close(parseTimeStr('1:23:45'), 1 + 23 / 60 + 45 / 3600);
    close(parseTimeStr('0:05:00'), 5 / 60);
  });

  it('does not read "ms" as minutes', () => {
    assert.equal(parseTimeStr('500ms'), 0);
  });

  it('returns 0 for empty or unparseable input', () => {
    assert.equal(parseTimeStr(''), 0);
    assert.equal(parseTimeStr('soon'), 0);
  });
});

describe('rafDebounce', () => {
  it('runs once per frame with the first call\'s arguments', async () => {
    const calls = [];
    const fn = rafDebounce((...a) => calls.push(a));
    fn(1); fn(2); fn(3);
    assert.equal(calls.length, 0);
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(calls, [[1]]);
    fn(4);
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(calls, [[1], [4]]);
  });
});

describe('generateJoinCode', () => {
  it('makes XXXX-XXXX codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      assert.match(generateJoinCode(), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    }
  });

  it('never uses I, L, O, 0 or 1', () => {
    const all = Array.from({ length: 500 }, generateJoinCode).join('');
    assert.doesNotMatch(all, /[ILO01]/);
  });

  it('draws from crypto.getRandomValues, not Math.random', () => {
    const realRandom = Math.random;
    Math.random = () => { throw new Error('Math.random used'); };
    try { assert.match(generateJoinCode(), /^.{4}-.{4}$/); }
    finally { Math.random = realRandom; }
  });

  it('rarely repeats a code', () => {
    const codes = new Set(Array.from({ length: 2000 }, generateJoinCode));
    assert.equal(codes.size, 2000);
  });
});

describe('toCsv', () => {
  it('returns an empty string for no rows', () => {
    assert.equal(toCsv([]), '');
  });

  it('uses the union of keys in first-seen order as the header', () => {
    assert.equal(toCsv([{ a: 1, b: 2 }, { b: 3, c: 4 }]), 'a,b,c\n1,2,\n,3,4\n');
  });

  it('respects an explicit column list', () => {
    assert.equal(toCsv([{ a: 1, b: 2 }], ['b']), 'b\n2\n');
  });

  it('quotes commas, quotes and newlines', () => {
    assert.equal(toCsv([{ v: 'a,b' }, { v: 'say "hi"' }, { v: 'two\nlines' }]),
      'v\n"a,b"\n"say ""hi"""\n"two\nlines"\n');
  });

  it('writes null and undefined as empty cells, keeps 0 and false', () => {
    assert.equal(toCsv([{ a: null, b: undefined, c: 0, d: false }]), 'a,b,c,d\n,,0,false\n');
  });

  it('quotes carriage returns',() => {
    assert.equal(toCsv([{ v: 'a\rb' }]), 'v\n"a\rb"\n');
  });
});

describe('resizeImageToDataUrl (validation before any DOM work)', () => {
  it('rejects a missing file', async () => {
    await assert.rejects(resizeImageToDataUrl(null), /No file selected/);
  });

  it('rejects non-image types', async () => {
    await assert.rejects(resizeImageToDataUrl({ type: 'application/pdf', name: 'a.pdf' }), /a\.pdf is not an image file/);
    await assert.rejects(resizeImageToDataUrl({ type: '', name: 'x' }), /not an image file/);
  });

  it('rejects HEIC by type or by file name', async () => {
    await assert.rejects(resizeImageToDataUrl({ type: 'image/heic', name: 'a.jpg' }), /HEIC/);
    await assert.rejects(resizeImageToDataUrl({ type: 'image/HEIF', name: 'a' }), /HEIC/);
    await assert.rejects(resizeImageToDataUrl({ type: 'image/jpeg', name: 'IMG_1.HEIC' }), /HEIC/);
  });
});
