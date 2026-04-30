// Products layer — saved estimate templates with optional bill-of-materials
// (BOM) for hardware/consumables.
//
// A product = a saved Estimate setup (description, time, filament rows,
// labor, packaging, optional shipping, default printer) plus a BOM array
// for the non-filament items in that product (screws, magnets, mailers,
// LEDs, etc.). Loading a product fills the Estimate sheet and adds the
// BOM cost into the Packaging field as a single line.
//
// MVP scope: each product is one estimate's worth of inputs. Multi-plate
// products (a "set" of N prints) is left for a future iteration —
// represent those for now as N separate products with a shared name prefix.

import { settings, filaments, addons } from './state.js?v=18';
import { loadProducts, saveProducts, loadPrinters, getActivePrinter, saveActivePrinterId } from './storage.js?v=18';
import { num, fmt, escapeHtml, formatHours } from './utils.js?v=18';
import { toast, switchToPane } from './ui.js?v=18';
import { setFilaments, newFilament, renderFilaments } from './filaments.js?v=18';
import { recalc } from './calc.js?v=18';
import { updateActivePrinterDisplay } from './printers.js?v=18';
import { logActivity } from './firebase.js?v=18';

let editingProductId = null;
let isAddingProduct = false;

// ---------- list view ----------

export function renderProducts() {
  const container = document.getElementById('products-grid');
  const count = document.getElementById('product-count');
  const formContainer = document.getElementById('product-form-container');
  if (!container) return;
  const products = loadProducts();

  // Earn the block-detail callout
  const callout = document.getElementById('block-detail-products');
  if (callout) {
    if (products.length > 0) {
      callout.classList.add('active-info');
      callout.innerHTML = `${products.length} · ${products.reduce((s,p) => s + (+p.sellPrice || 0), 0).toFixed(2)} CATALOG<span class="id">A</span>`;
    } else {
      callout.classList.remove('active-info');
      callout.innerHTML = `Saved templates<span class="id">A</span>`;
    }
  }

  count.innerHTML = products.length === 0
    ? 'No products saved yet'
    : `<strong>${products.length}</strong> product${products.length !== 1 ? 's' : ''} in catalog`;

  formContainer.innerHTML = '';
  if (isAddingProduct || editingProductId !== null) {
    const editing = editingProductId !== null
      ? products.find(p => String(p.id) === String(editingProductId)) : null;
    formContainer.appendChild(buildProductForm(editing));
  }

  container.innerHTML = '';
  if (products.length === 0 && !isAddingProduct && editingProductId === null) {
    container.innerHTML = '<div class="empty"><strong>No products yet</strong>A product is a saved estimate template — name + filament + time + add-ons + bill-of-materials. Save the current Estimate as a product, then re-quote it in one click. Useful for Etsy listings, repeat commissions, or any model you print more than once.</div>';
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
          <button class="link-btn" data-quote-product="${escapeHtml(String(p.id))}">Quote</button>
          <button class="link-btn" data-edit-product="${escapeHtml(String(p.id))}">Edit</button>
          <button class="link-btn danger" data-del-product="${escapeHtml(String(p.id))}">Delete</button>
        </div>
      </div>
    `;
    item.querySelector('.spool-name').textContent = p.name;
    container.appendChild(item);
  });

  container.querySelectorAll('[data-quote-product]').forEach(btn => {
    btn.addEventListener('click', e => quoteProduct(e.target.dataset.quoteProduct));
  });
  container.querySelectorAll('[data-edit-product]').forEach(btn => {
    btn.addEventListener('click', e => {
      editingProductId = e.target.dataset.editProduct;
      isAddingProduct = false;
      renderProducts();
    });
  });
  container.querySelectorAll('[data-del-product]').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.target.dataset.delProduct;
      const p = loadProducts().find(x => String(x.id) === String(id));
      if (!confirm(`Delete product "${p?.name || ''}"?`)) return;
      saveProducts(loadProducts().filter(x => String(x.id) !== String(id)));
      renderProducts();
      logActivity(`deleted product "${p?.name || ''}"`);
    });
  });
}

// ---------- form ----------

function buildProductForm(editing) {
  const wrap = document.createElement('div');
  wrap.className = 'spool-form' + (editing ? '' : ' adding');
  const p = editing || {
    name: '',
    notes: '',
    sellPrice: '',
    hours: 0,
    filaments: [{ name: '', grams: '', costPerKg: '' }],
    printerId: '',
    laborMinutes: '',
    packagingCost: '',
    shippingCost: '',
    bom: [],
  };

  const printers = loadPrinters();
  const printerOptions = '<option value="">— Use active printer —</option>' +
    printers.map(pp => `<option value="${escapeHtml(String(pp.id))}" ${String(pp.id) === String(p.printerId) ? 'selected' : ''}>${escapeHtml(pp.name)}</option>`).join('');

  const filRows = (p.filaments || []).map((f, i) => `
    <div class="product-fil-row" data-i="${i}">
      <input type="text" placeholder="PLA black" value="${escapeHtml(f.name || '')}" data-pf-k="name">
      <input type="number" placeholder="0" min="0" step="0.1" value="${f.grams || ''}" data-pf-k="grams">
      <input type="number" placeholder="25" min="0" step="0.01" value="${f.costPerKg || ''}" data-pf-k="costPerKg">
      <button type="button" class="icon-btn" data-pf-remove>×</button>
    </div>
  `).join('');

  const bomRows = (p.bom || []).map((b, i) => `
    <div class="product-bom-row" data-i="${i}">
      <input type="text" placeholder="M3 screw" value="${escapeHtml(b.name || '')}" data-pb-k="name">
      <input type="number" placeholder="qty" min="0" step="1" value="${b.qty || ''}" data-pb-k="qty">
      <input type="number" placeholder="unit $" min="0" step="0.01" value="${b.unitCost || ''}" data-pb-k="unitCost">
      <button type="button" class="icon-btn" data-pb-remove>×</button>
    </div>
  `).join('');

  wrap.innerHTML = `
    <div class="spool-form-row" style="grid-template-columns: 2fr 1fr;">
      <div class="field">
        <label>Product name</label>
        <input type="text" id="pf-name" placeholder="e.g. Articulated Dragon (small)" value="${escapeHtml(p.name)}">
      </div>
      <div class="field">
        <label>Target sell price</label>
        <div class="suffix-wrap">
          <input type="number" id="pf-sell" min="0" step="0.01" placeholder="0.00" value="${p.sellPrice || ''}">
          <span class="suffix">$</span>
        </div>
      </div>
    </div>

    <div class="field">
      <label>Notes</label>
      <input type="text" id="pf-notes" placeholder="optional — e.g. Etsy listing #3, set of 6" value="${escapeHtml(p.notes || '')}">
    </div>

    <div style="margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px dotted var(--ink-faint);">
      <div style="font-family: var(--condensed); font-size: var(--text-xxs); font-weight: var(--w-bold); letter-spacing: var(--track-caps); text-transform: uppercase; color: var(--ink-faint); margin-bottom: var(--space-2);">Print template</div>
      <div class="field">
        <label>Default printer</label>
        <select class="input" id="pf-printer">${printerOptions}</select>
      </div>
      <div class="input-row-3">
        <div class="field">
          <label>Print time (h)</label>
          <input type="number" id="pf-hours" min="0" step="0.01" value="${p.hours || ''}">
        </div>
        <div class="field">
          <label>Labor (min)</label>
          <input type="number" id="pf-labor" min="0" step="1" value="${p.laborMinutes || ''}">
        </div>
        <div class="field">
          <label>Packaging ($)</label>
          <input type="number" id="pf-packaging" min="0" step="0.01" value="${p.packagingCost || ''}">
        </div>
      </div>
      <div class="field">
        <label>Default shipping ($)</label>
        <input type="number" id="pf-shipping" min="0" step="0.01" placeholder="0.00 (passthrough)" value="${p.shippingCost || ''}">
      </div>
    </div>

    <div style="margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px dotted var(--ink-faint);">
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom: var(--space-2);">
        <span style="font-family: var(--condensed); font-size: var(--text-xxs); font-weight: var(--w-bold); letter-spacing: var(--track-caps); text-transform: uppercase; color: var(--ink-faint);">Filaments</span>
        <button type="button" class="btn btn-add" id="pf-add-fil" style="padding: 2px 8px; font-size: var(--text-xxs);">+ Add</button>
      </div>
      <div class="product-fil-grid" id="pf-fils">${filRows}</div>
    </div>

    <div style="margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px dotted var(--ink-faint);">
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom: var(--space-2);">
        <span style="font-family: var(--condensed); font-size: var(--text-xxs); font-weight: var(--w-bold); letter-spacing: var(--track-caps); text-transform: uppercase; color: var(--ink-faint);">Bill of materials (hardware / consumables)</span>
        <button type="button" class="btn btn-add" id="pf-add-bom" style="padding: 2px 8px; font-size: var(--text-xxs);">+ Add</button>
      </div>
      <p style="font-family: var(--sans); font-size: var(--text-xs); color: var(--ink-faint); line-height: 1.5; margin-bottom: var(--space-2);">
        Hardware, magnets, screws, mailers — anything the listing includes that isn't filament. Cost auto-rolls into the estimate's Packaging line when you Quote this product.
      </p>
      <div class="product-bom-grid" id="pf-bom">${bomRows}</div>
    </div>

    <div class="btn-row" style="margin-top: var(--space-4);">
      <button class="btn" id="pf-save">${editing ? 'Save changes' : 'Add product'}</button>
      <button class="btn btn-ghost" id="pf-cancel">Cancel</button>
    </div>
  `;

  // Cancel
  wrap.querySelector('#pf-cancel').addEventListener('click', () => {
    editingProductId = null;
    isAddingProduct = false;
    renderProducts();
  });

  // Add filament row
  wrap.querySelector('#pf-add-fil').addEventListener('click', () => {
    const grid = wrap.querySelector('#pf-fils');
    const i = grid.children.length;
    const div = document.createElement('div');
    div.className = 'product-fil-row';
    div.dataset.i = String(i);
    div.innerHTML = `
      <input type="text" placeholder="PLA black" value="" data-pf-k="name">
      <input type="number" placeholder="0" min="0" step="0.1" value="" data-pf-k="grams">
      <input type="number" placeholder="25" min="0" step="0.01" value="" data-pf-k="costPerKg">
      <button type="button" class="icon-btn" data-pf-remove>×</button>
    `;
    grid.appendChild(div);
  });
  wrap.querySelector('#pf-fils').addEventListener('click', e => {
    if (e.target.dataset.pfRemove !== undefined || e.target.closest('[data-pf-remove]')) {
      e.target.closest('.product-fil-row')?.remove();
    }
  });

  // Add BOM row
  wrap.querySelector('#pf-add-bom').addEventListener('click', () => {
    const grid = wrap.querySelector('#pf-bom');
    const i = grid.children.length;
    const div = document.createElement('div');
    div.className = 'product-bom-row';
    div.dataset.i = String(i);
    div.innerHTML = `
      <input type="text" placeholder="M3 screw" value="" data-pb-k="name">
      <input type="number" placeholder="qty" min="0" step="1" value="" data-pb-k="qty">
      <input type="number" placeholder="unit $" min="0" step="0.01" value="" data-pb-k="unitCost">
      <button type="button" class="icon-btn" data-pb-remove>×</button>
    `;
    grid.appendChild(div);
  });
  wrap.querySelector('#pf-bom').addEventListener('click', e => {
    if (e.target.dataset.pbRemove !== undefined || e.target.closest('[data-pb-remove]')) {
      e.target.closest('.product-bom-row')?.remove();
    }
  });

  // Save
  wrap.querySelector('#pf-save').addEventListener('click', () => {
    const name = wrap.querySelector('#pf-name').value.trim();
    if (!name) { toast('Product name required', true); return; }
    const fils = [...wrap.querySelectorAll('.product-fil-row')].map(row => ({
      name:      row.querySelector('[data-pf-k="name"]').value,
      grams:     row.querySelector('[data-pf-k="grams"]').value,
      costPerKg: row.querySelector('[data-pf-k="costPerKg"]').value,
    })).filter(f => f.name || f.grams);
    const bom = [...wrap.querySelectorAll('.product-bom-row')].map(row => ({
      name:     row.querySelector('[data-pb-k="name"]').value,
      qty:      row.querySelector('[data-pb-k="qty"]').value,
      unitCost: row.querySelector('[data-pb-k="unitCost"]').value,
    })).filter(b => b.name);
    const data = {
      name,
      notes:      wrap.querySelector('#pf-notes').value,
      sellPrice:  wrap.querySelector('#pf-sell').value,
      printerId:  wrap.querySelector('#pf-printer').value,
      hours:      +wrap.querySelector('#pf-hours').value || 0,
      laborMinutes:  wrap.querySelector('#pf-labor').value,
      packagingCost: wrap.querySelector('#pf-packaging').value,
      shippingCost:  wrap.querySelector('#pf-shipping').value,
      filaments: fils,
      bom,
    };
    const all = loadProducts();
    if (editing) {
      const idx = all.findIndex(x => String(x.id) === String(editing.id));
      if (idx !== -1) all[idx] = { ...all[idx], ...data };
      toast('Product updated');
    } else {
      all.push({ id: Date.now(), ...data });
      toast('Product added');
    }
    saveProducts(all);
    editingProductId = null;
    isAddingProduct = false;
    renderProducts();
    logActivity(editing ? `updated product "${name}"` : `added product "${name}"`);
  });

  return wrap;
}

// ---------- quote a product → load into Estimate ----------

function quoteProduct(id) {
  const p = loadProducts().find(x => String(x.id) === String(id));
  if (!p) return;

  // Description (with "(copy)" suffix? Don't — user wants the product name as-is)
  document.getElementById('print-name').value = p.name;

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

  // Add-ons. BOM total folds into Packaging.
  const bomTotal = (p.bom || []).reduce((s, b) => s + (num(b.qty) * num(b.unitCost)), 0);
  const baseListPackaging = num(p.packagingCost);
  const totalPackaging = baseListPackaging + bomTotal;

  addons.laborMinutes  = p.laborMinutes  != null ? String(p.laborMinutes)  : '';
  addons.packagingCost = totalPackaging > 0 ? totalPackaging.toFixed(2) : '';
  addons.shippingCost  = p.shippingCost  != null ? String(p.shippingCost)  : '';
  document.getElementById('addon-labor').value     = addons.laborMinutes;
  document.getElementById('addon-packaging').value = addons.packagingCost;
  document.getElementById('addon-shipping').value  = addons.shippingCost;

  recalc();
  switchToPane('calc');
  const bomNote = bomTotal > 0 ? ` · BOM $${bomTotal.toFixed(2)} folded into packaging` : '';
  toast(`Quoting "${p.name}"${bomNote}`);
}

// ---------- save current Estimate as a product ----------

export function saveEstimateAsProduct() {
  const name = document.getElementById('print-name').value.trim();
  if (!name) { toast('Enter a description first — that becomes the product name', true); return; }
  const printer = getActivePrinter();
  const product = {
    id: Date.now(),
    name,
    notes: '',
    sellPrice: '',
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
    bom: [],
  };
  const all = loadProducts();
  all.push(product);
  saveProducts(all);
  toast(`Saved as product · "${name}"`);
  logActivity(`saved product "${name}"`);
}

export function initProductsUI() {
  document.getElementById('product-add-btn')?.addEventListener('click', () => {
    if (isAddingProduct) return;
    isAddingProduct = true;
    editingProductId = null;
    renderProducts();
  });
  document.getElementById('save-as-product')?.addEventListener('click', saveEstimateAsProduct);
}
