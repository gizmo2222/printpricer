import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { el } from './helpers/env.js';
import { resetApp, setPrinters } from './helpers/reset.js';
import { settings, filaments, addons } from '../printpricer/js/state.js';
import { recalc } from '../printpricer/js/calc.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const text = (id) => el(id).textContent;

function setTime(h, m) {
  el('time-h').value = h;
  el('time-m').value = m;
}

const ZERO = {
  hours: 0, filamentCost: 0, electricity: 0, timeCost: 0, laborCost: 0,
  packagingCost: 0, shippingCost: 0, bomCost: 0, subtotal: 0, failureAmt: 0,
  marginAmt: 0, total: 0, feeAmt: 0, net: 0,
};

beforeEach(resetApp);

describe('recalc: empty estimate', () => {
  it('is all zeros with nothing entered', () => {
    assert.deepEqual(recalc(), ZERO);
    assert.equal(text('bd-total'), '$0.00');
    assert.equal(text('bd-fees'), '−$0.00');
    assert.equal(el('print-link-row').style.display, 'none');
    assert.equal(el('net-after-fees').style.display, 'none');
  });

  it('treats blank and non-numeric inputs as 0', () => {
    setTime('abc', '');
    filaments.push({ name: 'x', grams: 'lots', costPerKg: '' });
    addons.laborMinutes = 'ten';
    settings.kwh = '';
    assert.deepEqual(recalc(), ZERO);
  });

  it('hides the optional rows when they are zero', () => {
    recalc();
    for (const row of ['bd-labor-row', 'bd-packaging-row', 'bd-bom-row', 'bd-shipping-row']) {
      assert.ok(el(row).hasAttribute('hidden'), row);
    }
  });
});

describe('recalc: each price input', () => {
  it('time: hours plus minutes', () => {
    setTime('2', '30');
    close(recalc().hours, 2.5);
  });

  it('filament: grams / 1000 × cost per kg, summed over rows', () => {
    filaments.push({ grams: '250', costPerKg: '20' }, { grams: '100', costPerKg: '30' });
    const r = recalc();
    close(r.filamentCost, 5 + 3);
    assert.equal(text('bd-filament'), '$8.00');
  });

  it('electricity: printer watts × hours × price per kWh', () => {
    setPrinters([{ id: 1, name: 'P', watts: '200', hourlyRate: '' }]);
    settings.kwh = '0.25';
    setTime('4', '0');
    close(recalc().electricity, 0.2 * 4 * 0.25);
    assert.equal(text('bd-power'), '$0.20');
  });

  it('machine time: printer hourly rate × hours', () => {
    setPrinters([{ id: 1, name: 'P', watts: '', hourlyRate: '1.5' }]);
    setTime('3', '0');
    close(recalc().timeCost, 4.5);
  });

  it('no active printer means no power or machine cost', () => {
    setPrinters([{ id: 1, name: 'P', watts: '200', hourlyRate: '2' }], null);
    settings.kwh = '1';
    setTime('1', '0');
    const r = recalc();
    assert.equal(r.electricity, 0);
    assert.equal(r.timeCost, 0);
  });

  it('labor: minutes / 60 × labor rate', () => {
    addons.laborMinutes = '15';
    settings.laborRate = '40';
    close(recalc().laborCost, 10);
    assert.ok(!el('bd-labor-row').hasAttribute('hidden'));
  });

  it('labor needs both minutes and a rate', () => {
    addons.laborMinutes = '15';
    assert.equal(recalc().laborCost, 0);
  });

  it('packaging and BOM add to the subtotal', () => {
    addons.packagingCost = '0.75';
    addons.bom = [{ name: 'magnet', qty: '4', unitCost: '0.10' }, { name: 'screw', qty: '', unitCost: '5' }];
    const r = recalc();
    close(r.packagingCost, 0.75);
    close(r.bomCost, 0.4);
    close(r.subtotal, 1.15);
  });

  it('failure markup applies to the subtotal, margin to subtotal + failure', () => {
    filaments.push({ grams: '1000', costPerKg: '10' }); // $10
    settings.failurePct = '10';
    settings.marginPct = '50';
    const r = recalc();
    close(r.failureAmt, 1);
    close(r.marginAmt, 5.5);
    close(r.total, 16.5);
    assert.equal(el('bd-failure-label').textContent, 'Failure markup (10%)');
    assert.equal(el('bd-margin-label').textContent, 'Profit margin (50%)');
  });

  it('shipping is passed through after markup', () => {
    filaments.push({ grams: '1000', costPerKg: '10' });
    settings.marginPct = '100';
    addons.shippingCost = '5';
    const r = recalc();
    close(r.subtotal, 10);
    close(r.total, 25);
    assert.ok(!el('bd-shipping-row').hasAttribute('hidden'));
  });
});

