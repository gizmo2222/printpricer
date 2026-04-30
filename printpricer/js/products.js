// Products layer — saved Estimate-sheet snapshots with notes, target price,
// and bill of materials.
//
// A product is just a saved snapshot of the Estimate sheet (description,
// notes, target price, default printer, time, filaments, add-ons, BOM).
// There's no separate edit form — the Estimate sheet IS the editor. Click
// Edit on a catalog entry to load it into the Estimate sheet and enter
// edit mode (the EDITING PRODUCT banner appears). From there:
//   - Update product → overwrite the template with current sheet state
//   - Save as new product → create a new template
//   - Stamp & Archive  → archive a one-off quote (template untouched)
//   - Reset Sheet / cancel edit → exit edit mode
//
// This module owns the editingProductId state and the catalog list. The
// Estimate sheet's input wiring + smart save buttons live in main.js.

import { settings, filaments, addons, MARKETPLACE_PRESETS } from './state.js?v=24';
import { loadProducts, saveProducts, loadPrinters, getActivePrinter, saveActivePrinterId } from './storage.js?v=24';
import { num, fmt, escapeHtml, formatHours, toCsv, downloadFile } from './utils.js?v=24';
import { toast, switchToPane } from './ui.js?v=24';
import { setFilaments, newFilament, renderFilaments } from './filaments.js?v=24';
import { recalc } from './calc.js?v=24';
import { updateActivePrinterDisplay } from './printers.js?v=24';
import { logActivity } from './firebase.js?v=24';

// ---------- edit-mode state (module-private) ----------

let editingProductId = null;

export function getEditingProductId() {
  return editingProductId;
}

export function clearEditingMode() {
  if (editingProductId === null) return;
  editingProductId = null;
  updateEditingBannerUI();
  updateSaveButtonsUI();
}

function setEditingMode(id, name) {
  editingProductId = id;
  const banner = document.getElementById('editing-banner');
  const nameEl = document.getElementById('editing-banner-name');
  if (banner) banner.style.display = '';
  if (nameEl) nameEl.textContent = name || '—';
  updateSaveButtonsUI();
}

function updateEditingBannerUI() {
  const banner = document.getElementById('editing-banner');
  if (!banner) return;
  if (editingProductId) {
    banner.style.display = '';
    const p = loadProducts().find(x => String(x.id) === String(editingProductId));
    const nameEl = document.getElementById('editing-banner-name');
    if (nameEl) nameEl.textContent = p?.name || '—';
  } else {
    banner.style.display = 'none';
  }
}

function updateSaveButtonsUI() {
  // The "Update product" button + the disambiguator hint only appear when
  // actively editing a product. "Save as Product" stays always visible
  // (it always means "create a new product from current sheet").
  const upd  = document.getElementById('update-product');
  const hint = document.getElementById('edit-mode-hint');
  if (upd)  upd.style.display  = editingProductId ? '' : 'none';
  if (hint) hint.style.display = editingProductId ? '' : 'none';
}

// ---------- list view ----------

export function renderProducts() {
  const container = document.getElementById('products-grid');
  const count = document.getElementById('product-count');
  const actions = document.getElementById('products-actions');
  if (!container) return;
  const products = loadProducts();
  if (actions) actions.style.display = products.length ? 'flex' : 'none';

  // Earn the block-detail callout
  const callout = document.getElementById('block-detail-products');
  if (callout) {
    if (products.length > 0) {
      const totalCatalogValue = products.reduce((s, p) => s + (+p.sellPrice || 0), 0);
      callout.classList.add('active-info');
      callout.innerHTML = `${products.length} · ${fmt(totalCatalogValue)} CATALOG<span class="id">A</span>`;
    } else {
      callout.classList.remove('active-info');
      callout.innerHTML = `Saved templates<span class="id">A</span>`;
    }
  }

  count.innerHTML = products.length === 0
    ? 'No products saved yet'
    : `<strong>${products.length}</strong> product${products.length !== 1 ? 's' : ''} in catalog`;

  container.innerHTML = '';
  if (products.length === 0) {
    container.innerHTML = '<div class="empty"><strong>No products yet</strong>To save a product, fill in the Estimate sheet on layer 01 (description, time, filaments, BOM, add-ons) and click "Save as new product". Come back here to re-load it with one click — useful for Etsy listings, repeat commissions, anything you print more than once.</div>';
    return;
  }

  products.forEach(p => {
    const isEditing = String(p.id) === String(editingProductId);
    const printer = loadPrinters().find(x => String(x.id) === String(p.printerId));
    const item = document.createElement('div');
    item.className = 'spool-item' + (isEditing ? ' editing' : '');
    const totalGrams = (p.filaments || []).reduce((s, f) => s + (+f.grams || 0), 0);
    const bomCount = (p.bom || []).length;
    const thumbHtml = p.photo
      ? `<img class="product-photo-thumb" src="${escapeHtml(p.photo)}" alt="">`
      : `<div class="spool-swatch" style="background: var(--paper-deep)"></div>`;
    item.innerHTML = `
      ${thumbHtml}
      <div class="spool-info">
        <div class="spool-name"></div>
        <div class="spool-meta">
          ${printer ? `<span class="material-badge">${escapeHtml(printer.name)}</span>` : ''}
          ${totalGrams ? `<span>${totalGrams.toFixed(1)} g</span>` : ''}
          ${p.hours ? `<span>· ${formatHours(p.hours)}</span>` : ''}
          ${bomCount ? `<span>· ${bomCount} BOM item${bomCount !== 1 ? 's' : ''}</span>` : ''}
          ${p.notes ? `<span>· ${escapeHtml(p.notes)}</span>` : ''}
        </div>
      </div>
      <div class="spool-actions">
        ${p.sellPrice ? `<div class="spool-cost">$${(+p.sellPrice).toFixed(2)}<span class="unit">target</span></div>` : ''}
        <div class="actions-row">
          <button class="link-btn" data-edit-product="${escapeHtml(String(p.id))}">${isEditing ? 'Editing…' : 'Edit'}</button>
          <button class="link-btn" data-print-product="${escapeHtml(String(p.id))}">Print</button>
          <button class="link-btn danger" data-del-product="${escapeHtml(String(p.id))}">Delete</button>
        </div>
      </div>
    `;
    item.querySelector('.spool-name').textContent = p.name;
    container.appendChild(item);
  });

  container.querySelectorAll('[data-edit-product]').forEach(btn => {
    btn.addEventListener('click', e => loadProductIntoEstimate(e.target.dataset.editProduct));
  });
  container.querySelectorAll('[data-print-product]').forEach(btn => {
    btn.addEventListener('click', e => printProduct(e.target.dataset.printProduct));
  });
  container.querySelectorAll('[data-del-product]').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.target.dataset.delProduct;
      const p = loadProducts().find(x => String(x.id) === String(id));
      if (!confirm(`Delete product "${p?.name || ''}"?`)) return;
      saveProducts(loadProducts().filter(x => String(x.id) !== String(id)));
      // Exit edit mode if we just deleted the product we were editing.
      if (String(editingProductId) === String(id)) clearEditingMode();
      renderProducts();
      logActivity(`deleted product "${p?.name || ''}"`);
    });
  });
}

