// Printers layer + active-printer picker on the Estimate sheet.
//
// Each printer has its own wattage, hourly rate, throughput (g/hr), and
// multi-color overhead percent. Active selection is per-device (not synced).
// On delete, if the deleted printer was active, the next remaining printer
// becomes active automatically.

import { settings, PRINTER_PRESETS, PRINTERS_KEY, ACTIVE_PRINTER_KEY } from './state.js?v=15';
import { loadPrinters, savePrinters, loadActivePrinterId, saveActivePrinterId, getActivePrinter } from './storage.js?v=15';
import { escapeHtml } from './utils.js?v=15';
import { toast, openPicker } from './ui.js?v=15';
import { recalc } from './calc.js?v=15';
import { logActivity } from './firebase.js?v=15';

let editingPrinterId = null;
let isAddingPrinter = false;

export function migrateLegacySinglePrinter() {
  if (loadPrinters().length > 0) return;
  const hasLegacy = settings.watts || settings.hourlyRate
    || settings.estGramsPerHour || settings.estSwapPct
    || settings.printerPreset;
  if (!hasLegacy) return;
  const newPrinter = {
    id: Date.now(),
    name: 'My Printer',
    preset: settings.printerPreset || '',
    watts: settings.watts || '',
    hourlyRate: settings.hourlyRate || '',
    gramsPerHour: settings.estGramsPerHour || '',
    swapPct: settings.estSwapPct || '',
  };
  localStorage.setItem(PRINTERS_KEY, JSON.stringify([newPrinter]));
  saveActivePrinterId(newPrinter.id);
}

export function updateActivePrinterDisplay() {
  const display = document.getElementById('active-printer-display');
  const meta = document.getElementById('active-printer-meta');
  if (!display) return;
  const p = getActivePrinter();
  if (p) {
    display.textContent = p.name;
    display.classList.remove('empty');
    const bits = [];
    if (p.watts) bits.push(`${p.watts} W`);
    if (p.hourlyRate) bits.push(`$${(+p.hourlyRate).toFixed(2)}/hr`);
    if (p.gramsPerHour) bits.push(`${p.gramsPerHour} g/hr`);
    if (p.swapPct) bits.push(`${p.swapPct}%/color`);
    meta.textContent = bits.join(' · ');
  } else {
    display.textContent = '— none selected —';
    display.classList.add('empty');
    meta.textContent = loadPrinters().length === 0
      ? 'Add a printer in layer 03 first.'
      : 'Pick a printer to use its rates.';
  }
}

