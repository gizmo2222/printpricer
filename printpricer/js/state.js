// Constants, defaults, and shared mutable state.

export const SETTINGS_KEY        = 'printpricer:settings';
export const HISTORY_KEY         = 'printpricer:history';
export const SPOOLS_KEY          = 'printpricer:spools';
export const PRINTERS_KEY        = 'printpricer:printers';
export const PRODUCTS_KEY        = 'printpricer:products';
export const ACTIVE_PRINTER_KEY  = 'printpricer:activePrinterId';
export const LOW_STOCK_THRESHOLD = 50;

// Marketplace fee presets — listing fee + transaction % + payment processing.
// Numbers are typical published rates; user can override via the 'custom' preset.
export const MARKETPLACE_PRESETS = {
  none:    { label: 'None / direct sale',     listingFee: 0,    txnPct: 0,     paymentPct: 0,    paymentFlat: 0 },
  etsy:    { label: 'Etsy',                   listingFee: 0.20, txnPct: 6.5,   paymentPct: 3,    paymentFlat: 0.25 },
  ebay:    { label: 'eBay (managed payments)', listingFee: 0,   txnPct: 13.25, paymentPct: 0,    paymentFlat: 0.30 },
  amazon:  { label: 'Amazon',                 listingFee: 0,    txnPct: 15,    paymentPct: 0,    paymentFlat: 0    },
  shopify: { label: 'Shopify (payment only)', listingFee: 0,    txnPct: 0,     paymentPct: 2.9,  paymentFlat: 0.30 },
  custom:  { label: 'Custom',                 listingFee: 0,    txnPct: 0,     paymentPct: 0,    paymentFlat: 0    },
};

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA25vkshbHUc4-W6H2BCtM-yJ1rz26Ru6Y",
  authDomain: "printpricer.firebaseapp.com",
  projectId: "printpricer",
  storageBucket: "printpricer.firebasestorage.app",
  messagingSenderId: "717925212582",
  appId: "1:717925212582:web:ff10dd876b4bc122c7ef67",
};
export const CLOUD_ENABLED = !!FIREBASE_CONFIG.apiKey;

export const defaultSettings = {
  filamentCost: '',
  kwh: '',
  failurePct: '',
  marginPct: '',
  estDensity: '',
  estFillPct: '',
  // Labor — the human time cost. Per-print labor minutes are entered on the
  // Estimate sheet; this rate is workspace-wide.
  laborRate: '',
  // Marketplace fee preset and (optional) custom-mode overrides.
  marketplacePreset: 'none',
  marketplaceCustomListing:    '',
  marketplaceCustomTxnPct:     '',
  marketplaceCustomPaymentPct: '',
  marketplaceCustomPaymentFlat: '',
  // Business info — appears in the printable customer quote.
  businessName: '',
  businessEmail: '',
  businessNotes: '',
};

// ---- Material list (used by spool form) ----
export const MATERIALS = [
  'PLA', 'PLA+', 'PLA-CF', 'Silk PLA', 'Wood PLA',
  'PETG', 'PETG-CF', 'ABS', 'ASA', 'TPU', 'PC', 'Nylon', 'Other'
];

// ---- Printer presets — average printing wattage (W) ----
export const PRINTER_PRESETS = [
  { group: 'Bambu Lab', items: [
    { name: 'X1 Carbon', watts: 150 },
    { name: 'X1E', watts: 180 },
    { name: 'P1S', watts: 120 },
    { name: 'P1P', watts: 100 },
    { name: 'A1', watts: 100 },
    { name: 'A1 Mini', watts: 60 },
    { name: 'H2D', watts: 200 },
  ]},
  { group: 'Prusa', items: [
    { name: 'MK4 / MK4S', watts: 80 },
    { name: 'MK3S+', watts: 120 },
    { name: 'Mini+', watts: 60 },
    { name: 'XL', watts: 150 },
    { name: 'Core One', watts: 120 },
  ]},
  { group: 'Creality', items: [
    { name: 'Ender 3 V2', watts: 120 },
    { name: 'Ender 3 S1 / Pro', watts: 140 },
    { name: 'K1 / K1C', watts: 150 },
    { name: 'K1 Max', watts: 200 },
    { name: 'K2 Plus', watts: 220 },
  ]},
  { group: 'Anycubic', items: [
    { name: 'Kobra 2 / 2 Pro', watts: 100 },
    { name: 'Kobra 3', watts: 120 },
  ]},
  { group: 'Elegoo', items: [
    { name: 'Neptune 4 / 4 Pro', watts: 100 },
    { name: 'Centauri Carbon', watts: 150 },
  ]},
  { group: 'Other', items: [
    { name: 'Voron 2.4', watts: 150 },
    { name: 'Voron Trident', watts: 130 },
    { name: 'Sovol SV06 / SV07', watts: 120 },
    { name: 'Custom / not listed', watts: 0 },
  ]},
];

// ---- Mutable runtime state ----

// Settings: a live object so modules can read it via property access. Mutate
// in place via Object.assign(settings, newValues) — never reassign.
export const settings = loadSettings();

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    return s ? { ...defaultSettings, ...s } : { ...defaultSettings };
  } catch {
    return { ...defaultSettings };
  }
}

// Cloud / auth / group state.
export const state = {
  user: null,
  groupId: null,
  groupDoc: null,
  members: [],
  unsubs: [],
  isApplyingRemote: false,
  // Generation counter — incremented on every group switch / sign-out so a
  // late-fired Firestore snapshot from a previous group can detect it's
  // stale and bail.
  syncGen: 0,
  // Per-collection "pending writes" counter, for the unsaved-indicator.
  pending: { spools: 0, history: 0, printers: 0, products: 0, settings: 0 },
};

export function isInCloudMode() {
  return CLOUD_ENABLED && state.user && !state.user.isAnonymous && state.groupId;
}

// Filament rows on the Estimate sheet — mutated in place by filaments.js.
export const filaments = [];

// Per-estimate add-ons. These are inputs on the Estimate sheet and are not
// persisted on their own — they get captured into the archive entry on stamp,
// and into the product record when "Save as Product" is clicked.
//
// `bom` is an array of { name, qty, unitCost } rows for hardware /
// consumables (screws, magnets, mailers, etc.). It contributes to subtotal
// like a separate cost line — failure markup and margin apply to it.
export const addons = {
  laborMinutes: '',
  packagingCost: '',
  shippingCost: '',
  bom: [],
  notes: '',
  sellPrice: '',
  // Optional product photo as a JPEG data URL (resized to ~800px on the
  // long edge). Saved with archive entries and product templates.
  photo: '',
};
