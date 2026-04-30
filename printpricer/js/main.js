// Entry point: wire everything up after the DOM is ready.

import { settings, filaments, addons } from './state.js?v=30';
import { saveSettings } from './storage.js?v=30';
import { initTabs, onPaneShow, initPickerOverlay, toast } from './ui.js?v=30';
import { recalc, loadSettingsToForm, initStickyTotal } from './calc.js?v=30';
import { renderFilaments, resetFilaments, initFilamentsUI } from './filaments.js?v=30';
import { renderSpools, initSpoolsUI } from './spools.js?v=30';
import { renderPrinters, updateActivePrinterDisplay, migrateLegacySinglePrinter, initPrintersUI } from './printers.js?v=30';
import { renderHistory, initArchive } from './archive.js?v=30';
import { renderProducts, initProductsUI, saveEstimateAsProduct, printEstimate } from './products.js?v=30';
import { initAuthUI, updateAccountUI, renderGroupSection } from './auth-ui.js?v=30';
import { startAuthListener } from './firebase.js?v=30';
import { parseGcode, parse3mf } from './parser.js?v=30';
import { formatHours, escapeHtml, resizeImageToDataUrl } from './utils.js?v=30';
import { initOnboarding, maybeShowOnboarding } from './onboarding.js?v=30';
import { initHelp } from './help.js?v=30';

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

// ---- estimate sheet notes + target sell price ----
document.getElementById('print-notes')?.addEventListener('input', e => {
  addons.notes = e.target.value;
});
document.getElementById('print-target-price')?.addEventListener('input', e => {
  addons.sellPrice = e.target.value; recalc();
});

// ---- estimate sheet photos (multiple) ----
//
// addons.photos is the source of truth (array of JPEG data URLs).
// renderPhotos rebuilds the row of thumbnails + a trailing "+ ADD PHOTO"
// cell. Click on the add cell opens the (multi-select) file picker; click
// on a thumbnail's × removes that single photo.
const photoRow   = document.getElementById('photo-row');
const photoInput = document.getElementById('photo-input');

function renderPhotos() {
  if (!photoRow) return;
  const photos = Array.isArray(addons.photos) ? addons.photos : [];
  const total = photos.length;
  const cells = photos.map((src, i) => {
    const ariaLabel = i === 0
      ? `Primary photo (catalog thumbnail) — photo 1 of ${total}`
      : `Photo ${i + 1} of ${total}`;
    return `
    <div class="photo-cell${i === 0 ? ' is-primary' : ''}" data-i="${i}" draggable="true"
         role="listitem"
         aria-label="${ariaLabel}"
         ${i === 0 ? 'aria-current="true"' : ''}
         title="Drag to reorder, or use ←/→ buttons${i === 0 ? ' · this is the primary photo (catalog thumbnail)' : ''}">
      <img src="${escapeHtml(src)}" alt="">
      ${i === 0 ? '<span class="photo-primary-badge" aria-hidden="true">primary</span>' : ''}
      <span class="photo-remove-btn" data-photo-remove="${i}" role="button" tabindex="0" aria-label="Remove photo">×</span>
      <span class="photo-move-btn photo-move-left"  data-photo-move-left="${i}"  role="button" tabindex="0" aria-label="Move photo left"  ${i === 0         ? 'aria-disabled="true"' : ''}>←</span>
      <span class="photo-move-btn photo-move-right" data-photo-move-right="${i}" role="button" tabindex="0" aria-label="Move photo right" ${i === total - 1 ? 'aria-disabled="true"' : ''}>→</span>
    </div>
  `;
  }).join('');
  photoRow.innerHTML = cells + `
    <button type="button" class="photo-add" id="photo-add-btn" aria-label="Add photo">+ ADD<br>PHOTO</button>
  `;
  // Set role="list" on the container so the photo-cell listitems are announced as a group
  photoRow.setAttribute('role', 'list');
}
// Other modules (archive load, product load, reset) replace addons.photos
// and dispatch this event to refresh the preview.
document.addEventListener('photo:render', renderPhotos);