describe('recalc: marketplace fees', () => {
  beforeEach(() => filaments.push({ grams: '1000', costPerKg: '100' })); // total $100

  it('none: no fees, panel hidden', () => {
    const r = recalc();
    assert.equal(r.feeAmt, 0);
    assert.equal(r.net, 100);
    assert.equal(el('net-after-fees').style.display, 'none');
  });

  for (const [key, fee] of [['etsy', 0.20 + 6.5 + 3 + 0.25], ['ebay', 13.25 + 0.30], ['amazon', 15], ['shopify', 2.9 + 0.30]]) {
    it(`${key}: listing + transaction % + payment % + flat`, () => {
      settings.marketplacePreset = key;
      const r = recalc();
      close(r.feeAmt, fee);
      close(r.net, 100 - fee);
      assert.equal(el('net-after-fees').style.display, '');
      assert.match(el('bd-fees-label').textContent, /^\S.* fees$/);
      assert.doesNotMatch(el('bd-fees-label').textContent, /undefined/);
    });
  }

  it('custom: uses the custom fee settings', () => {
    Object.assign(settings, {
      marketplacePreset: 'custom', marketplaceCustomListing: '1',
      marketplaceCustomTxnPct: '5', marketplaceCustomPaymentPct: '2', marketplaceCustomPaymentFlat: '0.5',
    });
    const r = recalc();
    close(r.feeAmt, 1 + 5 + 2 + 0.5);
    assert.equal(text('bd-fees'), '−$8.50');
  });

  it('custom: labels the fee row', { todo: 'BUG: the custom preset object has no label, so the row reads "undefined fees"' }, () => {
    settings.marketplacePreset = 'custom';
    recalc();
    assert.equal(el('bd-fees-label').textContent, 'Custom fees');
  });

  it('an unknown preset key falls back to no fees', () => {
    settings.marketplacePreset = 'craigslist';
    const r = recalc();
    assert.equal(r.feeAmt, 0);
    assert.equal(el('net-after-fees').style.display, 'none');
  });

  it('flat fees still apply to a $0 estimate', () => {
    filaments.length = 0;
    settings.marketplacePreset = 'etsy';
    const r = recalc();
    close(r.feeAmt, 0.45);
    close(r.net, -0.45);
  });
});

describe('recalc: target sell price', () => {
  beforeEach(() => filaments.push({ grams: '1000', costPerKg: '10' })); // $10

  it('shows how far the target is over the estimate', () => {
    addons.sellPrice = '12.5';
    recalc();
    assert.equal(el('target-delta').textContent, 'Target $12.50 · +$2.50');
    assert.ok(el('target-compare').classList.contains('over'));
    assert.ok(!el('target-compare').classList.contains('under'));
    assert.equal(el('target-compare').style.display, '');
  });

  it('shows how far the target is under the estimate', () => {
    addons.sellPrice = '8';
    recalc();
    assert.equal(el('target-delta').textContent, 'Target $8.00 · −$2.00');
    assert.ok(el('target-compare').classList.contains('under'));
  });

  it('counts an exact match as over (+$0.00)', () => {
    addons.sellPrice = '10';
    recalc();
    assert.equal(el('target-delta').textContent, 'Target $10.00 · +$0.00');
    assert.ok(el('target-compare').classList.contains('over'));
  });

  it('hides the comparison without a target', () => {
    recalc();
    assert.equal(el('target-compare').style.display, 'none');
  });
});

describe('recalc: rounding and large values', () => {
  it('keeps full precision internally and rounds only for display', () => {
    filaments.push({ grams: '1', costPerKg: '3.333' });
    const r = recalc();
    close(r.filamentCost, 0.003333);
    assert.equal(text('bd-filament'), '$0.00');
    assert.equal(text('bd-total'), '$0.00');
    assert.equal(el('print-link-row').style.display, 'flex'); // total > 0 even if it shows $0.00
  });

  it('rows that each round down can add up to a visible total', () => {
    for (let i = 0; i < 3; i++) filaments.push({ grams: '1', costPerKg: '2' }); // $0.002 each
    addons.packagingCost = '0.004';
    const r = recalc();
    close(r.total, 0.01);
    assert.equal(text('bd-filament'), '$0.01');
    assert.equal(text('bd-total'), '$0.01');
  });

  it('handles very large inputs without overflow', () => {
    filaments.push({ grams: '1e9', costPerKg: '1e6' }); // $1e12
    settings.marginPct = '100';
    const r = recalc();
    close(r.total, 2e12, 1);
    assert.equal(text('bd-total'), '$2000000000000.00');
  });

  it('treats an overflowing input as 0, not Infinity', () => {
    filaments.push({ grams: '1e309', costPerKg: '20' });
    const r = recalc();
    assert.equal(r.filamentCost, 0);
    assert.ok(Number.isFinite(r.total));
  });

  it('shows the print link and sticky total once the total is positive', () => {
    filaments.push({ grams: '50', costPerKg: '20' });
    recalc();
    assert.equal(el('print-link-row').style.display, 'flex');
    assert.equal(text('sticky-total-value'), '$1.00');
  });
});

describe('recalc: header callouts', () => {
  it('names the active printer, escaped and upper-cased', () => {
    setPrinters([{ id: 7, name: 'Mk4 <b>', watts: '', hourlyRate: '' }]);
    recalc();
    assert.equal(el('block-detail-print').innerHTML, 'MK4 &LT;B&GT;<span class="id">A</span>');
  });

  it('summarises filament rows and print time', () => {
    filaments.push({ name: 'PLA', grams: '12.34', costPerKg: '' }, { name: '', grams: '', costPerKg: '' });
    setTime('1', '30');
    recalc();
    assert.equal(el('block-detail-filaments').innerHTML, '1 · 12.3 G<span class="id">B</span>');
    assert.equal(el('block-detail-breakdown').innerHTML, '1H30M<span class="id">E</span>');
  });
});
