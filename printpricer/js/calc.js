// Cost calculation + the breakdown rendering on the Estimate sheet.
// Also drives:
//   - recalc-flash on values that actually changed (visibility of system status)
//   - sticky total bar visibility
//   - earned block-detail callouts on Estimate sheet headers

import { settings, filaments } from './state.js?v=15';
import { getActivePrinter } from './storage.js?v=15';
import { num, fmt, formatHours } from './utils.js?v=15';

const flashTargets = ['bd-filament','bd-power','bd-time','bd-subtotal','bd-failure','bd-margin','bd-total','sticky-total-value'];
const lastValues = {};

function setValue(id, str) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.textContent !== str) {
    el.textContent = str;
    if (flashTargets.includes(id) && lastValues[id] !== undefined) {
      el.classList.remove('flashed');
      // double-rAF so the no-transition class application registers, then transition runs back
      requestAnimationFrame(() => {
        el.classList.add('flashed');
        requestAnimationFrame(() => el.classList.remove('flashed'));
      });
    }
    lastValues[id] = str;
  }
}

export function recalc() {
  const hours = num(document.getElementById('time-h')?.value)
    + num(document.getElementById('time-m')?.value) / 60;

  const filamentCost = filaments.reduce((sum, f) =>
    sum + (num(f.grams) / 1000) * num(f.costPerKg), 0);

  const printer = getActivePrinter();
  const watts = printer ? num(printer.watts) : 0;
  const kwh = num(settings.kwh);
  const electricity = (watts / 1000) * hours * kwh;

  const rate = printer ? num(printer.hourlyRate) : 0;
  const timeCost = hours * rate;

  const subtotal = filamentCost + electricity + timeCost;

  const failurePct = num(settings.failurePct);
  const marginPct  = num(settings.marginPct);
  const failureAmt = subtotal * (failurePct / 100);
  const afterFailure = subtotal + failureAmt;
  const marginAmt = afterFailure * (marginPct / 100);
  const total = afterFailure + marginAmt;

  setValue('bd-filament', fmt(filamentCost));
  setValue('bd-power',    fmt(electricity));
  setValue('bd-time',     fmt(timeCost));
  setValue('bd-subtotal', fmt(subtotal));
  setValue('bd-failure',  fmt(failureAmt));
  setValue('bd-margin',   fmt(marginAmt));
  setValue('bd-total',    fmt(total));
  setValue('sticky-total-value', fmt(total));

  document.getElementById('bd-failure-label').textContent = `Failure markup (${failurePct}%)`;
  document.getElementById('bd-margin-label').textContent  = `Profit margin (${marginPct}%)`;

  updateBlockCallouts({ hours, totalGrams: filaments.reduce((s, f) => s + num(f.grams), 0), total });
  updateStickyTotal(total);

  return { hours, filamentCost, electricity, timeCost, subtotal, failureAmt, marginAmt, total };
}

// Callouts on the right side of each block header — earned, not decorative.
function updateBlockCallouts({ hours, totalGrams, total }) {
  const printer = getActivePrinter();

  const print = document.getElementById('block-detail-print');
  if (print) {
    if (printer) {
      print.classList.add('active-info');
      print.innerHTML = `${escapeText(printer.name).toUpperCase()}<span class="id">A</span>`;
    } else {
      print.classList.remove('active-info');
      print.innerHTML = `Detail<span class="id">A</span>`;
    }
  }

  const fil = document.getElementById('block-detail-filaments');
  if (fil) {
    const realRows = filaments.filter(f => num(f.grams) > 0 || (f.name || '').trim()).length;
    if (realRows > 0 && totalGrams > 0) {
      fil.classList.add('active-info');
      fil.innerHTML = `${realRows} · ${totalGrams.toFixed(1)} G<span class="id">B</span>`;
    } else {
      fil.classList.remove('active-info');
      fil.innerHTML = `Detail<span class="id">B</span>`;
    }
  }

  const bd = document.getElementById('block-detail-breakdown');
  if (bd) {
    if (hours > 0) {
      bd.classList.add('active-info');
      bd.innerHTML = `${formatHours(hours).replace(/\s/g,'').toUpperCase()}<span class="id">C</span>`;
    } else {
      bd.classList.remove('active-info');
      bd.innerHTML = `Bill of materials<span class="id">C</span>`;
    }
  }
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Sticky total bar at the bottom — only shown on Estimate pane, when total > 0,
// and when the main .total-stamp is offscreen.
let stampObserver = null;
let stampInView = true;
function updateStickyTotal(total) {
  const bar = document.getElementById('sticky-total');
  if (!bar) return;
  const onEstimate = document.querySelector('.layer.active')?.dataset.pane === 'calc';
  const show = onEstimate && total > 0 && !stampInView;
  bar.classList.toggle('show', show);
}

export function initStickyTotal() {
  const stamp = document.querySelector('.total-stamp');
  if (!stamp || !('IntersectionObserver' in window)) return;
  stampObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => { stampInView = entry.isIntersecting; });
    // Re-evaluate visibility with current total
    const totalText = document.getElementById('bd-total')?.textContent || '$0.00';
    const total = parseFloat(totalText.replace(/[^0-9.\-]/g, '')) || 0;
    updateStickyTotal(total);
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  stampObserver.observe(stamp);
}

export function loadSettingsToForm() {
  document.getElementById('s-filament-cost').value = settings.filamentCost;
  document.getElementById('s-kwh').value           = settings.kwh;
  document.getElementById('s-failure').value       = settings.failurePct;
  document.getElementById('s-margin').value        = settings.marginPct;
  document.getElementById('s-est-density').value   = settings.estDensity || '';
  document.getElementById('s-est-fill').value      = settings.estFillPct || '';
}
