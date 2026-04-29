// Archive (saved estimates) — list, load, clone, delete, CSV export, print.

import { settings, filaments } from './state.js';
import { loadHistory, saveHistory, loadSpools, saveSpools, getActivePrinter } from './storage.js';
import { LOW_STOCK_THRESHOLD } from './state.js';
import { num, fmt, escapeHtml, formatHours, toCsv, downloadFile } from './utils.js';
import { toast, toastWithUndo, switchToPane } from './ui.js';
import { markOnboardingComplete } from './onboarding.js';
import { renderFilaments, setFilaments, newFilament } from './filaments.js';
import { recalc } from './calc.js';
import { logActivity } from './firebase.js';

let saveQuoteInFlight = false; // double-tap guard
const FILTER_THRESHOLD = 10;
const filter = { search: '', month: '', sort: 'date-desc' };

function applyFilter(rows) {
  let out = rows.slice();
  const q = filter.search.trim().toLowerCase();
  if (q) out = out.filter(e => (e.name || '').toLowerCase().includes(q));
  if (filter.month) {
    out = out.filter(e => {
      const d = new Date(e.date);
      const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      return ym === filter.month;
    });
  }
  out.sort((a, b) => {
    if (filter.sort === 'date-asc')   return new Date(a.date) - new Date(b.date);
    if (filter.sort === 'total-desc') return (b.breakdown?.total || 0) - (a.breakdown?.total || 0);
    if (filter.sort === 'total-asc')  return (a.breakdown?.total || 0) - (b.breakdown?.total || 0);
    return new Date(b.date) - new Date(a.date); // default: date-desc
  });
  return out;
}

function rebuildMonthDropdown(allRows) {
  const sel = document.getElementById('archive-month');
  if (!sel) return;
  const months = new Set();
  allRows.forEach(e => {
    const d = new Date(e.date);
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    months.add(ym);
  });
  const sorted = [...months].sort().reverse();
  const current = filter.month;
  sel.innerHTML = '<option value="">All months</option>' + sorted.map(ym => {
    const [y, m] = ym.split('-');
    const label = new Date(+y, +m - 1, 1).toLocaleString([], { month: 'short', year: 'numeric' });
    return `<option value="${ym}" ${ym === current ? 'selected' : ''}>${label}</option>`;
  }).join('');
}

