import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetEnv } from './helpers/env.js';
import {
  SETTINGS_KEY, LOW_STOCK_THRESHOLD, MARKETPLACE_PRESETS, defaultSettings,
  MATERIALS, PRINTER_PRESETS, CLOUD_ENABLED, state, filaments, addons, isInCloudMode,
} from '../printpricer/js/state.js';

// Each import with a new query string is a fresh module instance, so
// loadSettings() runs again against whatever localStorage holds now.
let n = 0;
async function freshSettings() {
  return (await import(`../printpricer/js/state.js?case=${++n}`)).settings;
}

describe('state defaults', () => {
  it('starts every numeric setting blank and the marketplace at none', () => {
    assert.deepEqual(defaultSettings, {
      filamentCost: '', kwh: '', failurePct: '', marginPct: '',
      estDensity: '', estFillPct: '', laborRate: '',
      marketplacePreset: 'none',
      marketplaceCustomListing: '', marketplaceCustomTxnPct: '',
      marketplaceCustomPaymentPct: '', marketplaceCustomPaymentFlat: '',
      businessName: '', businessEmail: '', businessNotes: '',
    });
  });

  it('has the documented marketplace fee presets', () => {
    const fees = Object.fromEntries(Object.entries(MARKETPLACE_PRESETS)
      .map(([k, p]) => [k, [p.listingFee, p.txnPct, p.paymentPct, p.paymentFlat]]));
    assert.deepEqual(fees, {
      none: [0, 0, 0, 0],
      etsy: [0.20, 6.5, 3, 0.25],
      ebay: [0, 13.25, 0, 0.30],
      amazon: [0, 15, 0, 0],
      shopify: [0, 0, 2.9, 0.30],
      custom: [0, 0, 0, 0],
    });
    for (const p of Object.values(MARKETPLACE_PRESETS)) assert.equal(typeof p.label, 'string');
  });

  it('has materials, printer presets and the low-stock threshold', () => {
    assert.equal(LOW_STOCK_THRESHOLD, 50);
    assert.equal(MATERIALS.length, 13);
    assert.ok(MATERIALS.includes('PLA') && MATERIALS.at(-1) === 'Other');
    assert.equal(PRINTER_PRESETS.length, 6);
    for (const g of PRINTER_PRESETS) {
      for (const p of g.items) assert.ok(Number.isFinite(p.watts) && p.watts >= 0, p.name);
    }
  });

  it('starts with empty runtime state', () => {
    assert.equal(state.user, null);
    assert.equal(state.groupId, null);
    assert.deepEqual(state.pending, { spools: 0, history: 0, printers: 0, products: 0, settings: 0 });
    assert.ok(Array.isArray(filaments));
    assert.deepEqual(Object.keys(addons).sort(),
      ['bom', 'laborMinutes', 'notes', 'packagingCost', 'photos', 'sellPrice', 'shippingCost']);
  });
});

describe('loadSettings', () => {
  beforeEach(resetEnv);

  it('uses the defaults when nothing is stored', async () => {
    assert.deepEqual(await freshSettings(), defaultSettings);
  });

  it('merges stored values over the defaults', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ kwh: '0.15', marketplacePreset: 'etsy', extra: 1 }));
    const s = await freshSettings();
    assert.equal(s.kwh, '0.15');
    assert.equal(s.marketplacePreset, 'etsy');
    assert.equal(s.marginPct, '');
    assert.equal(s.extra, 1);
  });

  it('falls back to the defaults on corrupt JSON', async () => {
    localStorage.setItem(SETTINGS_KEY, '{not json');
    assert.deepEqual(await freshSettings(), defaultSettings);
  });

  it('does not share the defaults object', async () => {
    const s = await freshSettings();
    s.kwh = '9';
    assert.equal(defaultSettings.kwh, '');
  });
});

describe('isInCloudMode', () => {
  beforeEach(() => { state.user = null; state.groupId = null; });

  it('needs a signed-in, non-anonymous user with a group', () => {
    assert.equal(CLOUD_ENABLED, true);
    assert.ok(!isInCloudMode());
    state.user = { uid: 'u', isAnonymous: true };
    state.groupId = 'g';
    assert.ok(!isInCloudMode());
    state.user = { uid: 'u', isAnonymous: false };
    assert.ok(isInCloudMode());
    state.groupId = null;
    assert.ok(!isInCloudMode());
  });
});
