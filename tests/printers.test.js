import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { el } from './helpers/env.js';
import { resetApp, setPrinters } from './helpers/reset.js';
import { settings, PRINTERS_KEY, ACTIVE_PRINTER_KEY } from '../printpricer/js/state.js';
import { migrateLegacySinglePrinter, updateActivePrinterDisplay } from '../printpricer/js/printers.js';

const stored = () => JSON.parse(localStorage.getItem(PRINTERS_KEY) || 'null');

beforeEach(resetApp);

describe('migrateLegacySinglePrinter', () => {
  it('does nothing without legacy settings', () => {
    migrateLegacySinglePrinter();
    assert.equal(stored(), null);
    assert.equal(localStorage.getItem(ACTIVE_PRINTER_KEY), null);
  });

  it('turns the old single-printer settings into one active printer', () => {
    Object.assign(settings, { watts: '120', hourlyRate: '0.8', estGramsPerHour: '15', estSwapPct: '20', printerPreset: 'mk4' });
    migrateLegacySinglePrinter();
    const [p, ...rest] = stored();
    assert.equal(rest.length, 0);
    assert.deepEqual({ ...p, id: 0 }, {
      id: 0, name: 'My Printer', preset: 'mk4', watts: '120', hourlyRate: '0.8', gramsPerHour: '15', swapPct: '20',
    });
    assert.equal(typeof p.id, 'number');
    assert.equal(localStorage.getItem(ACTIVE_PRINTER_KEY), String(p.id));
  });

  it('migrates when only one legacy field is set, blanking the rest', () => {
    settings.watts = '90';
    migrateLegacySinglePrinter();
    const [p] = stored();
    assert.equal(p.watts, '90');
    assert.equal(p.hourlyRate, '');
    assert.equal(p.preset, '');
  });

  it('never runs once printers exist', () => {
    setPrinters([{ id: 1, name: 'Existing' }]);
    settings.watts = '120';
    migrateLegacySinglePrinter();
    assert.deepEqual(stored(), [{ id: 1, name: 'Existing' }]);
  });
});

describe('updateActivePrinterDisplay', () => {
  it('shows the active printer and its rates', () => {
    setPrinters([{ id: 1, name: 'Mk4', watts: '120', hourlyRate: '1', gramsPerHour: '15', swapPct: '' }]);
    updateActivePrinterDisplay();
    assert.equal(el('active-printer-display').textContent, 'Mk4');
    assert.equal(el('active-printer-meta').textContent, '120 W · $1.00/hr · 15 g/hr');
    assert.ok(!el('active-printer-display').classList.contains('empty'));
  });

  it('asks you to add a printer when there are none', () => {
    updateActivePrinterDisplay();
    assert.equal(el('active-printer-display').textContent, '— none selected —');
    assert.equal(el('active-printer-meta').textContent, 'Add a printer in layer 03 first.');
  });

  it('asks you to pick one when none is active', () => {
    setPrinters([{ id: 1, name: 'Mk4' }], null);
    updateActivePrinterDisplay();
    assert.equal(el('active-printer-meta').textContent, 'Pick a printer to use its rates.');
  });
});
