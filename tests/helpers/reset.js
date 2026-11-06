// Put the shared app singletons back to a clean slate between tests.

import { resetEnv } from './env.js';
import {
  settings, defaultSettings, filaments, addons, state,
  PRINTERS_KEY, ACTIVE_PRINTER_KEY,
} from '../../printpricer/js/state.js';

export function resetApp() {
  resetEnv();
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, defaultSettings);
  filaments.length = 0;
  Object.assign(addons, {
    laborMinutes: '', packagingCost: '', shippingCost: '',
    bom: [], notes: '', sellPrice: '', photos: [],
  });
  state.user = null;
  state.groupId = null;
}

/** Store printers and make the first one (or `activeId`) active. */
export function setPrinters(printers, activeId = printers[0]?.id) {
  localStorage.setItem(PRINTERS_KEY, JSON.stringify(printers));
  if (activeId != null) localStorage.setItem(ACTIVE_PRINTER_KEY, String(activeId));
}

/** Pretend to be signed in to a group, so isInCloudMode() is true. */
export function enterCloudMode() {
  state.user = { uid: 'u1', isAnonymous: false };
  state.groupId = 'g1';
}
