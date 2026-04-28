// Cost calculation + the breakdown rendering on the Estimate sheet.

import { settings, filaments } from './state.js';
import { getActivePrinter } from './storage.js';
import { num, fmt } from './utils.js';

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

  document.getElementById('bd-filament').textContent = fmt(filamentCost);
  document.getElementById('bd-power').textContent    = fmt(electricity);
  document.getElementById('bd-time').textContent     = fmt(timeCost);
  document.getElementById('bd-subtotal').textContent = fmt(subtotal);
  document.getElementById('bd-failure').textContent  = fmt(failureAmt);
  document.getElementById('bd-margin').textContent   = fmt(marginAmt);
  document.getElementById('bd-total').textContent    = fmt(total);
  document.getElementById('bd-failure-label').textContent = `Failure markup (${failurePct}%)`;
  document.getElementById('bd-margin-label').textContent  = `Profit margin (${marginPct}%)`;

  return { hours, filamentCost, electricity, timeCost, subtotal, failureAmt, marginAmt, total };
}

export function loadSettingsToForm() {
  document.getElementById('s-filament-cost').value = settings.filamentCost;
  document.getElementById('s-kwh').value           = settings.kwh;
  document.getElementById('s-failure').value       = settings.failurePct;
  document.getElementById('s-margin').value        = settings.marginPct;
  document.getElementById('s-est-density').value   = settings.estDensity || '';
  document.getElementById('s-est-fill').value      = settings.estFillPct || '';
}
