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

import { settings, filaments, addons } from './state.js?v=20';
import { loadProducts, saveProducts, loadPrinters, getActivePrinter, saveActivePrinterId } from './storage.js?v=20';
import { num, fmt, escapeHtml, formatHours, toCsv, downloadFile } from './utils.js?v=20';
import { toast, switchToPane } from './ui.js?v=20';
import { setFilaments, newFilament, renderFilaments } from './filaments.js?v=20';
import { recalc } from './calc.js?v=20';
import { updateActivePrinterDisplay } from './printers.js?v=20';
import { logActivity } from './firebase.js?v=20';

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
  // The "Update product" button only appears when actively editing a
  // product. "Save as new product" is always visible.
  const upd = document.getElementById('update-product');
  if (upd) upd.style.display = editingProductId ? '' : 'none';
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
    item.innerHTML = `
      <div class="spool-swatch" style="background: var(--paper-deep)"></div>
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

  // Description, notes, target sell price
  document.getElementById('print-name').value = p.name;
  const notesEl = document.getElementById('print-notes');
  if (notesEl) notesEl.value = p.notes || '';
  const targetEl = document.getElementById('print-target-price');
  if (targetEl) targetEl.value = p.sellPrice || '';
  addons.notes     = p.notes     || '';
  addons.sellPrice = p.sellPrice || '';

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
// Used by the print spec sheet and CSV export so per-product math lives in
// one place.
function computeProductTotals(p) {
  const filGrams = (p.filaments || []).reduce((s, f) => s + num(f.grams), 0);
  const filCost  = (p.filaments || []).reduce((s, f) => s + (num(f.grams) / 1000) * num(f.costPerKg), 0);
  const bom = p.bom || [];
  const bomCost  = bom.reduce((s, b) => s + (num(b.qty) * num(b.unitCost)), 0);
  return { filGrams, filCost, bomCost, bomCount: bom.length };
}

// ---------- per-product print: workshop spec sheet ----------

function printProduct(id) {
  const p = loadProducts().find(x => String(x.id) === String(id));
  if (!p) return;
  const w = window.open('', '_blank');
  if (!w) { toast('Popup blocked — allow popups to print', true); return; }

  const printer = loadPrinters().find(x => String(x.id) === String(p.printerId));
  const t = computeProductTotals(p);

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

  const biz = settings.businessName || '';
  const issued = new Date();

  w.document.write(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Spec · ${escapeHtml(p.name)}</title>
<style>
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #16202d; max-width: 720px; margin: 32px auto; padding: 0 24px; }
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
  .footer { margin-top: 36px; font-size: 11px; color: #6a7585; letter-spacing: 0.5px; }
  @media print { body { margin: 12mm; max-width: none; } }
</style></head><body>

<div class="head">
  <div>
    <div class="stamp">Workshop spec · build sheet</div>
    <h1>${escapeHtml(p.name)}</h1>
  </div>
  ${p.sellPrice ? `<div class="target">$${(+p.sellPrice).toFixed(2)}<small>Target sell</small></div>` : ''}
</div>

${p.notes ? `<div class="notes">${escapeHtml(p.notes)}</div>` : ''}

<div class="meta-grid">
  <div class="meta-cell"><div class="k">Printer</div><div class="v">${escapeHtml(printer?.name || '— any —')}</div></div>
  <div class="meta-cell"><div class="k">Print time</div><div class="v">${p.hours ? formatHours(+p.hours) : '—'}</div></div>
  <div class="meta-cell"><div class="k">Filament</div><div class="v">${t.filGrams.toFixed(1)} g</div></div>
  <div class="meta-cell"><div class="k">Labor</div><div class="v">${p.laborMinutes ? `${num(p.laborMinutes)} min` : '—'}</div></div>
</div>

${filRows ? `<h2>Filaments to load</h2>
<table>
  <thead><tr><th>Color / type</th><th style="text-align:right">Grams</th><th style="text-align:right">$ / kg</th><th style="text-align:right">Cost</th></tr></thead>
  <tbody>${filRows}</tbody>
  <tfoot><tr><td colspan="3" style="text-align:right">Filament total</td><td style="text-align:right">$${t.filCost.toFixed(2)}</td></tr></tfoot>
</table>` : ''}

${bomRows ? `<h2>Bill of materials · kitting checklist</h2>
<table>
  <thead><tr><th></th><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit $</th><th style="text-align:right">Total</th></tr></thead>
  <tbody>${bomRows}</tbody>
  <tfoot><tr><td colspan="4" style="text-align:right">BOM total</td><td style="text-align:right">$${t.bomCost.toFixed(2)}</td></tr></tfoot>
</table>` : ''}

${(p.packagingCost || p.shippingCost) ? `<h2>Add-ons</h2>
<table>
  ${p.packagingCost ? `<tr><td>Packaging</td><td style="text-align:right;font-variant-numeric:tabular-nums">$${num(p.packagingCost).toFixed(2)}</td></tr>` : ''}
  ${p.shippingCost  ? `<tr><td>Default shipping (passthrough)</td><td style="text-align:right;font-variant-numeric:tabular-nums">$${num(p.shippingCost).toFixed(2)}</td></tr>` : ''}
</table>` : ''}

<div class="footer">
  ${biz ? escapeHtml(biz) + ' · ' : ''}Printed ${issued.toLocaleDateString()} ${issued.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · Print Pricer
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
