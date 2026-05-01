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

import { settings, filaments, addons, MARKETPLACE_PRESETS } from './state.js?v=31';
import { loadProducts, saveProducts, loadPrinters, getActivePrinter, saveActivePrinterId } from './storage.js?v=31';
import { num, fmt, escapeHtml, formatHours, toCsv, downloadFile } from './utils.js?v=31';
import { toast, switchToPane } from './ui.js?v=31';
import { setFilaments, newFilament, renderFilaments } from './filaments.js?v=31';
import { recalc } from './calc.js?v=31';
import { updateActivePrinterDisplay } from './printers.js?v=31';
import { logActivity } from './firebase.js?v=31';

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
    // Catalog thumbnail uses the first photo (or legacy single photo).
    const firstPhoto = (Array.isArray(p.photos) && p.photos[0]) || p.photo || '';
    const photoCount = Array.isArray(p.photos) ? p.photos.length : (p.photo ? 1 : 0);
    const thumbHtml = firstPhoto
      ? `<div class="product-photo-thumb-wrap"><img class="product-photo-thumb" src="${escapeHtml(firstPhoto)}" alt="">${photoCount > 1 ? `<span class="photo-count">${photoCount}</span>` : ''}</div>`
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
  // Photos: normalize to an array. Legacy products may carry single `photo`.
  addons.photos = Array.isArray(p.photos) ? p.photos.slice()
                : p.photo ? [p.photo]
                : [];
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
    photos:    Array.isArray(addons.photos) ? addons.photos.slice() : [],
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

// ---------- per-product print: clean spec sheet ----------
//
// One-page printable: workshop build sheet + full cost breakdown.
// Clean Helvetica look, not the drafting aesthetic — the sheet is
// meant to print legibly on plain paper. Sections, in order:
//   - Header (title + target sell price)
//   - Photo (if set)
//   - Notes (if set)
//   - Meta grid: printer / time / filament / labor minutes
//   - Filaments to load (table)
//   - Add-ons (labor / packaging / shipping — raw values, mirrors
//     the Estimate sheet's Add-ons block)
//   - Bill of materials kitting checklist (table)
//   - Cost breakdown (full math: filament/electricity/machine/labor/
//     packaging/BOM/subtotal/failure/margin/+shipping)
//   - Estimated price stamp
//   - Target comparison + marketplace fees + Net to you (when set)
//
// @media print rules strip the cream/sand backgrounds so actual
// paper printers don't waste ink on decorative fills.

// Look up the saved product by id and print it.
function printProduct(id) {
  const p = loadProducts().find(x => String(x.id) === String(id));
  if (!p) return;
  printSpecSheet(p);
}

// Build a product-shaped snapshot from the current Estimate sheet state
// and print it. Wired to the Estimate sheet's Print button. The snapshot
// isn't saved — it just feeds the same print template that products use
// so unsaved estimates can be printed too.
export function printEstimate() {
  const printer = getActivePrinter();
  const hours = num(document.getElementById('time-h')?.value)
              + num(document.getElementById('time-m')?.value) / 60;
  const snapshot = {
    id: 'EST' + Date.now().toString().slice(-4),
    name: document.getElementById('print-name')?.value.trim() || 'Untitled estimate',
    notes: addons.notes || '',
    sellPrice: addons.sellPrice || '',
    photos: Array.isArray(addons.photos) ? addons.photos.slice() : [],
    printerId: printer ? String(printer.id) : '',
    hours,
    laborMinutes:  addons.laborMinutes  || '',
    packagingCost: addons.packagingCost || '',
    shippingCost:  addons.shippingCost  || '',
    filaments: filaments.map(f => ({ name: f.name, grams: f.grams, costPerKg: f.costPerKg })),
    bom: (addons.bom || []).map(b => ({ name: b.name, qty: b.qty, unitCost: b.unitCost })),
  };
  printSpecSheet(snapshot);
}

