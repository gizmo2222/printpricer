import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { el } from './helpers/env.js';
import { resetApp, setPrinters, enterCloudMode } from './helpers/reset.js';
import { settings, filaments, addons } from '../printpricer/js/state.js';
import { recalc } from '../printpricer/js/calc.js';
import {
  checkProductSize, computeProductTotals, computeProductBreakdown,
} from '../printpricer/js/products.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

beforeEach(() => {
  resetApp();
  mock.method(console, 'error', () => {}); // error toasts also log
});

describe('computeProductTotals', () => {
  it('sums filament grams, filament cost and BOM', () => {
    const t = computeProductTotals({
      filaments: [{ grams: '200', costPerKg: '25' }, { grams: '50', costPerKg: '' }],
      bom: [{ qty: '2', unitCost: '1.5' }, { qty: '', unitCost: '9' }],
    });
    assert.deepEqual(t, { filGrams: 250, filCost: 5, bomCost: 3, bomCount: 2 });
  });

  it('copes with a product that has no filaments or BOM', () => {
    assert.deepEqual(computeProductTotals({}), { filGrams: 0, filCost: 0, bomCost: 0, bomCount: 0 });
  });

  it('counts BOM rows even when they cost nothing', () => {
    assert.equal(computeProductTotals({ bom: [{}, {}] }).bomCount, 2);
  });
});

describe('computeProductBreakdown', () => {
  const product = {
    printerId: 3, hours: 2.5,
    filaments: [{ grams: '120', costPerKg: '25' }],
    laborMinutes: 20, packagingCost: '1.25', shippingCost: '4',
    bom: [{ qty: '3', unitCost: '0.2' }],
    sellPrice: '30',
  };

  beforeEach(() => {
    setPrinters([{ id: 3, name: 'X1C', watts: '150', hourlyRate: '1.2' }]);
    Object.assign(settings, { kwh: '0.3', laborRate: '30', failurePct: '10', marginPct: '40', marketplacePreset: 'etsy' });
  });

  it('works out every line', () => {
    const b = computeProductBreakdown(product);
    close(b.filCost, 3);
    close(b.electricity, 0.15 * 2.5 * 0.3);
    close(b.timeCost, 3);
    close(b.laborCost, 10);
    close(b.packagingCost, 1.25);
    close(b.bomCost, 0.6);
    const subtotal = 3 + 0.1125 + 3 + 10 + 1.25 + 0.6;
    close(b.subtotal, subtotal);
    close(b.failureAmt, subtotal * 0.1);
    close(b.marginAmt, subtotal * 1.1 * 0.4);
    close(b.total, subtotal * 1.1 * 1.4 + 4);
    close(b.feeAmt, 0.2 + b.total * 0.095 + 0.25);
    close(b.net, b.total - b.feeAmt);
    close(b.targetDelta, 30 - b.total);
    assert.equal(b.printer.name, 'X1C');
  });

  it('matches recalc() for the same inputs', () => {
    // Load the same product into the Estimate state and compare.
    setPrinters([{ id: 3, name: 'X1C', watts: '150', hourlyRate: '1.2' }], 3);
    el('time-h').value = '2';
    el('time-m').value = '30';
    filaments.push(...product.filaments);
    Object.assign(addons, {
      laborMinutes: '20', packagingCost: '1.25', shippingCost: '4',
      bom: product.bom, sellPrice: '30',
    });
    const r = recalc();
    const b = computeProductBreakdown(product);
    for (const k of ['electricity', 'timeCost', 'laborCost', 'subtotal', 'failureAmt', 'marginAmt', 'total', 'feeAmt', 'net']) {
      close(b[k], r[k]);
    }
  });

  it('matches the printer id as a string or a number', () => {
    assert.equal(computeProductBreakdown({ ...product, printerId: '3' }).printer.name, 'X1C');
  });

  it('falls back to no power or machine cost when the printer is gone', () => {
    const b = computeProductBreakdown({ ...product, printerId: 99 });
    assert.equal(b.printer, undefined);
    assert.equal(b.electricity, 0);
    assert.equal(b.timeCost, 0);
  });

  it('labels the custom marketplace preset', () => {
    Object.assign(settings, { marketplacePreset: 'custom', marketplaceCustomTxnPct: '10' });
    const b = computeProductBreakdown(product);
    assert.equal(b.preset.label, 'Custom');
    close(b.feeAmt, b.total * 0.1);
  });

  it('has no target delta without a target price', () => {
    assert.equal(computeProductBreakdown({ ...product, sellPrice: '' }).targetDelta, null);
  });

  it('is all zeros for an empty product', () => {
    Object.assign(settings, { marketplacePreset: 'none' });
    const b = computeProductBreakdown({});
    assert.equal(b.total, 0);
    assert.equal(b.net, 0);
    assert.equal(b.targetDelta, null);
  });
});

describe('checkProductSize', () => {
  const ofSize = (kb) => ({ photo: 'x'.repeat(kb * 1024) });

  it('accepts a small product without a warning', () => {
    assert.equal(checkProductSize({ name: 'Vase' }), true);
    assert.equal(el('toast').textContent, '');
  });

  it('warns above 700 KB but still saves locally', () => {
    assert.equal(checkProductSize(ofSize(800)), true);
    assert.match(el('toast').textContent, /^Product is 800KB — getting large/);
    assert.ok(el('toast').classList.contains('error'));
  });

  it('allows above 950 KB when not signed in', () => {
    assert.equal(checkProductSize(ofSize(1000)), true);
  });

  it('refuses above 950 KB in cloud mode', () => {
    enterCloudMode();
    assert.equal(checkProductSize(ofSize(1000)), false);
    assert.match(el('toast').textContent, /too large to sync/);
  });

  it('warns about the cloud limit between 700 and 950 KB in cloud mode', () => {
    enterCloudMode();
    assert.equal(checkProductSize(ofSize(800)), true);
    assert.match(el('toast').textContent, /close to the 1MB cloud limit/);
  });

  it('measures UTF-8 bytes, not characters', () => {
    // 'é' is 2 bytes: 400K characters is ~800 KB.
    assert.equal(checkProductSize({ notes: 'é'.repeat(400 * 1024) }), true);
    assert.match(el('toast').textContent, /^Product is 800KB/);
  });
});
