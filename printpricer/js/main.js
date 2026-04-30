// Entry point: wire everything up after the DOM is ready.

import { settings, filaments, addons } from './state.js?v=18';
import { saveSettings } from './storage.js?v=18';
import { initTabs, onPaneShow, initPickerOverlay, toast } from './ui.js?v=18';
import { recalc, loadSettingsToForm, initStickyTotal } from './calc.js?v=18';
import { renderFilaments, resetFilaments, initFilamentsUI } from './filaments.js?v=18';
import { renderSpools, initSpoolsUI } from './spools.js?v=18';
import { renderPrinters, updateActivePrinterDisplay, migrateLegacySinglePrinter, initPrintersUI } from './printers.js?v=18';
import { renderHistory, initArchive } from './archive.js?v=18';
import { renderProducts, initProductsUI } from './products.js?v=18';
import { initAuthUI, updateAccountUI, renderGroupSection } from './auth-ui.js?v=18';
import { startAuthListener } from './firebase.js?v=18';
import { parseGcode, parse3mf } from './parser.js?v=18';
import { formatHours } from './utils.js?v=18';
import { initOnboarding, maybeShowOnboarding } from './onboarding.js?v=18';
import { initHelp } from './help.js?v=18';

// ---- title-block date ----
(function setDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  document.getElementById('title-date').textContent = `${y}.${m}.${day}`;
})();

// ---- tabs ----
initTabs();
const hideStickyTotal = () => document.getElementById('sticky-total')?.classList.remove('show');
onPaneShow('history',  () => { renderHistory();   hideStickyTotal(); });
onPaneShow('spools',   () => { renderSpools();    hideStickyTotal(); });
onPaneShow('printers', () => { renderPrinters();  hideStickyTotal(); });
onPaneShow('products', () => { renderProducts();  hideStickyTotal(); });
onPaneShow('settings', hideStickyTotal);
onPaneShow('calc',     recalc);

// ---- picker overlay (esc / backdrop click / × close) ----
initPickerOverlay();

// ---- migration (legacy settings → first printer) before any printer UI ----
migrateLegacySinglePrinter();

// ---- file dropzone ----
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');

async function handleFile(file) {
  if (!file) return;
  const name = file.name.toLowerCase();
  try {
    let parsed;
    if (/\.(gcode|gco|g)$/.test(name)) {
      parsed = parseGcode(await file.text());
    } else if (name.endsWith('.3mf')) {
      parsed = await parse3mf(file);
    } else {
      throw new Error('Use a .gcode or .3mf file');
    }
    if (!parsed.hours && parsed.filaments.length === 0) {
      throw new Error('No time or filament data found in this file');
    }
    if (parsed.hours > 0) {
      const hrs = Math.floor(parsed.hours);
      const mins = Math.round((parsed.hours - hrs) * 60);
      document.getElementById('time-h').value = hrs;
      document.getElementById('time-m').value = mins;
    }
    if (parsed.filaments.length > 0) {
      filaments.length = 0;
      parsed.filaments.forEach(f => filaments.push({ ...f }));
      renderFilaments();
    }
    document.getElementById('print-name').value = file.name.replace(/\.[^.]+$/, '');
    recalc();
    if (parsed.estimated) {
      const vol = parsed.meshVolumeCm3 ? ` · ${parsed.meshVolumeCm3.toFixed(1)} cm³` : '';
      toast(`Estimated from geometry${vol} — review values`);
    } else {
      const parts = [];
      if (parsed.hours) parts.push(formatHours(parsed.hours));
      if (parsed.filaments.length) parts.push(`${parsed.filaments.length} filament${parsed.filaments.length > 1 ? 's' : ''}`);
      toast(`Loaded · ${parts.join(' · ')}`);
    }
  } catch (err) {
    toast(err.message || 'Could not parse file', true);
  }
}

