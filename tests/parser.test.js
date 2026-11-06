import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetApp, setPrinters } from './helpers/reset.js';
import { settings } from '../printpricer/js/state.js';
import { parseGcode, parse3mf } from '../printpricer/js/parser.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const gcode = (name) => fixture(name).toString('utf8');
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
// Compare only name + grams; costPerKg is checked separately.
const rows = (filaments) => filaments.map(({ name, grams }) => ({ name, grams }));

beforeEach(resetApp);

describe('parseGcode', () => {
  it('reads PrusaSlicer time, per-extruder grams and types', () => {
    const r = parseGcode(gcode('prusa.gcode'));
    close(r.hours, 1 + 23 / 60 + 45 / 3600);
    assert.deepEqual(rows(r.filaments), [
      { name: 'PLA', grams: '12.34' },
      { name: 'PETG', grams: '5.60' },
    ]);
  });

  it('fills costPerKg from settings, or leaves it blank', () => {
    assert.equal(parseGcode(gcode('prusa.gcode')).filaments[0].costPerKg, '');
    settings.filamentCost = '22';
    assert.equal(parseGcode(gcode('prusa.gcode')).filaments[0].costPerKg, '22');
  });

  it('reads OrcaSlicer files with days in the time', () => {
    const r = parseGcode(gcode('orca.gcode'));
    close(r.hours, 26 + 3 / 60 + 4 / 3600);
    assert.deepEqual(rows(r.filaments), [{ name: 'PETG', grams: '250.50' }]);
  });

  it('reads "total estimated time" (Bambu style)', () => {
    const r = parseGcode(gcode('total-estimated-time.gcode'));
    close(r.hours, 43 / 60 + 52 / 3600);
    assert.deepEqual(rows(r.filaments), [{ name: 'PLA', grams: '3.36' }]);
  });

  it('reads Cura ;TIME: seconds', () => {
    close(parseGcode(gcode('cura.gcode')).hours, 5025 / 3600);
  });

  it('reads Cura filament usage', { todo: 'BUG: README promises Cura filament data, but ";Filament used: 1.23456m" is ignored (no grams, no metres)' }, () => {
    assert.ok(parseGcode(gcode('cura.gcode')).filaments.length > 0);
  });

  it('gives the same result for CRLF line endings', () => {
    const lf = parseGcode(gcode('prusa.gcode'));
    const crlf = parseGcode(gcode('prusa.gcode').replace(/\n/g, '\r\n'));
    assert.deepEqual(crlf, lf);
  });

  it('keeps names aligned with extruders when one weight is zero', { todo: 'BUG: zero weights are filtered before names are paired, so extruder 2 (PETG, 7.25 g) is labelled PLA' }, () => {
    const r = parseGcode(gcode('zero-weight.gcode'));
    assert.deepEqual(rows(r.filaments), [{ name: 'PETG', grams: '7.25' }]);
  });

  it('drops zero weights (current behaviour)', () => {
    const r = parseGcode(gcode('zero-weight.gcode'));
    assert.equal(r.filaments.length, 1);
    assert.equal(r.filaments[0].grams, '7.25');
    close(r.hours, 0.75);
  });

  it('survives malformed values without throwing', () => {
    const r = parseGcode(gcode('malformed.gcode'));
    assert.equal(r.hours, 0);
    assert.deepEqual(r.filaments, []);
  });

  it('reads what it can from a truncated file', () => {
    const r = parseGcode(gcode('truncated.gcode'));
    close(r.hours, 1); // "1h 2" — the dangling "2" has no unit
    assert.deepEqual(rows(r.filaments), [{ name: '', grams: '12.30' }]);
  });

  it('returns zeros for an empty file', () => {
    assert.deepEqual(parseGcode(''), { hours: 0, filaments: [] });
    assert.deepEqual(parseGcode(gcode('empty.gcode')), { hours: 0, filaments: [] });
  });

  it('finds metadata in the last 64 KB of a large file', () => {
    const meta = gcode('prusa.gcode');
    const big = 'G1 X0 Y0\n'.repeat(20000) + meta;
    assert.ok(big.length > 64 * 1024 + 16 * 1024);
    assert.deepEqual(parseGcode(big), parseGcode(meta));
  });

  it('does not look in the middle of a large file (documented limit)', () => {
    const pad = 'G1 X0 Y0\n'.repeat(10000); // ~90 KB each side
    const r = parseGcode(pad + gcode('prusa.gcode') + pad);
    assert.deepEqual(r, { hours: 0, filaments: [] });
  });
});