// ---------- load a product into the Estimate sheet (entry to edit-mode) ----------

function loadProductIntoEstimate(id) {
  const p = loadProducts().find(x => String(x.id) === String(id));
  if (!p) return;

  // Description, notes, target sell price, photo
  document.getElementById('print-name').value = p.name;
  const notesEl = document.getElementById('print-notes');
  if (notesEl) notesEl.value = p.notes || '';
  const targetEl = document.getElementById('print-target-price');
  if (targetEl) targetEl.value = p.sellPrice || '';
  addons.notes     = p.notes     || '';
  addons.sellPrice = p.sellPrice || '';
  addons.photo     = p.photo     || '';
  document.dispatchEvent(new CustomEvent('photo:render'));

  // Time
  const hrs  = Math.floor(+p.hours || 0);
  const mins = Math.round(((+p.hours || 0) - hrs) * 60);
  document.getElementById('time-h').value = hrs || '';
  document.getElementById('time-m').value = mins || '';

  // Filaments
  const fils = (p.filaments?.length ? p.filaments : [newFilament()]).map(f => ({
    name: f.name || '',
    grams: f.grams || '',
    costPerKg: f.costPerKg || '',
    spoolId: null,
  }));
  setFilaments(fils);
  renderFilaments();

  // Active printer (if specified on product)
  if (p.printerId) {
    saveActivePrinterId(p.printerId);
    updateActivePrinterDisplay();
  }

  // Add-ons (labor / packaging / shipping)
  addons.laborMinutes  = p.laborMinutes  != null ? String(p.laborMinutes)  : '';
  addons.packagingCost = p.packagingCost != null ? String(p.packagingCost) : '';
  addons.shippingCost  = p.shippingCost  != null ? String(p.shippingCost)  : '';
  document.getElementById('addon-labor').value     = addons.laborMinutes;
  document.getElementById('addon-packaging').value = addons.packagingCost;
  document.getElementById('addon-shipping').value  = addons.shippingCost;

  // BOM rows — replace addons.bom and re-render
  addons.bom = (p.bom || []).map(b => ({
    name:     b.name || '',
    qty:      b.qty != null ? String(b.qty) : '',
    unitCost: b.unitCost != null ? String(b.unitCost) : '',
  }));
  // Re-render BOM rows by dispatching a custom event the main.js handler listens for.
  document.dispatchEvent(new CustomEvent('bom:render'));

  recalc();
  setEditingMode(p.id, p.name);
  switchToPane('calc');
  toast(`Editing "${p.name}"`);
}

// ---------- save current Estimate as a product ----------
//
// asNew=true → always create a new product (used by "Save as new product").
// asNew=false (default) → if editingProductId is set, overwrite that product;
// otherwise create new (this is what "Update product" calls).