// Delegated click handler — covers the +Add button, per-photo × remove,
// and the ←/→ reorder buttons. Stays valid across re-renders.
function movePhoto(fromIdx, toIdx) {
  if (!Array.isArray(addons.photos)) return;
  if (toIdx < 0 || toIdx >= addons.photos.length) return;
  const [moved] = addons.photos.splice(fromIdx, 1);
  addons.photos.splice(toIdx, 0, moved);
  renderPhotos();
}
photoRow?.addEventListener('click', e => {
  const removeBtn = e.target.closest('[data-photo-remove]');
  if (removeBtn) {
    e.stopPropagation();
    const i = +removeBtn.dataset.photoRemove;
    if (Array.isArray(addons.photos)) {
      addons.photos.splice(i, 1);
      renderPhotos();
    }
    return;
  }
  const moveLeft = e.target.closest('[data-photo-move-left]');
  if (moveLeft && moveLeft.getAttribute('aria-disabled') !== 'true') {
    e.stopPropagation();
    const i = +moveLeft.dataset.photoMoveLeft;
    movePhoto(i, i - 1);
    return;
  }
  const moveRight = e.target.closest('[data-photo-move-right]');
  if (moveRight && moveRight.getAttribute('aria-disabled') !== 'true') {
    e.stopPropagation();
    const i = +moveRight.dataset.photoMoveRight;
    movePhoto(i, i + 1);
    return;
  }
  if (e.target.closest('#photo-add-btn')) {
    photoInput?.click();
  }
});
// Keyboard activation for the role="button" spans (×, ←, →) — Enter/Space
// triggers the same flow as click since these aren't real <button>s.
photoRow?.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (!e.target.closest('[data-photo-remove], [data-photo-move-left], [data-photo-move-right]')) return;
  e.preventDefault();
  e.target.click();
});

photoInput?.addEventListener('change', async e => {
  const files = Array.from(e.target.files || []);
  e.target.value = ''; // allow re-selecting the same file(s)
  if (!files.length) return;
  if (!Array.isArray(addons.photos)) addons.photos = [];
  for (const file of files) {
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      addons.photos.push(dataUrl);
    } catch (err) {
      toast(err.message || `Could not load ${file.name}`, true);
    }
  }
  renderPhotos();
});

