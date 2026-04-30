// Cost calculation + the breakdown rendering on the Estimate sheet.
// Also drives:
//   - recalc-flash on values that actually changed (visibility of system status)
//   - sticky total bar visibility
//   - earned block-detail callouts on Estimate sheet headers

import { settings, filaments, addons, MARKETPLACE_PRESETS } from './state.js?v=24';
import { getActivePrinter } from './storage.js?v=24';
import { num, fmt, formatHours } from './utils.js?v=24';

const flashTargets = ['bd-filament','bd-power','bd-time','bd-labor','bd-packaging','bd-bom','bd-shipping','bd-subtotal','bd-failure','bd-margin','bd-total','bd-fees','bd-net','sticky-total-value'];
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

// Resolve marketplace fees from settings into a flat shape. Returns the
// computed fee for a given gross price.
function computeFees(price) {
  const presetKey = settings.marketplacePreset || 'none';
  let preset = MARKETPLACE_PRESETS[presetKey] || MARKETPLACE_PRESETS.none;
  if (presetKey === 'custom') {
    preset = {
      listingFee:  num(settings.marketplaceCustomListing),
      txnPct:      num(settings.marketplaceCustomTxnPct),
      paymentPct:  num(settings.marketplaceCustomPaymentPct),
      paymentFlat: num(settings.marketplaceCustomPaymentFlat),
    };
  }
  const fee = preset.listingFee
            + price * (preset.txnPct / 100)
            + price * (preset.paymentPct / 100)
            + preset.paymentFlat;
  return { fee, preset, presetKey };
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

  // Add-ons: labor, packaging, shipping
  const laborMinutes = num(addons.laborMinutes);
  const laborRate    = num(settings.laborRate);
  const laborCost    = (laborMinutes / 60) * laborRate;
  const packagingCost = num(addons.packagingCost);
  const shippingCost  = num(addons.shippingCost);
  // Bill of materials: hardware/consumables — adds to subtotal so failure
  // markup and margin apply (these are real per-unit costs that take time
  // to assemble + carry stocking risk).
  const bomCost = (addons.bom || []).reduce(
    (s, b) => s + (num(b.qty) * num(b.unitCost)), 0);

  // COGS (subtotal): everything except shipping (passthrough) and fees (deduction)
  const subtotal = filamentCost + electricity + timeCost + laborCost + packagingCost + bomCost;

  const failurePct = num(settings.failurePct);
  const marginPct  = num(settings.marginPct);
  const failureAmt = subtotal * (failurePct / 100);
  const afterFailure = subtotal + failureAmt;
  const marginAmt = afterFailure * (marginPct / 100);
  const beforeShipping = afterFailure + marginAmt;
  // Shipping is a passthrough — added at the end, not marked up
  const total = beforeShipping + shippingCost;

  // Marketplace fees subtract from net (what you actually keep)
  const { fee: feeAmt, preset, presetKey } = computeFees(total);
  const net = total - feeAmt;

  setValue('bd-filament',  fmt(filamentCost));
  setValue('bd-power',     fmt(electricity));
  setValue('bd-time',      fmt(timeCost));
  setValue('bd-labor',     fmt(laborCost));
  setValue('bd-packaging', fmt(packagingCost));
  setValue('bd-bom',       fmt(bomCost));
  setValue('bd-shipping',  fmt(shippingCost));
  setValue('bd-subtotal',  fmt(subtotal));
  setValue('bd-failure',   fmt(failureAmt));
  setValue('bd-margin',    fmt(marginAmt));
  setValue('bd-total',     fmt(total));
  setValue('bd-fees',      '−' + fmt(feeAmt));
  setValue('bd-net',       fmt(net));
  setValue('sticky-total-value', fmt(total));

  document.getElementById('bd-failure-label').textContent = `Failure markup (${failurePct}%)`;
  document.getElementById('bd-margin-label').textContent  = `Profit margin (${marginPct}%)`;
  document.getElementById('bd-fees-label').textContent    = `${preset.label} fees`;

  // Show/hide rows that have zero values to keep the breakdown tidy
  document.getElementById('bd-labor-row')?.toggleAttribute('hidden', laborCost === 0);
  document.getElementById('bd-packaging-row')?.toggleAttribute('hidden', packagingCost === 0);
  document.getElementById('bd-bom-row')?.toggleAttribute('hidden', bomCost === 0);
  document.getElementById('bd-shipping-row')?.toggleAttribute('hidden', shippingCost === 0);
  // Show the net-after-fees panel only if a marketplace is actually selected and there are fees
  const netPanel = document.getElementById('net-after-fees');
  if (netPanel) netPanel.style.display = (presetKey !== 'none' && feeAmt > 0) ? '' : 'none';

  // Target sell price comparison — diff vs the calculated estimate
  const target = num(addons.sellPrice);
  const cmp = document.getElementById('target-compare');
  const cmpVal = document.getElementById('target-delta');
  if (cmp && cmpVal) {
    if (target > 0 && total > 0) {
      const delta = target - total;
      const sign  = delta >= 0 ? '+' : '−';
      cmpVal.textContent = `Target ${fmt(target)} · ${sign}${fmt(Math.abs(delta))}`;
      cmp.classList.toggle('over',  delta >= 0);
      cmp.classList.toggle('under', delta < 0);
      cmp.style.display = '';
    } else {
      cmp.style.display = 'none';
      cmp.classList.remove('over', 'under');
    }
  }

  updateBlockCallouts({ hours, totalGrams: filaments.reduce((s, f) => s + num(f.grams), 0), total, bomCost });
  updateStickyTotal(total);

  return { hours, filamentCost, electricity, timeCost, laborCost, packagingCost, shippingCost, bomCost,
           subtotal, failureAmt, marginAmt, total, feeAmt, net };
}