export function saveEstimateAsProduct({ asNew = false } = {}) {
  const name = document.getElementById('print-name').value.trim();
  if (!name) { toast('Enter a description first — that becomes the product name', true); return; }
  const printer = getActivePrinter();

  const data = {
    name,
    notes:     addons.notes     || '',
    sellPrice: addons.sellPrice || '',
    photo:     addons.photo     || '',
    printerId: printer ? String(printer.id) : '',
    hours: num(document.getElementById('time-h').value) + num(document.getElementById('time-m').value) / 60,
    laborMinutes:  addons.laborMinutes  || '',
    packagingCost: addons.packagingCost || '',
    shippingCost:  addons.shippingCost  || '',
    filaments: filaments.map(f => ({
      name: f.name,
      grams: f.grams,
      costPerKg: f.costPerKg,
    })),
    bom: (addons.bom || []).map(b => ({
      name: b.name,
      qty: b.qty,
      unitCost: b.unitCost,
    })),
  };

  const all = loadProducts();
  if (!asNew && editingProductId) {
    const idx = all.findIndex(x => String(x.id) === String(editingProductId));
    if (idx !== -1) {
      all[idx] = { ...all[idx], ...data };
      saveProducts(all);
      // Stay in edit mode, but refresh banner name in case it changed
      setEditingMode(editingProductId, name);
      toast(`Updated product · "${name}"`);
      logActivity(`updated product "${name}"`);
      return;
    }
    // Fall through to create if the editing target somehow disappeared.
  }
  const newProduct = { id: Date.now(), ...data };
  all.push(newProduct);
  saveProducts(all);
  // After "Save as new", switch edit mode to the freshly-created product so
  // a subsequent "Update product" hits the same record.
  setEditingMode(newProduct.id, name);
  toast(`Saved as new product · "${name}"`);
  logActivity(`saved product "${name}"`);
}

// ---------- shared totals helper ----------
//
// Light-weight totals for a product: filament grams + cost, BOM total/count.
// Used by the catalog list, print spec sheet, and CSV export.
function computeProductTotals(p) {
  const filGrams = (p.filaments || []).reduce((s, f) => s + num(f.grams), 0);
  const filCost  = (p.filaments || []).reduce((s, f) => s + (num(f.grams) / 1000) * num(f.costPerKg), 0);
  const bom = p.bom || [];
  const bomCost  = bom.reduce((s, b) => s + (num(b.qty) * num(b.unitCost)), 0);
  return { filGrams, filCost, bomCost, bomCount: bom.length };
}

// ---------- full breakdown for a product ----------
//
// Mirrors the recalc() math in calc.js. Used by the per-product print so
// the spec sheet shows the complete cost reasoning (electricity, machine
// time, labor, subtotal, failure markup, margin, marketplace fees, net) —
// not just what to build but what to charge.
//
// Inputs are the workspace `settings` and the product's `printerId` (which
// supplies wattage and hourly rate). Falls back to zero on missing printer
// so the breakdown still renders something sensible.
function computeProductBreakdown(p) {
  const printer = loadPrinters().find(x => String(x.id) === String(p.printerId));
  const watts        = printer ? num(printer.watts)       : 0;
  const hourlyRate   = printer ? num(printer.hourlyRate)  : 0;
  const hours        = num(p.hours);
  const kwh          = num(settings.kwh);
  const laborRate    = num(settings.laborRate);
  const failurePct   = num(settings.failurePct);
  const marginPct    = num(settings.marginPct);

  const t = computeProductTotals(p);
  const electricity   = (watts / 1000) * hours * kwh;
  const timeCost      = hours * hourlyRate;
  const laborCost     = (num(p.laborMinutes) / 60) * laborRate;
  const packagingCost = num(p.packagingCost);
  const shippingCost  = num(p.shippingCost);

  const subtotal      = t.filCost + electricity + timeCost + laborCost + packagingCost + t.bomCost;
  const failureAmt    = subtotal * (failurePct / 100);
  const afterFailure  = subtotal + failureAmt;
  const marginAmt     = afterFailure * (marginPct / 100);
  const beforeShip    = afterFailure + marginAmt;
  const total         = beforeShip + shippingCost;

  // Marketplace fees (parallel to calc.js computeFees)
  const presetKey = settings.marketplacePreset || 'none';
  let preset = MARKETPLACE_PRESETS[presetKey] || MARKETPLACE_PRESETS.none;
  if (presetKey === 'custom') {
    preset = {
      label: 'Custom',
      listingFee:  num(settings.marketplaceCustomListing),
      txnPct:      num(settings.marketplaceCustomTxnPct),
      paymentPct:  num(settings.marketplaceCustomPaymentPct),
      paymentFlat: num(settings.marketplaceCustomPaymentFlat),
    };
  }
  const feeAmt = preset.listingFee
              + total * (preset.txnPct / 100)
              + total * (preset.paymentPct / 100)
              + preset.paymentFlat;
  const net = total - feeAmt;

  const target = num(p.sellPrice);
  const targetDelta = target > 0 && total > 0 ? (target - total) : null;

  return {
    printer, hours, watts, kwh, hourlyRate,
    filGrams: t.filGrams, filCost: t.filCost, bomCost: t.bomCost, bomCount: t.bomCount,
    electricity, timeCost, laborCost, packagingCost, shippingCost,
    subtotal, failurePct, failureAmt, marginPct, marginAmt, total,
    presetKey, preset, feeAmt, net,
    target, targetDelta,
  };
}