describe('parse3mf: sliced files', () => {
  it('picks the heaviest plate from slice_info.config', async () => {
    const r = await parse3mf(fixture('sliced-multiplate.3mf'));
    close(r.hours, 2);
    // White (#FFFFFFFF) is dropped from the name; the 0 g TPU row is skipped.
    assert.deepEqual(rows(r.filaments), [
      { name: 'PETG', grams: '20.00' },
      { name: 'PLA #00FF00FF', grams: '5.00' },
    ]);
    assert.equal(r.estimated, undefined);
  });

  it('reads Bambu plate_N.json when there is no slice_info', async () => {
    const r = await parse3mf(fixture('plate-json.3mf'));
    close(r.hours, 1.5);
    assert.deepEqual(rows(r.filaments), [{ name: 'PETG #FFFFFF', grams: '12.50' }]);
  });

  it('rejects a plate JSON it cannot parse with nothing else to read', async () => {
    await assert.rejects(parse3mf(fixture('plate-json-bad.3mf')), /No print data in 3MF\. 1 files found\./);
  });

  it('reads G-code embedded in a .gcode.3mf', async () => {
    const r = await parse3mf(fixture('embedded-gcode.3mf'));
    assert.deepEqual(r, parseGcode(gcode('prusa.gcode')));
  });

  it('takes PrusaSlicer project time from the config and grams from geometry', async () => {
    const r = await parse3mf(fixture('prusa-project.3mf'));
    close(r.hours, 1.5);
    assert.equal(r.estimated, true);
    assert.deepEqual(rows(r.filaments), [{ name: 'Estimated · adjust if needed', grams: '0.37' }]);
  });
});

describe('parse3mf: geometry estimator', () => {
  it('estimates a 1 cm³ cube with default density, fill and speed', async () => {
    const r = await parse3mf(fixture('cube-model-only.3mf'));
    assert.equal(r.estimated, true);
    close(r.meshVolumeCm3, 1);
    // 1 cm³ × 1.24 g/cm³ × 30 % = 0.372 g; 18 g/h.
    assert.deepEqual(rows(r.filaments), [{ name: 'Estimated · adjust if needed', grams: '0.37' }]);
    close(r.hours, 0.372 / 18);
  });

  it('uses the density, fill and printer speed from settings', async () => {
    settings.estDensity = '2';
    settings.estFillPct = '50';
    setPrinters([{ id: 1, name: 'P', gramsPerHour: '10', swapPct: '' }]);
    const r = await parse3mf(fixture('cube-model-only.3mf'));
    assert.equal(r.filaments[0].grams, '1.00');
    close(r.hours, 0.1);
  });

  it('follows components into 3D/Objects/*.model', async () => {
    const r = await parse3mf(fixture('cube-components.3mf'));
    close(r.meshVolumeCm3, 1);
  });

  it('splits grams by paint colour and adds colour-swap time', async () => {
    const r = await parse3mf(fixture('two-color.3mf'));
    assert.deepEqual(rows(r.filaments), [
      { name: 'Est. PLA #FF0000FF', grams: '0.25' },
      { name: 'Est. filament 2 (paint 2)', grams: '0.12' },
    ]);
    close(r.hours, (0.372 / 18) * 1.25);
  });

  it('applies the build-item scale transform', { todo: 'BUG: <item transform> is ignored, so a 2x-scaled cube counts as 1 cm³ instead of 8' }, async () => {
    const r = await parse3mf(fixture('scaled-build.3mf'));
    close(r.meshVolumeCm3, 8);
  });

  it('counts each build item (copies on the plate)', { todo: 'BUG: objects are summed once from resources, so two placed copies count as 1 cm³ instead of 2' }, async () => {
    const r = await parse3mf(fixture('two-copies.3mf'));
    close(r.meshVolumeCm3, 2);
  });

  it('handles a triangle with an out-of-range vertex index', { todo: 'BUG: throws a raw TypeError ("Cannot read properties of undefined") instead of skipping the triangle or giving a clear error' }, async () => {
    const r = await parse3mf(fixture('bad-vertex-index.3mf'));
    assert.ok(r.meshVolumeCm3 > 0);
  });
});

describe('parse3mf: bad input', () => {
  it('rejects a truncated model file as model-only', async () => {
    await assert.rejects(parse3mf(fixture('truncated-model.3mf')), /only the model \+ previews/);
  });

  it('rejects a model with no mesh as model-only', async () => {
    await assert.rejects(parse3mf(fixture('previews-only.3mf')), /only the model \+ previews/);
  });

  it('rejects a project with no usable data and counts the files', async () => {
    await assert.rejects(parse3mf(fixture('no-print-data.3mf')), /No print data in 3MF\. 2 files found\./);
  });

  it('rejects a file that is not a zip', async () => {
    await assert.rejects(parse3mf(fixture('not-a-zip.3mf')));
  });

  it('rejects a zip cut in half', async () => {
    await assert.rejects(parse3mf(fixture('truncated-zip.3mf')));
  });

  it('says so when the zip library is missing', async () => {
    const saved = globalThis.JSZip;
    delete globalThis.JSZip;
    try {
      await assert.rejects(parse3mf(fixture('cube-model-only.3mf')), /Zip library not loaded/);
    } finally {
      globalThis.JSZip = saved;
    }
  });
});