// Callouts on the right side of each block header — earned, not decorative.
function updateBlockCallouts({ hours, totalGrams, total, bomCost }) {
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

  const bom = document.getElementById('block-detail-bom');
  if (bom) {
    const items = (addons.bom || []).filter(b => (b.name || '').trim() || num(b.qty)).length;
    if (items > 0 && bomCost > 0) {
      bom.classList.add('active-info');
      bom.innerHTML = `${items} · ${fmt(bomCost)}<span class="id">D</span>`;
    } else {
      bom.classList.remove('active-info');
      bom.innerHTML = `Hardware · consumables<span class="id">D</span>`;
    }
  }

  const bd = document.getElementById('block-detail-breakdown');
  if (bd) {
    if (hours > 0) {
      bd.classList.add('active-info');
      bd.innerHTML = `${formatHours(hours).replace(/\s/g,'').toUpperCase()}<span class="id">E</span>`;
    } else {
      bd.classList.remove('active-info');
      bd.innerHTML = `Estimate summary<span class="id">E</span>`;
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
  document.getElementById('s-labor-rate').value    = settings.laborRate || '';
  document.getElementById('s-failure').value       = settings.failurePct;
  document.getElementById('s-margin').value        = settings.marginPct;
  document.getElementById('s-est-density').value   = settings.estDensity || '';
  document.getElementById('s-est-fill').value      = settings.estFillPct || '';
  document.getElementById('s-marketplace').value   = settings.marketplacePreset || 'none';
  document.getElementById('s-mp-listing').value    = settings.marketplaceCustomListing || '';
  document.getElementById('s-mp-txn').value        = settings.marketplaceCustomTxnPct || '';
  document.getElementById('s-mp-pay-pct').value    = settings.marketplaceCustomPaymentPct || '';
  document.getElementById('s-mp-pay-flat').value   = settings.marketplaceCustomPaymentFlat || '';
  document.getElementById('s-biz-name').value      = settings.businessName || '';
  document.getElementById('s-biz-email').value     = settings.businessEmail || '';
  document.getElementById('s-biz-notes').value     = settings.businessNotes || '';
  // Toggle visibility of the custom marketplace inputs
  document.getElementById('marketplace-custom').style.display =
    settings.marketplacePreset === 'custom' ? '' : 'none';
}