// ---------- per-product print: full Estimate-sheet replica ----------
//
// Mirrors the on-screen Estimate sheet 1:1 — same fonts, same drafting
// aesthetic (corner brackets, blueprint structural rules, leader-dot
// breakdown rows, blueprint total-stamp). Block-by-block:
//   01 Print          — printer, description, photo, notes, target, time
//   02 Filaments      — filament rows
//   03 Add-ons        — labor minutes / packaging / shipping (raw values)
//   04 Bill of Materials — BOM rows
//   05 Cost Breakdown — full breakdown + total stamp + vs-target + net
//
// On print: backgrounds strip to white (paper texture is decorative);
// borders and ink stay so structure is preserved.

function printProduct(id) {
  const p = loadProducts().find(x => String(x.id) === String(id));
  if (!p) return;
  const w = window.open('', '_blank');
  if (!w) { toast('Popup blocked — allow popups to print', true); return; }

  const r = computeProductBreakdown(p);

  // Filament rows — leader-dot pattern matching the Estimate sheet
  const filRows = (p.filaments || []).map(f => {
    const cost = (num(f.grams) / 1000) * num(f.costPerKg);
    return `
    <div class="bd-row">
      <span class="bd-label">${escapeHtml(f.name || 'Filament')}</span>
      <span class="bd-leader"></span>
      <span class="bd-meta">${num(f.grams).toFixed(1)}&nbsp;g · $${num(f.costPerKg).toFixed(2)}/kg</span>
      <span class="bd-value">$${cost.toFixed(2)}</span>
    </div>`;
  }).join('');

  // BOM rows
  const bomRows = (p.bom || []).map(b => {
    const cost = num(b.qty) * num(b.unitCost);
    return `
    <div class="bd-row">
      <span class="bd-label">${escapeHtml(b.name || '')}</span>
      <span class="bd-leader"></span>
      <span class="bd-meta">${num(b.qty).toFixed(0)} × $${num(b.unitCost).toFixed(2)}</span>
      <span class="bd-value">$${cost.toFixed(2)}</span>
    </div>`;
  }).join('');

  // Cost-breakdown rows — leader-dot pattern, packaging/BOM/shipping hidden
  // when zero (mirrors bd-*-row hidden behavior on the Estimate sheet)
  const bdRow = (label, val) =>
    `<div class="bd-row"><span class="bd-label">${label}</span><span class="bd-leader"></span><span class="bd-value">$${val.toFixed(2)}</span></div>`;
  const breakdownRows = [
    bdRow('Filament',     r.filCost),
    bdRow('Electricity',  r.electricity),
    bdRow('Machine time', r.timeCost),
    r.laborCost     > 0 ? bdRow('Labor',          r.laborCost)     : '',
    r.packagingCost > 0 ? bdRow('Packaging',      r.packagingCost) : '',
    r.bomCost       > 0 ? bdRow('Hardware / BOM', r.bomCost)       : '',
    `<div class="bd-row sub"><span class="bd-label">Subtotal</span><span class="bd-leader"></span><span class="bd-value">$${r.subtotal.toFixed(2)}</span></div>`,
    bdRow(`Failure markup (${r.failurePct}%)`, r.failureAmt),
    bdRow(`Profit margin (${r.marginPct}%)`,   r.marginAmt),
    r.shippingCost > 0 ? bdRow('+ Shipping (passthrough)', r.shippingCost) : '',
  ].filter(Boolean).join('');

  // Add-ons: shown as a labeled block matching the Estimate sheet's input row
  const hasAddons = num(p.laborMinutes) > 0 || num(p.packagingCost) > 0 || num(p.shippingCost) > 0;
  const addonsBlock = hasAddons ? `
    <section class="block">
      <span class="bl"></span><span class="br"></span>
      <header class="block-head">
        <h2 class="block-title">Add-ons</h2>
        <div class="block-detail">Labor · packaging · shipping<span class="id">C</span></div>
      </header>
      <div class="addon-row">
        <div class="addon-cell"><div class="addon-k">Labor minutes</div><div class="addon-v">${p.laborMinutes ? num(p.laborMinutes).toFixed(0) + ' min' : '—'}</div></div>
        <div class="addon-cell"><div class="addon-k">Packaging</div><div class="addon-v">${p.packagingCost ? '$' + num(p.packagingCost).toFixed(2) : '—'}</div></div>
        <div class="addon-cell"><div class="addon-k">Shipping</div><div class="addon-v">${p.shippingCost ? '$' + num(p.shippingCost).toFixed(2) : '—'}</div></div>
      </div>
    </section>` : '';

  const bomBlock = bomRows ? `
    <section class="block">
      <span class="bl"></span><span class="br"></span>
      <header class="block-head">
        <h2 class="block-title">Bill of Materials</h2>
        <div class="block-detail">${(p.bom || []).length} item${(p.bom || []).length !== 1 ? 's' : ''} · $${r.bomCost.toFixed(2)}<span class="id">D</span></div>
      </header>
      <div class="bd">${bomRows}</div>
    </section>` : '';

  // Target comparison — only if user set a target sell price
  const targetCompare = (r.targetDelta != null) ? `
    <div class="target-cmp ${r.targetDelta >= 0 ? 'over' : 'under'}">
      <span class="t-k">vs target</span>
      <span class="t-v">Target $${r.target.toFixed(2)} · ${r.targetDelta >= 0 ? '+' : '−'}$${Math.abs(r.targetDelta).toFixed(2)}</span>
    </div>` : '';

  // Marketplace net — only when a marketplace is selected and fees > 0
  const marketplacePanel = (r.presetKey !== 'none' && r.feeAmt > 0) ? `
    <div class="net-panel">
      <div class="bd-row"><span class="bd-label">${escapeHtml(r.preset.label)} fees</span><span class="bd-leader"></span><span class="bd-value rust">−$${r.feeAmt.toFixed(2)}</span></div>
      <div class="bd-row net"><span class="bd-label">Net to you</span><span class="bd-leader"></span><span class="bd-value">$${r.net.toFixed(2)}</span></div>
    </div>` : '';

  const biz       = settings.businessName  || '';
  const bizEmail  = settings.businessEmail || '';
  const bizNotes  = settings.businessNotes || '';
  const issued    = new Date();
  const issuedStr = `${issued.getFullYear()}.${String(issued.getMonth()+1).padStart(2,'0')}.${String(issued.getDate()).padStart(2,'0')}`;
  const dwgNum    = `PP-${String(p.id).slice(-4)}`;

  w.document.write(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Spec · ${escapeHtml(p.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@500;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* ---- Tokens (mirror :root in styles.css) ---- */
  :root {
    --paper:        #f0e8d3;
    --paper-dim:    #e7decd;
    --paper-deep:   #ddd0b4;
    --paper-shadow: #c9bb9a;
    --ink:          #16202d;
    --ink-mid:      #4a5562;
    --ink-faint:    #837b67;
    --blueprint:    #1f4e7a;
    --rust:         #a13c1f;
    --moss:         #4a6a3a;
    --display:    'Big Shoulders Display', 'Impact', sans-serif;
    --sans:       'IBM Plex Sans', system-ui, sans-serif;
    --condensed:  'IBM Plex Sans Condensed', 'IBM Plex Sans', sans-serif;
    --mono:       'IBM Plex Mono', 'Consolas', monospace;
    --track-display: 0.012em;
    --track-caps:    0.12em;
    --track-stamp:   0.18em;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.55;
    color: var(--ink);
    background: var(--paper);
    max-width: 800px;
    margin: 24px auto;
    padding: 16px 24px 32px;
  }

  /* ---- Title block ---- */
  .title-block {
    display: grid;
    grid-template-columns: 1fr 240px;
    border: 1.5px solid var(--ink);
    background: var(--paper-dim);
    margin-bottom: 24px;
  }
  .title-main { padding: 12px 16px; border-right: 1px solid var(--ink); }
  .title-main h1 {
    font-family: var(--display);
    font-weight: 800;
    font-size: 38px;
    line-height: 0.95;
    letter-spacing: var(--track-display);
    text-transform: uppercase;
    color: var(--ink);
    margin-bottom: 4px;
  }
  .title-main .subtitle {
    font-family: var(--condensed);
    font-size: 11px;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--ink-mid);
  }
  .title-meta {
    display: grid;
    grid-template-columns: minmax(0,1fr) minmax(0,1fr);
    grid-auto-rows: 1fr;
    font-family: var(--mono);
    font-size: 10px;
  }
  .title-meta .cell {
    padding: 6px 10px 4px;
    border-bottom: 1px solid var(--ink);
    border-right: 1px solid var(--ink);
    overflow: hidden;
  }
  .title-meta .cell:nth-child(2n)         { border-right: none; }
  .title-meta .cell:nth-last-child(-n+2)  { border-bottom: none; }
  .title-meta .key {
    font-family: var(--condensed);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: var(--track-caps);
    color: var(--ink-faint);
    text-transform: uppercase;
    display: block;
    margin-bottom: 1px;
  }
  .title-meta .val { font-weight: 500; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title-meta .val.accent { color: var(--blueprint); font-weight: 600; }

  /* ---- Block (corner-bracket card) ---- */
  .block {
    position: relative;
    padding: 20px;
    margin-bottom: 20px;
    background: var(--paper);
    border: 1px solid var(--ink);
    page-break-inside: avoid;
  }
  .block::before, .block::after, .block > .br, .block > .bl {
    content: ''; position: absolute;
    width: 10px; height: 10px;
    border: 1.5px solid var(--blueprint);
  }
  .block::before { top: -3px;    left: -3px;  border-right: none; border-bottom: none; }
  .block::after  { top: -3px;    right: -3px; border-left:  none; border-bottom: none; }
  .block > .br   { bottom: -3px; right: -3px; border-left:  none; border-top:    none; }
  .block > .bl   { bottom: -3px; left: -3px;  border-right: none; border-top:    none; }

  .block-head {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--ink);
  }
  .block-title {
    font-family: var(--display);
    font-weight: 700;
    font-size: 22px;
    line-height: 1.05;
    letter-spacing: var(--track-display);
    text-transform: uppercase;
    color: var(--ink);
  }
  .block-detail {
    font-family: var(--condensed);
    font-size: 10px;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--ink-faint);
    font-weight: 600;
  }
  .block-detail .id {
    color: var(--blueprint);
    font-family: var(--mono);
    font-size: 12px;
    margin-left: 6px;
    font-weight: 600;
    letter-spacing: 0;
  }

  /* ---- Field rows (Print block) ---- */
  .field { margin-bottom: 12px; }
  .field-label {
    font-family: var(--condensed);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--ink-faint);
    display: block;
    margin-bottom: 2px;
  }
  .field-val { font-size: 15px; font-weight: 500; color: var(--ink); }
  .field-val.dim { color: var(--ink-faint); font-style: italic; }
  .field-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 12px; }

  /* ---- Photo (in Print block) ---- */
  .photo-wrap { margin-top: 4px; }
  .photo-wrap img {
    display: block; max-width: 100%; max-height: 280px; object-fit: contain;
    border: 1px solid var(--ink); background: var(--paper-dim);
  }

  /* ---- Add-ons block ---- */
  .addon-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .addon-cell { padding: 6px 0; }
  .addon-k {
    font-family: var(--condensed);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--ink-faint);
    margin-bottom: 2px;
  }
  .addon-v { font-family: var(--mono); font-size: 15px; font-weight: 500; }

  /* ---- Breakdown rows ---- */
  .bd { display: flex; flex-direction: column; }
  .bd-row {
    display: flex; align-items: baseline; gap: 8px;
    padding: 5px 0;
    font-family: var(--mono);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .bd-label {
    flex: 0 0 auto;
    font-family: var(--condensed);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--ink-mid);
  }
  .bd-leader {
    flex: 1;
    border-bottom: 1px dotted var(--ink-mid);
    transform: translateY(-3px);
    min-width: 24px;
    opacity: 0.78;
  }
  .bd-meta {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-faint);
    margin-right: 4px;
  }
  .bd-value { flex: 0 0 auto; font-weight: 500; color: var(--ink); }
  .bd-value.rust { color: var(--rust); }
  .bd-row.sub {
    margin-top: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--ink);
  }
  .bd-row.sub .bd-label,
  .bd-row.sub .bd-value { color: var(--ink); font-weight: 600; }
  .bd-row.net {
    margin-top: 4px;
    padding-top: 6px;
    border-top: 1.5px solid var(--moss);
  }
  .bd-row.net .bd-label { color: var(--moss); font-weight: 700; }
  .bd-row.net .bd-value { color: var(--moss); font-weight: 700; font-size: 15px; }

  /* ---- Total stamp (mirrors .total-stamp on screen) ---- */
  .total-stamp {
    margin-top: 14px;
    padding: 12px 16px;
    border: 2px solid var(--blueprint);
    background: var(--paper-dim);
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    position: relative;
  }
  .total-stamp::before {
    content: ''; position: absolute; inset: 3px;
    border: 1px solid var(--blueprint);
    pointer-events: none;
  }
  .total-stamp .label {
    font-family: var(--display);
    font-size: 18px;
    font-weight: 800;
    letter-spacing: var(--track-stamp);
    text-transform: uppercase;
    color: var(--blueprint);
    line-height: 1.1;
  }
  .total-stamp .value {
    font-family: var(--mono);
    font-size: 28px;
    font-weight: 600;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.01em;
  }

  /* ---- Target compare ---- */
  .target-cmp {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-top: 10px;
    padding: 8px 12px;
    background: var(--paper-dim);
    border-left: 2px solid var(--ink-faint);
    font-family: var(--mono);
  }
  .target-cmp.over  { border-left-color: var(--moss); }
  .target-cmp.under { border-left-color: var(--rust); }
  .target-cmp .t-k {
    font-family: var(--condensed);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: var(--track-caps);
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .target-cmp .t-v { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--ink-mid); }
  .target-cmp.over  .t-v { color: var(--moss); }
  .target-cmp.under .t-v { color: var(--rust); }

  /* ---- Net-after-fees panel ---- */
  .net-panel { margin-top: 12px; }

  /* ---- Footer ---- */
  .footer {
    margin-top: 28px;
    padding-top: 12px;
    border-top: 1px solid var(--ink-faint);
    font-family: var(--condensed);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
    text-transform: uppercase;
    display: flex; justify-content: space-between;
  }

  /* ---- Print: strip backgrounds, keep ink + structural rules ---- */
  @media print {
    @page { margin: 12mm; size: auto; }
    body {
      max-width: none;
      margin: 0;
      padding: 0;
      background: white !important;
    }
    .title-block,
    .block,
    .total-stamp,
    .target-cmp,
    .photo-wrap img {
      background: white !important;
    }
    .total-stamp::before { display: none; } /* the inset double-rule reads muddy in print */
    .block, .title-block { box-shadow: none !important; }
    .block { page-break-inside: avoid; }
    .footer { color: var(--ink-faint); }
  }
