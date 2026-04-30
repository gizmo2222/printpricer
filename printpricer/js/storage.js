// localStorage read/write for each collection, plus cloud-push wrappers
// that update only the docs that actually changed.
//
// Reads are always synchronous (localStorage). Writes go to localStorage
// first, then opportunistically push to Firestore when in cloud mode.

import {
  SETTINGS_KEY, HISTORY_KEY, SPOOLS_KEY, PRINTERS_KEY, PRODUCTS_KEY, ACTIVE_PRINTER_KEY,
  settings, state, isInCloudMode,
} from './state.js?v=22';
import { updateSyncIndicator } from './ui.js?v=22';
import { fb } from './firebase.js?v=22';

// ---------- read helpers ----------

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export const loadHistory  = ()  => readJson(HISTORY_KEY,  []);
export const loadSpools   = ()  => readJson(SPOOLS_KEY,   []);
export const loadPrinters = ()  => readJson(PRINTERS_KEY, []);
export const loadProducts = ()  => readJson(PRODUCTS_KEY, []);

export function loadActivePrinterId() {
  return localStorage.getItem(ACTIVE_PRINTER_KEY) || null;
}
export function saveActivePrinterId(id) {
  if (id == null) localStorage.removeItem(ACTIVE_PRINTER_KEY);
  else localStorage.setItem(ACTIVE_PRINTER_KEY, String(id));
}
export function getActivePrinter() {
  const id = loadActivePrinterId();
  if (!id) return null;
  return loadPrinters().find(p => String(p.id) === String(id)) || null;
}

// ---------- write helpers ----------

function bumpPending(kind, delta) {
  state.pending[kind] = Math.max(0, (state.pending[kind] || 0) + delta);
  const total = Object.values(state.pending).reduce((s, n) => s + n, 0);
  updateSyncIndicator(total);
}

// settings — single doc.
export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  if (!isInCloudMode() || state.isApplyingRemote) return;
  bumpPending('settings', +1);
  fb.setDoc(fb.doc(fb.db, 'groups', state.groupId, 'settings', 'main'), { ...settings })
    .catch(err => console.warn('cloud push (settings):', err))
    .finally(() => bumpPending('settings', -1));
}

// Generic per-doc-diff push. `before` is the previous array (from
// localStorage *before* this save); `after` is the new array. Adds/updates
// docs that changed; deletes docs that disappeared. This avoids the
// pre-existing full-collection rewrite on every change.
async function pushDiff(collectionName, before, after) {
  if (!isInCloudMode() || state.isApplyingRemote) return;
  const gid = state.groupId;
  const beforeMap = new Map(before.map(x => [String(x.id), x]));
  const afterMap  = new Map(after.map(x  => [String(x.id), x]));
  const writes = [];
  for (const [id, val] of afterMap) {
    const prev = beforeMap.get(id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(val)) {
      const { id: _, ...data } = val;
      writes.push(fb.setDoc(fb.doc(fb.db, 'groups', gid, collectionName, id), data));
    }
  }
  for (const id of beforeMap.keys()) {
    if (!afterMap.has(id)) {
      writes.push(fb.deleteDoc(fb.doc(fb.db, 'groups', gid, collectionName, id)));
    }
  }
  await Promise.all(writes);
}

// Save a collection: localStorage write + diff push to Firestore.
function makeCollectionSaver(key, collectionName, kind) {
  return function save(after) {
    const before = readJson(key, []);
    localStorage.setItem(key, JSON.stringify(after));
    if (!isInCloudMode() || state.isApplyingRemote) return;
    bumpPending(kind, +1);
    pushDiff(collectionName, before, after)
      .catch(err => console.warn(`cloud push (${kind}):`, err))
      .finally(() => bumpPending(kind, -1));
  };
}

export const saveSpools   = makeCollectionSaver(SPOOLS_KEY,   'spools',   'spools');
export const saveHistory  = makeCollectionSaver(HISTORY_KEY,  'archive',  'history');
export const savePrinters = makeCollectionSaver(PRINTERS_KEY, 'printers', 'printers');
export const saveProducts = makeCollectionSaver(PRODUCTS_KEY, 'products', 'products');

// Used by firebase.js to seed a freshly-created group with the user's
// existing local data. Forces a full-collection write since the remote is
// known to be empty.
export async function seedGroupCollection(collectionName, data) {
  if (!isInCloudMode()) return;
  const gid = state.groupId;
  const writes = data.map(item => {
    const { id, ...rest } = item;
    return fb.setDoc(fb.doc(fb.db, 'groups', gid, collectionName, String(id)), rest);
  });
  await Promise.all(writes);
}