// The actual print template — takes a product-shaped object and opens
// a popup with the printable HTML. Used by both saved-product Print and
// the Estimate-sheet Print button.
function printSpecSheet(p) {
  const w = window.open('', '_blank');
  if (!w) { toast('Popup blocked — allow popups to print', true); return; }

  const r = computeProductBreakdown(p);

  const filRows = (p.filaments || []).map(f => `
    <tr>
      <td>${escapeHtml(f.name || 'Filament')}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${num(f.grams).toFixed(1)}&nbsp;g</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">$${num(f.costPerKg).toFixed(2)}/kg</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">$${((num(f.grams) / 1000) * num(f.costPerKg)).toFixed(2)}</td>
    </tr>
  `).join('');

  const bomRows = (p.bom || []).map(b => `
    <tr>
      <td style="width: 22px"><span class="check"></span></td>
      <td>${escapeHtml(b.name || '')}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${num(b.qty).toFixed(0)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">$${num(b.unitCost).toFixed(2)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">$${(num(b.qty) * num(b.unitCost)).toFixed(2)}</td>
    </tr>
  `).join('');

  // Add-ons section — labor minutes / packaging / shipping shown as raw
  // values. Mirrors the Estimate sheet's Add-ons block. Renders only when
  // any of the three is non-zero (an empty Add-ons section adds noise).
  const hasAddons = num(p.laborMinutes) > 0 || num(p.packagingCost) > 0 || num(p.shippingCost) > 0;
  const addonsRows = hasAddons ? [
    num(p.laborMinutes)  > 0 ? `<tr><td>Labor</td><td style="text-align:right;font-variant-numeric:tabular-nums">${num(p.laborMinutes).toFixed(0)} min</td></tr>` : '',
    num(p.packagingCost) > 0 ? `<tr><td>Packaging</td><td style="text-align:right;font-variant-numeric:tabular-nums">$${num(p.packagingCost).toFixed(2)}</td></tr>` : '',
    num(p.shippingCost)  > 0 ? `<tr><td>Default shipping (passthrough)</td><td style="text-align:right;font-variant-numeric:tabular-nums">$${num(p.shippingCost).toFixed(2)}</td></tr>` : '',
  ].filter(Boolean).join('') : '';

  // Cost breakdown rows — full math, mirrors the on-screen Estimate sheet.
  // Packaging/BOM/Shipping rows hidden when zero (matches bd-*-row hidden
  // behavior). Labor always shown when laborCost > 0.
  const breakdownRows = [
    `<tr><td>Filament</td><td>$${r.filCost.toFixed(2)}</td></tr>`,
    `<tr><td>Electricity</td><td>$${r.electricity.toFixed(2)}</td></tr>`,
    `<tr><td>Machine time</td><td>$${r.timeCost.toFixed(2)}</td></tr>`,
    r.laborCost     > 0 ? `<tr><td>Labor</td><td>$${r.laborCost.toFixed(2)}</td></tr>` : '',
    r.packagingCost > 0 ? `<tr><td>Packaging</td><td>$${r.packagingCost.toFixed(2)}</td></tr>` : '',
    r.bomCost       > 0 ? `<tr><td>Hardware / BOM</td><td>$${r.bomCost.toFixed(2)}</td></tr>` : '',
    `<tr class="sub"><td>Subtotal</td><td>$${r.subtotal.toFixed(2)}</td></tr>`,
    `<tr><td>Failure markup (${r.failurePct}%)</td><td>$${r.failureAmt.toFixed(2)}</td></tr>`,
    `<tr><td>Profit margin (${r.marginPct}%)</td><td>$${r.marginAmt.toFixed(2)}</td></tr>`,
    r.shippingCost  > 0 ? `<tr><td>+ Shipping (passthrough)</td><td>$${r.shippingCost.toFixed(2)}</td></tr>` : '',
  ].filter(Boolean).join('');

  // Target comparison — only if user set a target sell price
  const targetCompare = (r.targetDelta != null) ? `
    <div class="target-cmp ${r.targetDelta >= 0 ? 'over' : 'under'}">
      <span>Target $${r.target.toFixed(2)}</span>
      <span>${r.targetDelta >= 0 ? '+' : '−'}$${Math.abs(r.targetDelta).toFixed(2)} ${r.targetDelta >= 0 ? 'over' : 'under'}</span>
    </div>` : '';

  // Marketplace net — only when a marketplace is selected and fees > 0
  const marketplacePanel = (r.presetKey !== 'none' && r.feeAmt > 0) ? `
    <table class="net-panel">
      <tr><td>${escapeHtml(r.preset.label)} fees</td><td class="rust">−$${r.feeAmt.toFixed(2)}</td></tr>
      <tr class="net-row"><td>Net to you</td><td>$${r.net.toFixed(2)}</td></tr>
    </table>` : '';

  const biz = settings.businessName || '';
  const issued = new Date();

  w.document.write(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Spec · ${escapeHtml(p.name)}</title>
<style>
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #16202d; max-width: 720px; margin: 32px auto; padding: 0 24px; background: #f5efdc; }
  .head { display:flex; justify-content:space-between; align-items:flex-end; border-bottom: 2px solid #16202d; padding-bottom: 10px; margin-bottom: 18px; }
  .head .stamp { font-size: 10px; letter-spacing: 1.6px; text-transform: uppercase; color: #6a7585; }
  h1 { font-size: 24px; letter-spacing: 0.5px; margin: 0 0 2px; }
  .target { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .target small { display:block; font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; color: #6a7585; font-weight: 400; }
  .meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 18px 0 24px; padding: 12px; background: #f5efdc; border: 1px dashed #b8a878; }
  .meta-cell .k { font-size: 9px; letter-spacing: 1.4px; text-transform: uppercase; color: #6a7585; margin-bottom: 2px; }
  .meta-cell .v { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
  h2 { font-size: 13px; letter-spacing: 1.6px; text-transform: uppercase; color: #1f4e7a; border-bottom: 1px solid #d4cdb8; padding-bottom: 4px; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 7px 8px; border-bottom: 1px solid #e8e0c8; text-align: left; font-size: 13px; }
  th { font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; color: #6a7585; }
  tfoot td { border-top: 1.5px solid #16202d; border-bottom: none; font-weight: 600; font-variant-numeric: tabular-nums; }
  .check { display:inline-block; width: 14px; height: 14px; border: 1.5px solid #16202d; }
  .notes { background: #f5efdc; border-left: 3px solid #1f4e7a; padding: 8px 12px; font-size: 13px; line-height: 1.5; margin: 14px 0; }
  /* Cost breakdown table — mirrors the Estimate sheet's leader-dot rows */
  .breakdown td { font-variant-numeric: tabular-nums; }
  .breakdown td:last-child { text-align: right; }
  /* Subtotal row: heavy ink line ABOVE only — matches the on-screen
     Estimate sheet's .breakdown-row.subtotal which uses border-top alone.
     2px and !important to defeat any cascade weirdness with the default
     border-bottom on adjacent cells (border-collapse mode merges adjacent
     borders; the heaviest wins, but only if specificity is unambiguous). */
  .breakdown tr.sub td {
    border-top: 2px solid #16202d !important;
    border-bottom: 1px solid #e8e0c8;
    font-weight: 700;
    padding-top: 8px;
  }
  .estimated-stamp { display:flex; justify-content:space-between; align-items:baseline; margin-top: 12px; padding: 10px 12px; background: #f5efdc; border: 2px solid #16202d; }
  .estimated-stamp .label { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #16202d; font-weight: 800; }
  .estimated-stamp .value { font-size: 24px; font-weight: 800; font-variant-numeric: tabular-nums; color: #16202d; }
  /* Target comparison — green when over target, rust when under */
  .target-cmp { display:flex; justify-content:space-between; margin-top: 8px; padding: 6px 12px; background: #f5efdc; font-family: 'IBM Plex Mono', Consolas, monospace; font-size: 12px; border-left: 2px solid #837b67; }
  .target-cmp.over  { border-left-color: #4a6a3a; color: #4a6a3a; }
  .target-cmp.under { border-left-color: #a13c1f; color: #a13c1f; }
  /* Marketplace net panel */
  .net-panel { margin-top: 12px; }
  .net-panel td { padding: 6px 8px; font-variant-numeric: tabular-nums; }
  .net-panel td:last-child { text-align: right; }
  .net-panel td.rust { color: #a13c1f; }
  .net-panel tr.net-row td { border-top: 1.5px solid #4a6a3a; color: #4a6a3a; font-size: 16px; font-weight: 700; }
  .footer { margin-top: 36px; font-size: 11px; color: #6a7585; letter-spacing: 0.5px; }
  /* Product photos on the spec sheet — single-row flex layout that
     auto-fits as many photos as the product has. Each photo gets an
     equal share of width; max-height caps the row height. */
  .product-photos {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    margin: 14px 0 8px;
  }
  .product-photos img {
    flex: 1 1 0;
    min-width: 0;
    max-height: 220px;
    object-fit: contain;
    border: 1px solid #16202d;
    background: #f5efdc;
  }
  /* @media print — strip backgrounds AND condense to fit on one page.
     Screen view is unchanged; this block re-tightens every dimension so a
     typical product (1-3 filaments, 0-5 BOM items, full breakdown) fits
     within letter or A4 with 8mm margins. */
  @media print {
    @page { margin: 8mm; size: auto; }
    body {
      margin: 0; padding: 0; max-width: none;
      background: white !important;
      font-size: 10.5px;
      line-height: 1.35;
    }
    .meta-grid, .notes, .estimated-stamp, .target-cmp { background: white !important; }
    /* Header — smaller title, tighter rule */
    .head { padding-bottom: 5px; margin-bottom: 8px; border-bottom-width: 1.5px; }
    .head .stamp { font-size: 8px; letter-spacing: 1.2px; }
    h1 { font-size: 17px; margin-bottom: 1px; }
    .target { font-size: 18px; }
    .target small { font-size: 8px; letter-spacing: 1.1px; }
    /* Photos — single row, condensed in print */
    .product-photos { gap: 4px; margin: 6px 0 4px; }
    .product-photos img { max-height: 130px; }
    /* Notes — tighter padding */
    .notes { padding: 5px 9px; font-size: 10.5px; margin: 6px 0; line-height: 1.35; }
    /* Meta grid — tight cells */
    .meta-grid { padding: 6px 8px; gap: 8px; margin: 8px 0 10px; border-style: solid; border-color: #d4cdb8; }
    .meta-cell .k { font-size: 7.5px; letter-spacing: 1.1px; margin-bottom: 0; }
    .meta-cell .v { font-size: 11px; }
    /* Section headings — small, tight margins, ink-black (blueprint can
       wash out on low-cyan printers) */
    h2 {
      color: #16202d !important;
      font-size: 9.5px;
      letter-spacing: 1.4px;
      margin: 8px 0 3px;
      padding-bottom: 2px;
    }
    /* Tables — tight cells */
    table { margin: 0 0 2px; }
    th, td { padding: 2.5px 6px !important; font-size: 10.5px !important; }
    th { font-size: 7.5px !important; letter-spacing: 1.1px !important; }
    .check { width: 10px; height: 10px; border-width: 1px; }
    /* Breakdown — tight */
    .breakdown td { font-size: 10.5px; }
    /* Estimated stamp — smaller and tighter */
    .estimated-stamp { padding: 6px 10px; margin-top: 6px; border-width: 1.5px; }
    .estimated-stamp .label { font-size: 9px; letter-spacing: 1.6px; }
    .estimated-stamp .value { font-size: 18px; }
    /* Target compare — single tight line */
    .target-cmp { padding: 3px 10px; font-size: 10px; margin-top: 3px; }
    /* Marketplace net panel — tight */
    .net-panel { margin-top: 5px; }
    .net-panel td { padding: 3px 6px; }
    .net-panel tr.net-row td { font-size: 12px; }
    /* Footer — small, single line */
    .footer { margin-top: 10px; font-size: 9px; letter-spacing: 0.4px; }
    section, h2, table { page-break-inside: avoid; }
  }
</style></head><body>

<div class="head">
  <div>
    <div class="stamp">${String(p.id).startsWith('EST') ? 'Estimate · spec sheet' : 'Workshop spec · build sheet'}</div>
    <h1>${escapeHtml(p.name)}</h1>
  </div>
  ${p.sellPrice ? `<div class="target">$${(+p.sellPrice).toFixed(2)}<small>Target sell</small></div>` : ''}
</div>

${(() => {
  const photos = Array.isArray(p.photos) ? p.photos : (p.photo ? [p.photo] : []);
  if (!photos.length) return '';
  return `<div class="product-photos">${photos.map(src => `<img src="${escapeHtml(src)}" alt="">`).join('')}</div>`;
})()}

${p.notes ? `<div class="notes">${escapeHtml(p.notes)}</div>` : ''}

<div class="meta-grid">
  <div class="meta-cell"><div class="k">Printer</div><div class="v">${escapeHtml(r.printer?.name || '— any —')}</div></div>
  <div class="meta-cell"><div class="k">Print time</div><div class="v">${r.hours > 0 ? formatHours(r.hours) : '—'}</div></div>
  <div class="meta-cell"><div class="k">Filament</div><div class="v">${r.filGrams.toFixed(1)} g</div></div>
  <div class="meta-cell"><div class="k">Labor</div><div class="v">${p.laborMinutes ? `${num(p.laborMinutes)} min` : '—'}</div></div>
</div>

${filRows ? `<h2>Filaments to load</h2>
<table>
  <thead><tr><th>Color / type</th><th style="text-align:right">Grams</th><th style="text-align:right">$ / kg</th><th style="text-align:right">Cost</th></tr></thead>
  <tbody>${filRows}</tbody>
  <tfoot><tr><td colspan="3" style="text-align:right">Filament total</td><td style="text-align:right">$${r.filCost.toFixed(2)}</td></tr></tfoot>
</table>` : ''}

${addonsRows ? `<h2>Add-ons</h2>
<table>
  ${addonsRows}
</table>` : ''}

${bomRows ? `<h2>Bill of materials · kitting checklist</h2>
<table>
  <thead><tr><th></th><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit $</th><th style="text-align:right">Total</th></tr></thead>
  <tbody>${bomRows}</tbody>
  <tfoot><tr><td colspan="4" style="text-align:right">BOM total</td><td style="text-align:right">$${r.bomCost.toFixed(2)}</td></tr></tfoot>
</table>` : ''}

<h2>Cost breakdown</h2>
<table class="breakdown">
  <tbody>${breakdownRows}</tbody>
</table>

<div class="estimated-stamp">
  <span class="label">Estimated price</span>
  <span class="value">$${r.total.toFixed(2)}</span>
</div>

${targetCompare}
${marketplacePanel}

<div class="footer">
  ${biz ? escapeHtml(biz) + ' · ' : ''}Printed ${issued.toLocaleDateString()} ${issued.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · Print Pricer ${r.printer ? '' : '· No printer set — electricity & machine time shown as $0.00'}
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