</style></head><body>

<div class="title-block">
  <div class="title-main">
    <h1>${escapeHtml(p.name || 'Untitled product')}</h1>
    <div class="subtitle">Filament · Time · Power · Margin</div>
  </div>
  <div class="title-meta">
    <div class="cell"><span class="key">Drawing</span><span class="val accent">${escapeHtml(dwgNum)}</span></div>
    <div class="cell"><span class="key">Date</span><span class="val">${issuedStr}</span></div>
    <div class="cell"><span class="key">Owner</span><span class="val">${escapeHtml(biz || 'Local')}</span></div>
    <div class="cell"><span class="key">Sheet</span><span class="val">01 / 01</span></div>
  </div>
</div>

<section class="block">
  <span class="bl"></span><span class="br"></span>
  <header class="block-head">
    <h2 class="block-title">Print</h2>
    <div class="block-detail">${escapeHtml((r.printer?.name || 'No printer').toUpperCase())}<span class="id">A</span></div>
  </header>
  <div class="field">
    <span class="field-label">Printer</span>
    <span class="field-val ${r.printer ? '' : 'dim'}">${escapeHtml(r.printer?.name || '— none selected —')}</span>
  </div>
  <div class="field">
    <span class="field-label">Description</span>
    <span class="field-val">${escapeHtml(p.name || '—')}</span>
  </div>
  ${p.photo ? `<div class="field">
    <span class="field-label">Photo</span>
    <div class="photo-wrap"><img src="${escapeHtml(p.photo)}" alt=""></div>
  </div>` : ''}
  ${(p.notes || p.sellPrice) ? `<div class="field-grid-2">
    <div class="field">
      <span class="field-label">Notes</span>
      <span class="field-val ${p.notes ? '' : 'dim'}">${escapeHtml(p.notes || '—')}</span>
    </div>
    <div class="field">
      <span class="field-label">Target sell price</span>
      <span class="field-val ${p.sellPrice ? '' : 'dim'}">${p.sellPrice ? '$' + (+p.sellPrice).toFixed(2) : '—'}</span>
    </div>
  </div>` : ''}
  <div class="field-grid-2">
    <div class="field">
      <span class="field-label">Print time — hours</span>
      <span class="field-val">${Math.floor(r.hours)}</span>
    </div>
    <div class="field">
      <span class="field-label">Print time — minutes</span>
      <span class="field-val">${Math.round((r.hours - Math.floor(r.hours)) * 60)}</span>
    </div>
  </div>