export function renderPrinters() {
  const container = document.getElementById('printers-grid');
  const count = document.getElementById('printer-count');
  const formContainer = document.getElementById('printer-form-container');
  if (!container) return;
  const printers = loadPrinters();
  const activeId = loadActivePrinterId();

  count.innerHTML = printers.length === 0
    ? 'No printers configured yet'
    : `<strong>${printers.length}</strong> printer${printers.length !== 1 ? 's' : ''} in workshop`;

  const callout = document.getElementById('block-detail-printers');
  if (callout) {
    if (printers.length > 0) {
      const active = printers.find(p => String(p.id) === String(activeId));
      callout.classList.add('active-info');
      callout.innerHTML = active
        ? `${active.name.toUpperCase()} ACTIVE<span class="id">A</span>`
        : `${printers.length} · NONE ACTIVE<span class="id">A</span>`;
    } else {
      callout.classList.remove('active-info');
      callout.innerHTML = `Workshop fleet<span class="id">A</span>`;
    }
  }

  formContainer.innerHTML = '';
  if (isAddingPrinter || editingPrinterId !== null) {
    const editing = editingPrinterId !== null
      ? printers.find(p => String(p.id) === String(editingPrinterId)) : null;
    formContainer.appendChild(buildPrinterForm(editing));
  }

  container.innerHTML = '';
  if (printers.length === 0 && !isAddingPrinter && editingPrinterId === null) {
    container.innerHTML = '<div class="empty"><strong>No printers yet</strong>Add a printer to start estimating prints. Each printer has its own wattage, hourly rate, throughput, and multi-color overhead.</div>';
    return;
  }

  printers.forEach(p => {
    const isActive = String(p.id) === String(activeId);
    const isEditing = String(p.id) === String(editingPrinterId);
    const item = document.createElement('div');
    item.className = 'spool-item' + (isEditing ? ' editing' : '');
    item.innerHTML = `
      <div class="spool-swatch" style="background: ${isActive ? 'var(--blueprint)' : 'var(--paper-dim)'}"></div>
      <div class="spool-info">
        <div class="spool-name"></div>
        <div class="spool-meta">
          ${p.preset ? '<span class="material-badge"></span>' : ''}
          ${p.watts ? `<span>${p.watts} W</span>` : ''}
          ${p.hourlyRate ? `<span>· $${(+p.hourlyRate).toFixed(2)}/hr</span>` : ''}
          ${p.gramsPerHour ? `<span>· ${p.gramsPerHour} g/hr</span>` : ''}
          ${p.swapPct ? `<span>· ${p.swapPct}%/color</span>` : ''}
        </div>
      </div>
      <div class="spool-actions">
        <div class="actions-row">
          ${isActive ? '' : `<button class="link-btn" data-set-active="${escapeHtml(String(p.id))}">Set active</button>`}
          <button class="link-btn" data-edit-printer="${escapeHtml(String(p.id))}">Edit</button>
          <button class="link-btn danger" data-del-printer="${escapeHtml(String(p.id))}">Delete</button>
        </div>
      </div>
    `;
    item.querySelector('.spool-name').innerHTML = escapeHtml(p.name) + (isActive
      ? '<span style="font-family:var(--condensed);font-size:9px;letter-spacing:1.4px;color:var(--blueprint);margin-left:8px;font-weight:700;">· ACTIVE</span>'
      : '');
    if (p.preset) item.querySelector('.material-badge').textContent = p.preset.replace('|', ' ');
    container.appendChild(item);
  });

  container.querySelectorAll('[data-set-active]').forEach(btn => {
    btn.addEventListener('click', e => {
      saveActivePrinterId(e.target.dataset.setActive);
      renderPrinters();
      updateActivePrinterDisplay();
      recalc();
      toast('Active printer set');
    });
  });
  container.querySelectorAll('[data-edit-printer]').forEach(btn => {
    btn.addEventListener('click', e => {
      editingPrinterId = e.target.dataset.editPrinter;
      isAddingPrinter = false;
      renderPrinters();
    });
  });
  container.querySelectorAll('[data-del-printer]').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.target.dataset.delPrinter;
      const p = loadPrinters().find(x => String(x.id) === String(id));
      if (!confirm(`Delete printer "${p?.name || ''}"?`)) return;
      const remaining = loadPrinters().filter(x => String(x.id) !== String(id));
      const wasActive = String(loadActivePrinterId()) === String(id);
      savePrinters(remaining);
      if (wasActive) {
        // Auto-select the next printer if any.
        if (remaining.length > 0) {
          saveActivePrinterId(remaining[0].id);
          toast(`Active printer changed to ${remaining[0].name}`);
        } else {
          saveActivePrinterId(null);
        }
      }
      renderPrinters();
      updateActivePrinterDisplay();
      recalc();
      logActivity(`deleted printer "${p?.name || ''}"`);
    });
  });
}