export function renderHistory() {
  const h = loadHistory();
  const list = document.getElementById('history-list');
  const actions = document.getElementById('history-actions');
  const callout = document.getElementById('block-detail-archive');
  const filterEl = document.getElementById('archive-filter');
  if (!list) return;

  if (callout) {
    if (h.length > 0) {
      const totalRevenue = h.reduce((s, e) => s + (e.breakdown?.total || 0), 0);
      callout.classList.add('active-info');
      callout.innerHTML = `${h.length} · $${totalRevenue.toFixed(2)} TOTAL<span class="id">A</span>`;
    } else {
      callout.classList.remove('active-info');
      callout.innerHTML = `Saved estimates<span class="id">A</span>`;
    }
  }

  // Conditional filter bar — only when 10+ entries.
  if (filterEl) {
    if (h.length >= FILTER_THRESHOLD) {
      filterEl.style.display = '';
      rebuildMonthDropdown(h);
    } else {
      filterEl.style.display = 'none';
      // Reset filter state so filter doesn't silently apply when bar is hidden
      filter.search = '';
      filter.month = '';
      filter.sort = 'date-desc';
    }
  }

  if (h.length === 0) {
    list.innerHTML = '<div class="empty"><strong>Empty archive</strong>Estimate a print and tap "Stamp &amp; Archive" to record it here. Saved entries can be cloned to start a similar print, exported as CSV for accounting, or printed as a customer-ready quote.</div>';
    actions.style.display = 'none';
    return;
  }
  actions.style.display = 'flex';

  const visible = applyFilter(h);
  const meta = document.getElementById('filter-meta');
  if (meta && filterEl && filterEl.style.display !== 'none') {
    if (visible.length === h.length) {
      meta.textContent = `${h.length} entries`;
    } else {
      const filteredTotal = visible.reduce((s, e) => s + (e.breakdown?.total || 0), 0);
      meta.textContent = `${visible.length} of ${h.length} · $${filteredTotal.toFixed(2)}`;
    }
  }

  list.innerHTML = '';
  if (visible.length === 0) {
    list.innerHTML = '<div class="empty" style="padding:18px 22px"><strong>No matches</strong>Try clearing the search or month filter.</div>';
    return;
  }
  visible.forEach(e => {
    const d = new Date(e.date);
    const dateStr = d.toLocaleDateString() + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div>
        <div class="history-name"></div>
        <div class="history-meta"></div>
        <div class="history-actions">
          <button class="link-btn" data-load="${e.id}">Load</button>
          <button class="link-btn" data-clone="${e.id}">Clone</button>
          <button class="link-btn" data-print="${e.id}">Print</button>
          <button class="link-btn danger" data-del="${e.id}">Delete</button>
        </div>
      </div>
      <div class="history-price">${fmt(e.breakdown.total)}</div>
    `;
    item.querySelector('.history-name').textContent = e.name;
    item.querySelector('.history-meta').textContent =
      `${dateStr} · ${e.grams.toFixed(1)} g · ${formatHours(e.hours)}` +
      (e.printerName ? ' · ' + e.printerName : '');
    list.appendChild(item);
  });
  list.querySelectorAll('[data-load]').forEach(btn => btn.addEventListener('click', e => loadFromHistory(+e.target.dataset.load)));
  list.querySelectorAll('[data-clone]').forEach(btn => btn.addEventListener('click', e => cloneFromHistory(+e.target.dataset.clone)));
  list.querySelectorAll('[data-print]').forEach(btn => btn.addEventListener('click', e => printQuote(+e.target.dataset.print)));
  list.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', e => deleteFromHistory(+e.target.dataset.del)));
}

function loadFromHistory(id) {
  const e = loadHistory().find(x => x.id === id);
  if (!e) return;
  document.getElementById('print-name').value = e.name;
  const hrs = Math.floor(e.hours);
  const mins = Math.round((e.hours - hrs) * 60);
  document.getElementById('time-h').value = hrs || '';
  document.getElementById('time-m').value = mins || '';
  setFilaments(e.filaments?.length ? e.filaments : [newFilament()]);
  renderFilaments();
  recalc();
  switchToPane('calc');
  toast(`Loaded "${e.name}"`);
}

function cloneFromHistory(id) {
  const e = loadHistory().find(x => x.id === id);
  if (!e) return;
  document.getElementById('print-name').value = `${e.name} (copy)`;
  const hrs = Math.floor(e.hours);
  const mins = Math.round((e.hours - hrs) * 60);
  document.getElementById('time-h').value = hrs || '';
  document.getElementById('time-m').value = mins || '';
  setFilaments(e.filaments?.length ? e.filaments : [newFilament()]);
  renderFilaments();
  recalc();
  switchToPane('calc');
  toast('Cloned — adjust and re-archive');
}

function deleteFromHistory(id) {
  if (!confirm('Delete this entry?')) return;
  saveHistory(loadHistory().filter(x => x.id !== id));
  renderHistory();
}

export function initArchive() {
  document.getElementById('save-quote').addEventListener('click', stampAndArchive);
  document.getElementById('reset-quote').addEventListener('click', () => {
    document.getElementById('print-name').value = '';
    document.getElementById('time-h').value = '';
    document.getElementById('time-m').value = '';
    setFilaments([newFilament()]);
    renderFilaments();
    recalc();
  });
  document.getElementById('clear-history').addEventListener('click', () => {
    if (!confirm('Clear all archived estimates? This cannot be undone.')) return;
    saveHistory([]);
    renderHistory();
    toast('Archive cleared');
  });
  document.getElementById('export-csv').addEventListener('click', exportArchiveCsv);

  // Archive filter inputs (only used when count >= FILTER_THRESHOLD).
  document.getElementById('archive-search')?.addEventListener('input', e => {
    filter.search = e.target.value;
    renderHistory();
  });
  document.getElementById('archive-month')?.addEventListener('change', e => {
    filter.month = e.target.value;
    renderHistory();
  });
  document.getElementById('archive-sort')?.addEventListener('change', e => {
    filter.sort = e.target.value;
    renderHistory();
  });
}

async function stampAndArchive() {
  if (saveQuoteInFlight) return;
  saveQuoteInFlight = true;
  const btn = document.getElementById('save-quote');
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    const result = recalc();
    if (result.total <= 0) {
      toast('Enter values first', true);
      return;
    }
    const printer = getActivePrinter();
    // Pre-stamp guard: warn if no printer is selected — electricity AND time
    // are silently $0 in that case, which can lead to under-quoting.
    if (!printer) {
      const ok = confirm(
        'No printer selected.\n\n' +
        'Without a printer, electricity and machine time are $0 in this quote. ' +
        'Stamp anyway?'
      );
      if (!ok) return;
    }
    const name = document.getElementById('print-name').value.trim() || 'Untitled print';
    const totalGrams = filaments.reduce((s, f) => s + num(f.grams), 0);
    const entry = {
      id: Date.now(),
      name,
      date: new Date().toISOString(),
      hours: result.hours,
      grams: totalGrams,
      printerId: printer?.id || null,
      printerName: printer?.name || null,
      filaments: filaments.map(f => ({ ...f })),
      breakdown: {
        filament: result.filamentCost,
        electricity: result.electricity,
        time: result.timeCost,
        subtotal: result.subtotal,
        failure: result.failureAmt,
        margin: result.marginAmt,
        total: result.total,
      },
      settingsSnapshot: { ...settings },
    };

    // Capture pre-state for undo (deep clone of spools — they're small).
    const spoolsBefore = JSON.parse(JSON.stringify(loadSpools()));

    const h = loadHistory();
    h.unshift(entry);
    saveHistory(h);

    // Deduct grams from linked spools (idempotent: archive entry id is unique).
    const spools = loadSpools();
    let deductedTotal = 0;
    const newlyLow = [];
    filaments.forEach(f => {
      if (!f.spoolId) return;
      const spool = spools.find(s => s.id === f.spoolId);
      if (!spool) return;
      const used = num(f.grams);
      const wasAbove = spool.remainingGrams >= LOW_STOCK_THRESHOLD;
      spool.remainingGrams = Math.max(0, +(spool.remainingGrams - used).toFixed(2));
      deductedTotal += used;
      if (wasAbove && spool.remainingGrams < LOW_STOCK_THRESHOLD) newlyLow.push(spool.name);
    });
    if (deductedTotal > 0) {
      saveSpools(spools);
      renderFilaments();
    }

    // Undo: removes the new archive entry and restores the spool snapshot.
    const undo = () => {
      saveHistory(loadHistory().filter(x => x.id !== entry.id));
      saveSpools(spoolsBefore);
      renderFilaments();
      recalc();
      logActivity(`undid archive of "${name}"`);
      toast('Stamp undone');
    };

    if (newlyLow.length) {
      // Low-stock warning is too important to bury in an undo toast — show
      // it as the regular sticky error AND log the archive at the same time.
      toast(`Low stock: ${newlyLow.join(', ')}`, true);
    } else {
      toastWithUndo(`Stamped & archived · ${fmt(result.total)}`, undo, 8000);
    }
    logActivity(`archived "${name}" — ${fmt(result.total)}`);
    markOnboardingComplete(); // user has shipped a real estimate; dismiss welcome
  } finally {
    saveQuoteInFlight = false;
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

function exportArchiveCsv() {
  const all = loadHistory();
  if (!all.length) { toast('Archive is empty', true); return; }
  // CSV exports whatever the user is currently looking at (filter applied).
  const h = applyFilter(all);
  if (!h.length) { toast('No entries match the current filter', true); return; }
  const rows = h.map(e => ({
    date: new Date(e.date).toISOString().slice(0, 10),
    name: e.name,
    printer: e.printerName || '',
    hours: e.hours.toFixed(3),
    grams: e.grams.toFixed(2),
    filaments: (e.filaments || []).map(f => `${f.name}:${(+f.grams).toFixed(1)}g`).join('; '),
    filament_cost: e.breakdown.filament.toFixed(2),
    electricity_cost: e.breakdown.electricity.toFixed(2),
    time_cost: e.breakdown.time.toFixed(2),
    subtotal: e.breakdown.subtotal.toFixed(2),
    failure_markup: e.breakdown.failure.toFixed(2),
    margin: e.breakdown.margin.toFixed(2),
    total: e.breakdown.total.toFixed(2),
  }));
  const cols = ['date','name','printer','hours','grams','filaments',
    'filament_cost','electricity_cost','time_cost','subtotal',
    'failure_markup','margin','total'];
  const csv = toCsv(rows, cols);
  const filename = `printpricer-archive-${new Date().toISOString().slice(0, 10)}.csv`;
  downloadFile(filename, csv, 'text/csv;charset=utf-8');
  const ofMsg = rows.length === all.length ? '' : ` of ${all.length}`;
  toast(`Exported ${rows.length}${ofMsg} rows to ${filename}`);
}

function printQuote(id) {
  const e = loadHistory().find(x => x.id === id);
  if (!e) return;
  const w = window.open('', '_blank');
  if (!w) { toast('Popup blocked — allow popups to print', true); return; }
  const d = new Date(e.date);
  const fil = (e.filaments || []).map(f =>
    `<tr><td>${escapeHtml(f.name || 'Filament')}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${(+f.grams).toFixed(1)}&nbsp;g</td><td style="text-align:right;font-variant-numeric:tabular-nums">$${(+f.costPerKg).toFixed(2)}/kg</td></tr>`
  ).join('');
  const b = e.breakdown;
  w.document.write(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Print Pricer · ${escapeHtml(e.name)}</title>
<style>
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #16202d; max-width: 720px; margin: 32px auto; padding: 0 24px; }
  h1 { font-size: 26px; letter-spacing: 1px; margin-bottom: 4px; }
  .sub { color: #6a7585; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin: 18px 0; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #d4cdb8; text-align: left; }
  th { font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: #6a7585; }
  .totals { margin-top: 16px; font-variant-numeric: tabular-nums; }
  .totals tr td:last-child { text-align: right; }
  .total-row { font-size: 18px; font-weight: 700; border-top: 2px solid #16202d; }
  .meta { font-size: 12px; color: #6a7585; margin-top: 24px; }
  @media print { body { margin: 12mm; } }
</style></head><body>
<h1>${escapeHtml(e.name)}</h1>
<div class="sub">Print Pricer · ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${e.printerName ? ' · ' + escapeHtml(e.printerName) : ''}</div>

<table>
  <thead><tr><th>Filament</th><th style="text-align:right">Used</th><th style="text-align:right">Cost</th></tr></thead>
  <tbody>${fil}</tbody>
</table>
<div class="sub">Print time: ${formatHours(e.hours)}${e.grams ? ' · Total filament: ' + e.grams.toFixed(1) + ' g' : ''}</div>

<table class="totals">
  <tr><td>Filament</td><td>$${b.filament.toFixed(2)}</td></tr>
  <tr><td>Electricity</td><td>$${b.electricity.toFixed(2)}</td></tr>
  <tr><td>Time (machine / labor)</td><td>$${b.time.toFixed(2)}</td></tr>
  <tr><td><strong>Subtotal</strong></td><td><strong>$${b.subtotal.toFixed(2)}</strong></td></tr>
  <tr><td>Failure markup</td><td>$${b.failure.toFixed(2)}</td></tr>
  <tr><td>Profit margin</td><td>$${b.margin.toFixed(2)}</td></tr>
  <tr class="total-row"><td>Total</td><td>$${b.total.toFixed(2)}</td></tr>
</table>

<div class="meta">Quoted by Print Pricer · metacrystal.com/printpricer</div>
<script>window.onload = () => setTimeout(() => window.print(), 100);<\/script>
</body></html>`);
  w.document.close();
}