</section>

${filRows ? `<section class="block">
  <span class="bl"></span><span class="br"></span>
  <header class="block-head">
    <h2 class="block-title">Filaments</h2>
    <div class="block-detail">${(p.filaments || []).length} · ${r.filGrams.toFixed(1)} G<span class="id">B</span></div>
  </header>
  <div class="bd">${filRows}</div>
</section>` : ''}

${addonsBlock}
${bomBlock}

<section class="block">
  <span class="bl"></span><span class="br"></span>
  <header class="block-head">
    <h2 class="block-title">Cost Breakdown</h2>
    <div class="block-detail">${r.hours > 0 ? formatHours(r.hours).replace(/\s/g,'').toUpperCase() : 'Estimate summary'}<span class="id">E</span></div>
  </header>
  <div class="bd">${breakdownRows}</div>
  <div class="total-stamp">
    <span class="label">Estimated price</span>
    <span class="value">$${r.total.toFixed(2)}</span>
  </div>
  ${targetCompare}
  ${marketplacePanel}
</section>

<div class="footer">
  <span>${escapeHtml(biz || 'Print Pricer')}${bizEmail ? ' · ' + escapeHtml(bizEmail) : ''}</span>
  <span>${issuedStr}${r.printer ? '' : ' · No printer set — electricity & machine time $0.00'}</span>