function buildPrinterForm(editing) {
  const wrap = document.createElement('div');
  wrap.className = 'spool-form' + (editing ? '' : ' adding');
  const p = editing || { name: '', preset: '', watts: '', hourlyRate: '', gramsPerHour: '', swapPct: '' };
  let presetOptions = '<option value="">— Custom (no preset) —</option>';
  PRINTER_PRESETS.forEach(g => {
    presetOptions += `<optgroup label="${escapeHtml(g.group)}">`;
    g.items.forEach(item => {
      const v = `${g.group}|${item.name}`;
      presetOptions += `<option value="${escapeHtml(v)}" data-watts="${item.watts}" ${v === p.preset ? 'selected' : ''}>${escapeHtml(item.name)}${item.watts ? ` — ${item.watts}W` : ''}</option>`;
    });
    presetOptions += '</optgroup>';
  });
  wrap.innerHTML = `
    <div class="spool-form-row" style="grid-template-columns: 1fr 1.2fr;">
      <div class="field">
        <label>Name</label>
        <input type="text" id="pf-name" placeholder="e.g. X1 Carbon (workshop)" value="${escapeHtml(p.name)}">
      </div>
      <div class="field">
        <label>Preset (auto-fills wattage)</label>
        <select class="input" id="pf-preset">${presetOptions}</select>
      </div>
    </div>
    <div class="spool-form-row three">
      <div class="field">
        <label>Wattage</label>
        <div class="suffix-wrap">
          <input type="number" id="pf-watts" min="0" step="1" value="${p.watts}">
          <span class="suffix">W</span>
        </div>
      </div>
      <div class="field">
        <label>Hourly rate</label>
        <div class="suffix-wrap">
          <input type="number" id="pf-rate" min="0" step="0.01" value="${p.hourlyRate}">
          <span class="suffix">$ / hr</span>
        </div>
      </div>
      <div class="field">
        <label>Throughput</label>
        <div class="suffix-wrap">
          <input type="number" id="pf-gph" min="1" step="1" value="${p.gramsPerHour}" placeholder="18">
          <span class="suffix">g / hr</span>
        </div>
      </div>
    </div>
    <div class="field">
      <label>Multi-color overhead — added per extra filament beyond the first</label>
      <div class="suffix-wrap">
        <input type="number" id="pf-swap" min="0" max="200" step="1" value="${p.swapPct}" placeholder="25">
        <span class="suffix">% / color</span>
      </div>
    </div>
    <div class="btn-row" style="margin-top: 12px;">
      <button class="btn" id="pf-save">${editing ? 'Save changes' : 'Add printer'}</button>
      <button class="btn btn-ghost" id="pf-cancel">Cancel</button>
    </div>
  `;
  wrap.querySelector('#pf-preset').addEventListener('change', e => {
    const opt = e.target.selectedOptions[0];
    const w = +opt.dataset.watts;
    if (w > 0) wrap.querySelector('#pf-watts').value = w;
  });
  wrap.querySelector('#pf-cancel').addEventListener('click', () => {
    editingPrinterId = null;
    isAddingPrinter = false;
    renderPrinters();
  });
  wrap.querySelector('#pf-save').addEventListener('click', () => {
    const name = wrap.querySelector('#pf-name').value.trim();
    if (!name) { toast('Printer name required', true); return; }
    const data = {
      name,
      preset: wrap.querySelector('#pf-preset').value,
      watts: wrap.querySelector('#pf-watts').value,
      hourlyRate: wrap.querySelector('#pf-rate').value,
      gramsPerHour: wrap.querySelector('#pf-gph').value,
      swapPct: wrap.querySelector('#pf-swap').value,
    };
    const all = loadPrinters();
    if (editing) {
      const idx = all.findIndex(x => String(x.id) === String(editing.id));
      if (idx !== -1) all[idx] = { ...all[idx], ...data };
      toast('Printer updated');
    } else {
      const newP = { id: Date.now(), ...data };
      all.push(newP);
      if (!loadActivePrinterId()) saveActivePrinterId(newP.id);
      toast('Printer added');
    }
    savePrinters(all);
    editingPrinterId = null;
    isAddingPrinter = false;
    renderPrinters();
    updateActivePrinterDisplay();
    recalc();
    logActivity(editing ? `updated printer "${name}"` : `added printer "${name}"`);
  });
  return wrap;
}

export function initPrintersUI() {
  document.getElementById('printer-add-btn').addEventListener('click', () => {
    if (isAddingPrinter) return;
    isAddingPrinter = true;
    editingPrinterId = null;
    renderPrinters();
  });
  document.getElementById('pick-printer-btn').addEventListener('click', () => {
    const printers = loadPrinters();
    const activeId = loadActivePrinterId();
    const items = printers.map(p => {
      const isActive = String(p.id) === String(activeId);
      const meta = [
        p.watts ? `${p.watts} W` : '',
        p.hourlyRate ? `$${(+p.hourlyRate).toFixed(2)}/hr` : '',
        p.gramsPerHour ? `${p.gramsPerHour} g/hr` : ''
      ].filter(Boolean).join(' · ');
      return {
        swatchColor: isActive ? 'var(--blueprint)' : 'var(--paper-dim)',
        name: p.name,
        meta: meta || 'no rates set',
        accent: isActive,
        costLabel: isActive ? '✓' : '',
        onPick: () => {
          saveActivePrinterId(p.id);
          updateActivePrinterDisplay();
          recalc();
          toast(`Active: ${p.name}`);
        },
      };
    });
    openPicker({
      title: 'Pick a Printer',
      items,
      emptyMessage: 'Add a printer in layer 03 first.',
    });
  });
}
