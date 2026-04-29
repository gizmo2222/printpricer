// Spools layer: filament inventory CRUD with refill history.
//
// Each spool now also keeps a refillHistory array — { date, grams, op } —
// recording every refill action so users can audit consumption later.

import { settings, MATERIALS, LOW_STOCK_THRESHOLD } from './state.js?v=14';
import { loadSpools, saveSpools, loadHistory } from './storage.js?v=14';
import { escapeHtml } from './utils.js?v=14';
import { toast } from './ui.js?v=14';
import { renderFilaments } from './filaments.js?v=14';
import { logActivity } from './firebase.js?v=14';

let editingSpoolId = null;
let isAddingSpool = false;

export function renderSpools() {
  const container = document.getElementById('spools-grid');
  const count = document.getElementById('spool-count');
  const formContainer = document.getElementById('spool-form-container');
  if (!container) return;
  const spools = loadSpools();

  const total = spools.length;
  const lowCount = spools.filter(s => s.remainingGrams < LOW_STOCK_THRESHOLD).length;
  count.innerHTML = total === 0
    ? 'No spools tracked yet'
    : `<strong>${total}</strong> spool${total !== 1 ? 's' : ''} on hand` +
      (lowCount ? ` · <span style="color:var(--rust)">${lowCount} low</span>` : '');

  const callout = document.getElementById('block-detail-spools');
  if (callout) {
    if (total > 0) {
      callout.classList.add('active-info');
      const totalGrams = spools.reduce((s, sp) => s + (+sp.remainingGrams || 0), 0);
      callout.innerHTML = `${total} · ${(totalGrams / 1000).toFixed(2)} KG${lowCount ? ` · ${lowCount} LOW` : ''}<span class="id">A</span>`;
    } else {
      callout.classList.remove('active-info');
      callout.innerHTML = `Filament library<span class="id">A</span>`;
    }
  }

  formContainer.innerHTML = '';
  if (isAddingSpool || editingSpoolId !== null) {
    const editing = editingSpoolId !== null ? spools.find(s => s.id === editingSpoolId) : null;
    formContainer.appendChild(buildSpoolForm(editing));
  }

  container.innerHTML = '';
  if (spools.length === 0 && !isAddingSpool && editingSpoolId === null) {
    container.innerHTML = '<div class="empty"><strong>Empty inventory</strong>Add a spool to start tracking what you have on hand. Estimated prints will deduct from these spools when archived.</div>';
    return;
  }

  spools.forEach(s => {
    const pct = s.spoolGrams > 0 ? Math.max(0, Math.min(100, (s.remainingGrams / s.spoolGrams) * 100)) : 0;
    const isLow = s.remainingGrams < LOW_STOCK_THRESHOLD;
    const isEditing = s.id === editingSpoolId;
    const forecast = forecastSpoolDays(s);
    const item = document.createElement('div');
    item.className = 'spool-item' + (isEditing ? ' editing' : '');
    item.innerHTML = `
      <div class="spool-swatch" style="background: ${escapeHtml(s.color || '#e7decd')}"></div>
      <div class="spool-info">
        <div class="spool-name"></div>
        <div class="spool-meta">
          <span class="material-badge"></span>
          <span class="spool-meta-grams"></span>
          <span class="spool-meta-notes"></span>
        </div>
        <div class="spool-stock">
          <div class="stock-bar ${isLow ? 'low' : ''}"><div class="fill" style="width: ${pct.toFixed(1)}%"></div></div>
          <div class="stock-amount">
            <strong style="color:var(--ink);font-weight:600">${s.remainingGrams}g</strong>
            <span>/ ${s.spoolGrams}g remaining</span>
            ${isLow ? '<span class="low-tag">· low</span>' : ''}
            ${forecast ? `<span class="forecast">${forecast}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="spool-actions">
        <div class="spool-cost">$${(+s.costPerKg).toFixed(2)}<span class="unit">/ kg</span></div>
        <div class="actions-row">
          <button class="link-btn" data-edit="${s.id}">Edit</button>
          <button class="link-btn danger" data-del-spool="${s.id}">Delete</button>
        </div>
      </div>
    `;
    item.querySelector('.spool-name').textContent = s.name;
    item.querySelector('.material-badge').textContent = s.material || 'Other';
    item.querySelector('.spool-meta-grams').textContent = `${s.spoolGrams}g spool`;
    if (s.notes) item.querySelector('.spool-meta-notes').textContent = `· ${s.notes}`;
    container.appendChild(item);
  });

  container.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', e => {
      editingSpoolId = +e.target.dataset.edit;
      isAddingSpool = false;
      renderSpools();
    });
  });
  container.querySelectorAll('[data-del-spool]').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = +e.target.dataset.delSpool;
      const sp = loadSpools().find(s => s.id === id);
      if (!confirm(`Delete spool "${sp?.name || ''}"?`)) return;
      saveSpools(loadSpools().filter(s => s.id !== id));
      renderSpools();
      renderFilaments();
      logActivity(`deleted spool "${sp?.name || ''}"`);
    });
  });
}

// Predict how soon a spool runs out, based on the average grams per day
// from the user's archive over the last 30 days.
function forecastSpoolDays(spool) {
  const history = loadHistory();
  if (!history.length || spool.remainingGrams <= 0) return null;
  const cutoff = Date.now() - 30 * 86400 * 1000;
  let gramsForThisSpool = 0;
  let earliest = Infinity;
  history.forEach(entry => {
    const ts = entry.id || 0;
    if (ts < cutoff) return;
    earliest = Math.min(earliest, ts);
    (entry.filaments || []).forEach(f => {
      if (f.spoolId === spool.id) {
        gramsForThisSpool += +f.grams || 0;
      }
    });
  });
  if (gramsForThisSpool < 1) return null;
  const span = Math.max(1, (Date.now() - earliest) / 86400000);
  const ratePerDay = gramsForThisSpool / span;
  if (ratePerDay < 0.1) return null;
  const daysLeft = Math.round(spool.remainingGrams / ratePerDay);
  if (daysLeft < 1) return '· runs out today';
  if (daysLeft < 365) return `· ~${daysLeft}d at current use`;
  return null;
}

function buildSpoolForm(editing) {
  const wrap = document.createElement('div');
  wrap.className = 'spool-form' + (editing ? '' : ' adding');
  const s = editing || { name: '', material: 'PLA', color: '#222222', costPerKg: settings.filamentCost || '25', spoolGrams: 1000, remainingGrams: 1000, notes: '' };
  const refillCount = (editing?.refillHistory || []).length;
  wrap.innerHTML = `
    <div class="spool-form-row" style="grid-template-columns: 2fr 1fr 60px;">
      <div class="field">
        <label>Spool name</label>
        <input type="text" id="sf-name" placeholder="Polymaker PLA Pro Black" value="${escapeHtml(s.name)}">
      </div>
      <div class="field">
        <label>Material</label>
        <select class="input" id="sf-material">
          ${MATERIALS.map(m => `<option ${m === s.material ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Color</label>
        <div class="color-input-wrap">
          <input type="color" id="sf-color" value="${escapeHtml(s.color || '#222222')}">
        </div>
      </div>
    </div>
    <div class="spool-form-row three">
      <div class="field">
        <label>Cost</label>
        <div class="suffix-wrap">
          <input type="number" id="sf-cost" min="0" step="0.01" value="${s.costPerKg}">
          <span class="suffix">$ / kg</span>
        </div>
      </div>
      <div class="field">
        <label>Spool weight</label>
        <div class="suffix-wrap">
          <input type="number" id="sf-spool-grams" min="0" step="1" value="${s.spoolGrams}">
          <span class="suffix">g</span>
        </div>
      </div>
      <div class="field">
        <label>Remaining</label>
        <div class="suffix-wrap">
          <input type="number" id="sf-remaining" min="0" step="0.1" value="${s.remainingGrams}">
          <span class="suffix">g</span>
        </div>
      </div>
    </div>
    <div class="field">
      <label>Notes</label>
      <input type="text" id="sf-notes" placeholder="optional — e.g. opened 2026-04, dry box A3" value="${escapeHtml(s.notes || '')}">
    </div>
    <div class="btn-row" style="margin-top: 12px;">
      <button class="btn" id="sf-save">${editing ? 'Save changes' : 'Add spool'}</button>
      <button class="btn btn-ghost" id="sf-cancel">Cancel</button>
      ${editing ? `<button class="btn btn-add" id="sf-refill" type="button" style="margin-left:auto">Refill to ${s.spoolGrams}g</button>` : ''}
      ${editing && refillCount ? `<button class="link-btn" id="sf-history" type="button">${refillCount} refill${refillCount !== 1 ? 's' : ''}</button>` : ''}
    </div>
    <div id="sf-history-panel" style="display:none; margin-top: 10px; padding-top: 10px; border-top: 1px dotted var(--ink-faint);">
      <div style="font-family: var(--condensed); font-size: 10px; font-weight: 700; letter-spacing: 1.6px; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 4px;">Refill history</div>
      <div id="sf-history-list"></div>
    </div>
  `;

  const spoolGramsInput = wrap.querySelector('#sf-spool-grams');
  const remainingInput  = wrap.querySelector('#sf-remaining');
  if (!editing) {
    spoolGramsInput.addEventListener('input', e => { remainingInput.value = e.target.value; });
  }
  wrap.querySelector('#sf-cancel').addEventListener('click', () => {
    editingSpoolId = null;
    isAddingSpool = false;
    renderSpools();
  });
  if (editing) {
    wrap.querySelector('#sf-refill').addEventListener('click', () => {
      remainingInput.value = spoolGramsInput.value;
    });
    if (refillCount) {
      wrap.querySelector('#sf-history').addEventListener('click', () => {
        const panel = wrap.querySelector('#sf-history-panel');
        const list = wrap.querySelector('#sf-history-list');
        if (panel.style.display === 'none') {
          panel.style.display = '';
          list.innerHTML = (editing.refillHistory || []).slice().reverse().map(h => {
            const d = new Date(h.date);
            return `<div style="font-family: var(--mono); font-size: 11px; color: var(--ink-mid); padding: 2px 0;">
              ${d.toLocaleDateString()} · ${h.op === 'refill' ? '+' : ''}${(+h.grams).toFixed(1)}g · → ${(+h.afterGrams).toFixed(1)}g${h.note ? ' · ' + escapeHtml(h.note) : ''}
            </div>`;
          }).join('') || '<em>No refills logged.</em>';
        } else {
          panel.style.display = 'none';
        }
      });
    }
  }

  wrap.querySelector('#sf-save').addEventListener('click', () => {
    const name = wrap.querySelector('#sf-name').value.trim();
    if (!name) { toast('Spool name required', true); return; }
    const newRemaining = +wrap.querySelector('#sf-remaining').value || 0;
    const data = {
      name,
      material:  wrap.querySelector('#sf-material').value,
      color:     wrap.querySelector('#sf-color').value,
      costPerKg: +wrap.querySelector('#sf-cost').value || 0,
      spoolGrams:    +wrap.querySelector('#sf-spool-grams').value || 1000,
      remainingGrams: newRemaining,
      notes:     wrap.querySelector('#sf-notes').value.trim(),
    };
    const all = loadSpools();
    if (editing) {
      const idx = all.findIndex(x => x.id === editing.id);
      if (idx !== -1) {
        // If remaining went UP, log a refill entry.
        const prevRemaining = +editing.remainingGrams || 0;
        const delta = newRemaining - prevRemaining;
        const refillHistory = (editing.refillHistory || []).slice();
        if (delta > 1) {
          refillHistory.push({
            date: Date.now(),
            grams: delta,
            afterGrams: newRemaining,
            op: 'refill',
          });
        }
        all[idx] = { ...all[idx], ...data, refillHistory };
      }
      toast('Spool updated');
    } else {
      const newSpool = { id: Date.now(), ...data, refillHistory: [] };
      all.push(newSpool);
      toast('Spool added');
    }
    saveSpools(all);
    editingSpoolId = null;
    isAddingSpool = false;
    renderSpools();
    renderFilaments();
    logActivity(editing ? `updated spool "${name}"` : `added spool "${name}"`);
  });

  return wrap;
}

export function initSpoolsUI() {
  document.getElementById('spool-add-btn').addEventListener('click', () => {
    if (isAddingSpool) return;
    isAddingSpool = true;
    editingSpoolId = null;
    renderSpools();
  });
}