fileInput.addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) handleFile(f);
  fileInput.value = '';
});
['dragenter', 'dragover'].forEach(ev => {
  dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('drag'); });
});
['dragleave', 'drop'].forEach(ev => {
  dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('drag'); });
});
dropzone.addEventListener('drop', e => {
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});

// ---- defaults form ----
document.getElementById('save-settings').addEventListener('click', () => {
  Object.assign(settings, {
    filamentCost: document.getElementById('s-filament-cost').value,
    kwh:          document.getElementById('s-kwh').value,
    laborRate:    document.getElementById('s-labor-rate').value,
    failurePct:   document.getElementById('s-failure').value,
    marginPct:    document.getElementById('s-margin').value,
    estDensity:   document.getElementById('s-est-density').value,
    estFillPct:   document.getElementById('s-est-fill').value,
    marketplacePreset:             document.getElementById('s-marketplace').value,
    marketplaceCustomListing:      document.getElementById('s-mp-listing').value,
    marketplaceCustomTxnPct:       document.getElementById('s-mp-txn').value,
    marketplaceCustomPaymentPct:   document.getElementById('s-mp-pay-pct').value,
    marketplaceCustomPaymentFlat:  document.getElementById('s-mp-pay-flat').value,
    businessName:  document.getElementById('s-biz-name').value,
    businessEmail: document.getElementById('s-biz-email').value,
    businessNotes: document.getElementById('s-biz-notes').value,
  });
  saveSettings();
  recalc();
  toast('Settings committed');
});
document.getElementById('reset-settings').addEventListener('click', () => {
  if (!confirm('Reset all defaults to blank?')) return;
  Object.keys(settings).forEach(k => settings[k] = '');
  saveSettings();
  loadSettingsToForm();
  recalc();
  toast('Settings reset');
});

// ---- estimate sheet (time fields → recalc) ----
document.getElementById('time-h').addEventListener('input', recalc);
document.getElementById('time-m').addEventListener('input', recalc);

// ---- estimate sheet add-ons (labor, packaging, shipping) ----
document.getElementById('addon-labor').addEventListener('input', e => {
  addons.laborMinutes = e.target.value; recalc();
});
document.getElementById('addon-packaging').addEventListener('input', e => {
  addons.packagingCost = e.target.value; recalc();
});
document.getElementById('addon-shipping').addEventListener('input', e => {
  addons.shippingCost = e.target.value; recalc();
});

// ---- marketplace dropdown: toggle custom panel ----
document.getElementById('s-marketplace').addEventListener('change', e => {
  const custom = document.getElementById('marketplace-custom');
  if (custom) custom.style.display = e.target.value === 'custom' ? '' : 'none';
});

// ---- auth + group UI ----
initAuthUI();
updateAccountUI();
renderGroupSection();

// ---- spools / printers / filaments / archive / products ----
initSpoolsUI();
initPrintersUI();
initFilamentsUI();
initArchive();
initProductsUI();

// ---- onboarding + help ----
initOnboarding();
initHelp();

// ---- keyboard shortcuts ----
document.addEventListener('keydown', e => {
  // Don't intercept when typing in inputs.
  const tag = (e.target.tagName || '').toUpperCase();
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('save-quote').click();
  } else if (!inField && /^[1-6]$/.test(e.key)) {
    const idx = +e.key - 1;
    const tabs = document.querySelectorAll('.layer');
    if (tabs[idx]) tabs[idx].click();
  }
});

// ---- start cloud auth listener (if configured) ----
startAuthListener();

// ---- initial render ----
// First-load class enables block-stagger-reveal animation; removed after the
// initial paint so subsequent tab switches don't restart it.
document.body.classList.add('first-load');
resetFilaments();
renderFilaments();
loadSettingsToForm();
updateActivePrinterDisplay();
recalc();
initStickyTotal();
requestAnimationFrame(() => {
  setTimeout(() => document.body.classList.remove('first-load'), 800);
});
