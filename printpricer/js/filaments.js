// Filament rows on the Estimate sheet — type/color, grams, $/kg per row.
// Supports linking to a saved Spool (auto-fills $/kg, shows color swatch),
// undoable row delete, and is the input source for cost calculation.

import { settings, filaments } from './state.js?v=25';
import { loadSpools } from './storage.js?v=25';
import { escapeHtml } from './utils.js?v=25';
import { recalc } from './calc.js?v=25';
import { toast, toastWithUndo, openPicker } from './ui.js?v=25';
import { LOW_STOCK_THRESHOLD } from './state.js?v=25';

export function newFilament() {
  return {
    name: '',
    grams: '',
    costPerKg: settings.filamentCost || '',
    spoolId: null,
  };
}

export function resetFilaments() {
  filaments.length = 0;
  filaments.push(newFilament());
}

export function setFilaments(arr) {
  filaments.length = 0;
  arr.forEach(f => filaments.push({ ...f }));
}

function findSpoolByName(name) {
  if (!name) return null;
  const target = name.trim().toLowerCase();
  if (!target) return null;
  return loadSpools().find(s => s.name.toLowerCase() === target) || null;
}

function updateSpoolDatalist() {
  const dl = document.getElementById('spool-list');
  if (!dl) return;
  const spools = loadSpools();
  dl.innerHTML = spools.map(s =>
    `<option value="${escapeHtml(s.name)}">${escapeHtml(s.material || '')} · $${(+s.costPerKg).toFixed(2)}/kg · ${s.remainingGrams}g left</option>`
  ).join('');
}

export function renderFilaments() {
  updateSpoolDatalist();
  const container = document.getElementById('filaments');
  if (!container) return;
  container.innerHTML = '';
  filaments.forEach((f, i) => {
    const linkedSpool = f.spoolId ? loadSpools().find(s => s.id === f.spoolId) : null;
    const swatch = linkedSpool && linkedSpool.color
      ? `<span class="filament-swatch" style="background:${escapeHtml(linkedSpool.color)}"></span>`
      : '';
    const linkTag = linkedSpool
      ? `<span class="spool-link-tag">linked: ${escapeHtml(linkedSpool.name)}</span>`
      : '';
    const row = document.createElement('div');
    row.className = 'filament-row';
    row.innerHTML = `
      <div class="field field-with-pick">
        ${i === 0 ? '<label>Type / color</label>' : ''}
        <div class="filament-name-line">
          ${swatch}
          <input type="text" list="spool-list" placeholder="PLA black" value="${escapeHtml(f.name)}" data-i="${i}" data-k="name">
          <button type="button" class="pick-spool-btn" data-pick="${i}" data-hint="Pick a saved spool to auto-fill cost, link inventory, and show the swatch.">▾ PICK</button>
        </div>
        ${linkTag}
      </div>
      <div class="field">
        ${i === 0 ? '<label>Grams</label>' : ''}
        <input type="number" min="0" step="0.1" placeholder="0" value="${f.grams}" data-i="${i}" data-k="grams">
      </div>
      <div class="field">
        ${i === 0 ? '<label>$/kg</label>' : ''}
        <input type="number" min="0" step="0.01" placeholder="${settings.filamentCost || '25'}" value="${f.costPerKg}" data-i="${i}" data-k="costPerKg">
      </div>
      <button class="icon-btn" data-remove="${i}" title="Remove" ${filaments.length === 1 ? 'style="visibility:hidden"' : ''}>×</button>
    `;
    container.appendChild(row);
  });
  container.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const i = +e.target.dataset.i;
      const k = e.target.dataset.k;
      filaments[i][k] = e.target.value;
      if (k === 'name') {
        const match = findSpoolByName(e.target.value);
        if (match) {
          filaments[i].spoolId = match.id;
          filaments[i].costPerKg = String(match.costPerKg);
          renderFilaments();
        } else {
          filaments[i].spoolId = null;
        }
      }
      recalc();
    });
  });
  container.querySelectorAll('[data-pick]').forEach(btn => {
    btn.addEventListener('click', e => openSpoolPicker(+e.target.dataset.pick));
  });
  container.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      const i = +e.target.dataset.remove;
      removeFilamentWithUndo(i);
    });
  });
}

function removeFilamentWithUndo(i) {
  const removed = filaments[i];
  filaments.splice(i, 1);
  if (filaments.length === 0) filaments.push(newFilament());
  renderFilaments();
  recalc();
  toastWithUndo(`Removed filament row${removed.name ? ': ' + removed.name : ''}`, () => {
    filaments.splice(i, 0, removed);
    if (filaments.length > 1 && filaments[filaments.length - 1].name === '' && filaments[filaments.length - 1].grams === '') {
      // remove the auto-added empty row
      filaments.pop();
    }
    renderFilaments();
    recalc();
  });
}

function openSpoolPicker(filamentIndex) {
  const spools = loadSpools();
  const items = spools.map(s => {
    const isLow = s.remainingGrams < LOW_STOCK_THRESHOLD;
    return {
      swatchColor: s.color || 'var(--paper-dim)',
      name: s.name,
      meta: `${s.material || 'Other'} · ${s.remainingGrams}g left${isLow ? ' · low' : ''}`,
      costLabel: `$${(+s.costPerKg).toFixed(2)}/kg`,
      onPick: () => {
        const f = filaments[filamentIndex];
        f.spoolId = s.id;
        f.name = s.name;
        f.costPerKg = String(s.costPerKg);
        renderFilaments();
        recalc();
      },
    };
  });
  openPicker({
    title: 'Pick a Spool',
    items,
    emptyMessage: 'No spools yet. Add one in the Spools layer first.',
  });
}

export function initFilamentsUI() {
  document.getElementById('add-filament').addEventListener('click', () => {
    filaments.push(newFilament());
    renderFilaments();
    recalc();
  });
}