// Drag-and-drop reorder. The first photo in the array is the "primary"
// (used as the catalog thumbnail). Reordering = changing which photo
// is first. Delegated handlers stay valid across re-renders.
let dragFromIdx = null;
photoRow?.addEventListener('dragstart', e => {
  // Don't initiate a drag when the user is grabbing one of the small
  // overlay buttons (×, ←, →). They're inside .photo-cell but should
  // behave as buttons, not as drag handles.
  if (e.target.closest('[data-photo-remove], [data-photo-move-left], [data-photo-move-right]')) {
    e.preventDefault();
    return;
  }
  const cell = e.target.closest('.photo-cell');
  if (!cell) return;
  dragFromIdx = +cell.dataset.i;
  cell.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Setting any data is required for drag to actually start in some browsers
  try { e.dataTransfer.setData('text/plain', String(dragFromIdx)); } catch {}
});
photoRow?.addEventListener('dragend', e => {
  const cell = e.target.closest('.photo-cell');
  if (cell) cell.classList.remove('dragging');
  // Clear lingering drag-over highlight on every cell
  photoRow.querySelectorAll('.photo-cell.drag-over').forEach(c => c.classList.remove('drag-over'));
  dragFromIdx = null;
});
photoRow?.addEventListener('dragover', e => {
  const cell = e.target.closest('.photo-cell');
  if (!cell || dragFromIdx === null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  // Highlight only the hovered drop target
  photoRow.querySelectorAll('.photo-cell.drag-over').forEach(c => {
    if (c !== cell) c.classList.remove('drag-over');
  });
  if (+cell.dataset.i !== dragFromIdx) cell.classList.add('drag-over');
});
photoRow?.addEventListener('dragleave', e => {
  const cell = e.target.closest('.photo-cell');
  if (cell) cell.classList.remove('drag-over');
});
photoRow?.addEventListener('drop', e => {
  e.preventDefault();
  const cell = e.target.closest('.photo-cell');
  if (!cell || dragFromIdx === null) return;
  const toIdx = +cell.dataset.i;
  if (toIdx === dragFromIdx) return;
  if (!Array.isArray(addons.photos)) return;
  const [moved] = addons.photos.splice(dragFromIdx, 1);
  addons.photos.splice(toIdx, 0, moved);
  dragFromIdx = null;
  renderPhotos();
});

// Initial render so the "+ ADD PHOTO" cell is visible on first paint.
renderPhotos();

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

// ---- BOM rows (estimate sheet) ----
//
// addons.bom is the source of truth. Render builds the DOM from it; input
// events update specific entries; +/× buttons add/remove. Keep DOM and
// state in lockstep so cloud syncs and product loads can fully replace
// addons.bom and dispatch a 'bom:render' event to refresh the UI.

// Collapse the BOM block when there are no items. Once the user adds even
// one item the full block reveals; if they later remove every row the block
// re-collapses (a clean default for the common one-off-quote case).
function updateBomCollapseState() {
  const block = document.querySelector('.bom-block');
  if (!block) return;
  const isEmpty = !addons.bom || addons.bom.length === 0;
  block.classList.toggle('collapsed', isEmpty);
}

function renderBomRows() {
  const wrap = document.getElementById('bom-rows');
  if (!wrap) return;
  updateBomCollapseState();
  if (!addons.bom || addons.bom.length === 0) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = addons.bom.map((b, i) => `
    <div class="bom-row" data-i="${i}">
      <input type="text"   placeholder="M3 screw"  value="${escapeHtml(b.name || '')}" data-bom-k="name">
      <input type="number" placeholder="qty"       min="0" step="1"    value="${b.qty || ''}"      data-bom-k="qty">
      <input type="number" placeholder="unit $"    min="0" step="0.01" value="${b.unitCost || ''}" data-bom-k="unitCost">
      <button type="button" class="icon-btn" data-bom-remove="${i}" aria-label="Remove">×</button>
    </div>
  `).join('');
}

function wireBomEvents() {
  const wrap = document.getElementById('bom-rows');
  if (!wrap) return;
  // Delegated input — pick up changes to any field on any row.
  wrap.addEventListener('input', e => {
    const row = e.target.closest('.bom-row');
    if (!row) return;
    const i = +row.dataset.i;
    const k = e.target.dataset.bomK;
    if (!k || !addons.bom[i]) return;
    addons.bom[i][k] = e.target.value;
    recalc();
  });
  // Delegated remove button.
  wrap.addEventListener('click', e => {
    const btn = e.target.closest('[data-bom-remove]');
    if (!btn) return;
    const i = +btn.dataset.bomRemove;
    addons.bom.splice(i, 1);
    renderBomRows();
    recalc();
  });
}

function addBomRowAndFocus() {
  if (!Array.isArray(addons.bom)) addons.bom = [];
  addons.bom.push({ name: '', qty: '', unitCost: '' });
  renderBomRows();
  // Focus the new row's first input
  const wrap = document.getElementById('bom-rows');
  const last = wrap?.querySelector('.bom-row:last-child input[data-bom-k="name"]');
  last?.focus();
  recalc();
}
// "+ Add item" inside the expanded block
document.getElementById('add-bom-row')?.addEventListener('click', addBomRowAndFocus);
// "+ Add hardware" CTA shown when block is collapsed (empty BOM)
document.getElementById('bom-expand-btn')?.addEventListener('click', addBomRowAndFocus);

// Other modules (products.js loadProductIntoEstimate, archive.js applyEntryToSheet)
// fully replace addons.bom and dispatch this event to trigger a re-render.
document.addEventListener('bom:render', renderBomRows);

wireBomEvents();
renderBomRows();

// ---- save-as-product / update-product buttons ----
document.getElementById('save-as-product')?.addEventListener('click', () => {
  saveEstimateAsProduct({ asNew: true });
});
document.getElementById('update-product')?.addEventListener('click', () => {
  saveEstimateAsProduct({ asNew: false });
});
document.getElementById('print-estimate')?.addEventListener('click', () => {
  printEstimate();
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