</div>

<script>window.onload = () => setTimeout(() => window.print(), 100);<\/script>
</body></html>`);
  w.document.close();
}

// ---------- print catalog: all products on one sheet ----------

function printProductCatalog() {
  const all = loadProducts();
  if (!all.length) { toast('Catalog is empty', true); return; }
  const w = window.open('', '_blank');
  if (!w) { toast('Popup blocked — allow popups to print', true); return; }

  const printers = loadPrinters();
  const biz = settings.businessName || '';
  const bizEmail = settings.businessEmail || '';
  const bizNotes = settings.businessNotes || '';
  const issued = new Date();

  // Sort: sell price desc, then alpha (so a customer skim hits the high-ticket items first)
  const sorted = all.slice().sort((a, b) => {
    const ap = +a.sellPrice || 0, bp = +b.sellPrice || 0;
    if (bp !== ap) return bp - ap;
    return (a.name || '').localeCompare(b.name || '');
  });

  const rows = sorted.map(p => {
    const printer = printers.find(x => String(x.id) === String(p.printerId));
    const t = computeProductTotals(p);
    return `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong>${p.notes ? `<div class="sub">${escapeHtml(p.notes)}</div>` : ''}</td>
        <td>${escapeHtml(printer?.name || '—')}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${p.hours ? formatHours(+p.hours) : '—'}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${t.filGrams ? t.filGrams.toFixed(1) + ' g' : '—'}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${t.bomCount || '—'}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:700">${p.sellPrice ? '$' + (+p.sellPrice).toFixed(2) : '—'}</td>
      </tr>
    `;
  }).join('');

  const bizHeader = biz
    ? `<div class="biz">
        <div class="biz-name">${escapeHtml(biz)}</div>
        ${bizNotes ? `<div class="biz-notes">${escapeHtml(bizNotes)}</div>` : ''}
        ${bizEmail ? `<div class="biz-email">${escapeHtml(bizEmail)}</div>` : ''}
      </div>`
    : '';

  const totalCatalogValue = sorted.reduce((s, p) => s + (+p.sellPrice || 0), 0);

  w.document.write(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Product Catalog</title>
<style>
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #16202d; max-width: 820px; margin: 32px auto; padding: 0 24px; }
  .biz { margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1.5px solid #16202d; }
  .biz-name { font-size: 22px; font-weight: 700; letter-spacing: 0.5px; margin-bottom: 2px; }
  .biz-notes { color: #6a7585; font-size: 13px; line-height: 1.5; }
  .biz-email { color: #1f4e7a; font-size: 13px; margin-top: 4px; }
  h1 { font-size: 26px; letter-spacing: 1px; margin-bottom: 4px; }
  .sub { color: #6a7585; font-size: 12px; letter-spacing: 0.4px; margin-top: 2px; }
  .stamp { color: #6a7585; font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th, td { padding: 9px 10px; border-bottom: 1px solid #e8e0c8; text-align: left; font-size: 13px; vertical-align: top; }
  th { font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; color: #6a7585; border-bottom: 1.5px solid #16202d; }
  tfoot td { border-top: 1.5px solid #16202d; border-bottom: none; font-weight: 600; font-variant-numeric: tabular-nums; }
  .footer { margin-top: 32px; font-size: 11px; color: #6a7585; letter-spacing: 0.5px; }
  @media print { body { margin: 12mm; max-width: none; } }
</style></head><body>

${bizHeader}

<h1>Product Catalog</h1>
<div class="stamp">${sorted.length} product${sorted.length !== 1 ? 's' : ''} · Issued ${issued.toLocaleDateString()}</div>

<table>
  <thead>
    <tr>
      <th>Product</th>
      <th>Printer</th>
      <th style="text-align:right">Print time</th>
      <th style="text-align:right">Filament</th>
      <th style="text-align:right">BOM</th>
      <th style="text-align:right">Target</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
  <tfoot>
    <tr><td colspan="5" style="text-align:right">Catalog total (target prices)</td><td style="text-align:right">$${totalCatalogValue.toFixed(2)}</td></tr>
  </tfoot>
</table>

<div class="footer">
  ${biz ? escapeHtml(biz) + ' · ' : ''}Generated ${issued.toLocaleDateString()} ${issued.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · Print Pricer
</div>

<script>window.onload = () => setTimeout(() => window.print(), 100);<\/script>
</body></html>`);
  w.document.close();
}

