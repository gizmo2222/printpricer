// First-run onboarding card on the Estimate sheet.
// Shows when:
//   - localStorage flag printpricer:onboarded is NOT set
//   - AND the user has no printers and no spools
// Hides when:
//   - the user dismisses with the × button
//   - OR the user has at least one printer + at least one spool
//   - OR the user successfully Stamps & Archives a print
//
// Steps are click-to-jump links to the relevant layers.

import { loadPrinters, loadSpools } from './storage.js';
import { switchToPane } from './ui.js';

const ONBOARD_KEY = 'printpricer:onboarded';

export function onboardingComplete() {
  return localStorage.getItem(ONBOARD_KEY) === '1';
}

export function markOnboardingComplete() {
  localStorage.setItem(ONBOARD_KEY, '1');
  hideOnboarding();
}

export function maybeShowOnboarding() {
  const card = document.getElementById('onboard-card');
  if (!card) return;
  if (onboardingComplete()) { card.style.display = 'none'; return; }
  // If the user has already done meaningful setup, treat as complete silently.
  if (loadPrinters().length > 0 && loadSpools().length > 0) {
    markOnboardingComplete();
    return;
  }
  card.style.display = '';
}

function hideOnboarding() {
  const card = document.getElementById('onboard-card');
  if (card) card.style.display = 'none';
}

export function initOnboarding() {
  const card = document.getElementById('onboard-card');
  if (!card) return;

  document.getElementById('onboard-close').addEventListener('click', () => {
    markOnboardingComplete();
  });

  card.querySelectorAll('[data-onboard-jump]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.onboardJump;
      switchToPane(target);
    });
  });

  maybeShowOnboarding();
}