// ---------- export catalog as CSV ----------

function exportProductsCsv() {
  const all = loadProducts();
  if (!all.length) { toast('Catalog is empty', true); return; }
  const printers = loadPrinters();
  const rows = all.map(p => {
    const printer = printers.find(x => String(x.id) === String(p.printerId));
    const t = computeProductTotals(p);
    return {
      name: p.name,
      notes: p.notes || '',
      sell_price: (+p.sellPrice || 0).toFixed(2),
      printer: printer?.name || '',
      hours: (+p.hours || 0).toFixed(3),
      total_grams: t.filGrams.toFixed(2),
      filament_cost: t.filCost.toFixed(2),
      filaments: (p.filaments || []).map(f => `${f.name}:${num(f.grams).toFixed(1)}g@$${num(f.costPerKg).toFixed(2)}`).join('; '),
      labor_minutes: num(p.laborMinutes).toFixed(0),
      packaging: num(p.packagingCost).toFixed(2),
      shipping: num(p.shippingCost).toFixed(2),
      bom_count: t.bomCount,
      bom_total: t.bomCost.toFixed(2),
      bom_items: (p.bom || []).map(b => `${b.name}:${num(b.qty).toFixed(0)}@$${num(b.unitCost).toFixed(2)}`).join('; '),
    };
  });
  const cols = [
    'name','notes','sell_price','printer','hours','total_grams','filament_cost','filaments',
    'labor_minutes','packaging','shipping','bom_count','bom_total','bom_items',
  ];
  const csv = toCsv(rows, cols);
  const filename = `printpricer-products-${new Date().toISOString().slice(0, 10)}.csv`;
  downloadFile(filename, csv, 'text/csv;charset=utf-8');
  toast(`Exported ${rows.length} product${rows.length !== 1 ? 's' : ''} to ${filename}`);
}

export function initProductsUI() {
  document.getElementById('export-products-csv')?.addEventListener('click', exportProductsCsv);
  document.getElementById('print-products-catalog')?.addEventListener('click', printProductCatalog);
  document.getElementById('cancel-edit-btn')?.addEventListener('click', () => {
    clearEditingMode();
    toast('Exited edit mode');
  });
  // Initial banner state (in case the page loads with no editing in progress)
  updateEditingBannerUI();
  updateSaveButtonsUI();
}
