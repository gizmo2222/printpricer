// Firebase init, auth, group operations, and Firestore listeners.
//
// Exports an `fb` object that other modules use to call Firestore.
// Listeners are guarded with a generation counter so a snapshot fired
// after the user has switched groups can detect it's stale and bail.

import {
  CLOUD_ENABLED, FIREBASE_CONFIG,
  SPOOLS_KEY, HISTORY_KEY, PRINTERS_KEY, PRODUCTS_KEY, SETTINGS_KEY,
  defaultSettings, settings, state, isInCloudMode,
} from './state.js?v=35';
import { rafDebounce, generateJoinCode } from './utils.js?v=35';
import { activePane } from './ui.js?v=35';
import { renderSpools } from './spools.js?v=35';
import { renderPrinters, updateActivePrinterDisplay } from './printers.js?v=35';
import { renderProducts } from './products.js?v=35';
import { renderHistory } from './archive.js?v=35';
import { renderActivity } from './activity.js?v=35';
import { renderFilaments } from './filaments.js?v=35';
import { recalc, loadSettingsToForm } from './calc.js?v=35';
import { renderGroupSection, updateAccountUI } from './auth-ui.js?v=35';
import { loadHistory, loadSpools, loadPrinters, loadProducts, seedGroupCollection } from './storage.js?v=35';

export let fb = null;

if (CLOUD_ENABLED) {
  const [
    appMod, authMod, fsMod,
  ] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js'),
  ]);
  const app = appMod.initializeApp(FIREBASE_CONFIG);
  const auth = authMod.getAuth(app);
  const db = fsMod.getFirestore(app);
  try { await fsMod.enableIndexedDbPersistence(db); } catch { /* non-fatal */ }
  fb = { app, auth, db, ...authMod, ...fsMod };
}

// ---- generation guard for listeners ----

function withGen(fn) {
  const gen = state.syncGen;
  const debouncedFn = rafDebounce(fn);
  return (...args) => {
    if (gen !== state.syncGen) return; // stale listener — group changed
    debouncedFn(...args);
  };
}

function clearListeners() {
  state.unsubs.forEach(u => { try { u(); } catch {} });
  state.unsubs = [];
  state.syncGen++;
}

// ---- members lookup ----

// Emails are stored on the group (memberEmails) because the security rules
// only let each user read their own users/{uid} record.
function membersFromGroup(groupDoc) {
  const emails = groupDoc?.memberEmails || {};
  return (groupDoc?.members || []).map(uid => ({
    uid,
    email: emails[uid] || (uid === state.user?.uid && state.user.email) || uid,
  }));
}

async function ensureUserDoc(user) {
  if (!fb || !user || user.isAnonymous) return;
  const ref = fb.doc(fb.db, 'users', user.uid);
  const snap = await fb.getDoc(ref);
  if (!snap.exists()) {
    await fb.setDoc(ref, {
      email: user.email || '',
      createdAt: fb.serverTimestamp(),
      currentGroupId: null,
    });
  } else if (user.email && snap.data().email !== user.email) {
    await fb.updateDoc(ref, { email: user.email });
  }
}

async function loadUserGroup() {
  if (!fb || !state.user || state.user.isAnonymous) return;
  const ref = fb.doc(fb.db, 'users', state.user.uid);
  const snap = await fb.getDoc(ref);
  const gid = snap.exists() ? (snap.data().currentGroupId || null) : null;
  if (gid) {
    await subscribeToGroup(gid);
  } else {
    state.groupId = null;
    state.groupDoc = null;
    state.members = [];
  }
}

// ---- subscribe ----

export async function subscribeToGroup(gid) {
  if (!fb) return;
  clearListeners();
  state.groupId = gid;
  const myGen = state.syncGen;

  const groupRef = fb.doc(fb.db, 'groups', gid);
  state.unsubs.push(fb.onSnapshot(groupRef, withGen(async snap => {
    if (!snap.exists()) {
      state.groupId = null;
      state.groupDoc = null;
      state.members = [];
      clearListeners();
      updateAccountUI();
      renderGroupSection();
      return;
    }
    state.groupDoc = { id: snap.id, ...snap.data() };
    state.members = membersFromGroup(state.groupDoc);
    if (state.syncGen !== myGen) return;
    updateAccountUI();
    renderGroupSection();
  })));

  // ---- subcollection listeners ----
  function makeListener(name, key, onAfterMirror) {
    const ref = fb.collection(fb.db, 'groups', gid, name);
    return fb.onSnapshot(ref, withGen(snap => {
      const arr = [];
      snap.forEach(d => { arr.push({ id: parseInt(d.id) || d.id, ...d.data() }); });
      if (name === 'archive') arr.sort((a, b) => (b.id || 0) - (a.id || 0));
      state.isApplyingRemote = true;
      try {
        localStorage.setItem(key, JSON.stringify(arr));
        onAfterMirror();
      } finally { state.isApplyingRemote = false; }
    }));
  }

  state.unsubs.push(makeListener('spools', SPOOLS_KEY, () => {
    if (activePane() === 'spools') renderSpools();
    renderFilaments();
  }));

  state.unsubs.push(makeListener('archive', HISTORY_KEY, () => {
    if (activePane() === 'history') renderHistory();
  }));

  state.unsubs.push(makeListener('printers', PRINTERS_KEY, () => {
    if (activePane() === 'printers') renderPrinters();
    updateActivePrinterDisplay();
    recalc();
  }));

  state.unsubs.push(makeListener('products', PRODUCTS_KEY, () => {
    if (activePane() === 'products') renderProducts();
  }));

  // settings is a single doc, not a collection
  const settingsRef = fb.doc(fb.db, 'groups', gid, 'settings', 'main');
  state.unsubs.push(fb.onSnapshot(settingsRef, withGen(snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    state.isApplyingRemote = true;
    try {
      Object.assign(settings, defaultSettings, data);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      loadSettingsToForm();
      recalc();
    } finally { state.isApplyingRemote = false; }
  })));

  // activity feed (group events)
  const activityRef = fb.collection(fb.db, 'groups', gid, 'activity');
  state.unsubs.push(fb.onSnapshot(activityRef, withGen(snap => {
    const arr = [];
    snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
    arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (activePane() === 'spools' || activePane() === 'history') {
      // activity surfaces inside the relevant pane via a sidebar; safe no-op here
    }
    renderActivity(arr);
  })));

  const status = document.getElementById('sync-status');
  if (status) status.textContent = 'Live · synced';
}

// ---- auth ----

export async function doSignIn(email, password) {
  if (!fb) throw new Error('Cloud not configured');
  await fb.signInWithEmailAndPassword(fb.auth, email, password);
}
export async function doSignUp(email, password) {
  if (!fb) throw new Error('Cloud not configured');
  await fb.createUserWithEmailAndPassword(fb.auth, email, password);
}
export async function doSignOut() {
  if (!fb) return;
  clearListeners();
  state.groupId = null;
  state.groupDoc = null;
  state.members = [];
  await fb.signOut(fb.auth);
}

// ---- groups ----

export async function createGroup(name) {
  if (!fb || !state.user || state.user.isAnonymous) throw new Error('Sign in first');
  if (!name?.trim()) throw new Error('Group name required');

  const localSpools  = loadSpools();
  const localHistory = loadHistory();
  const localPrinters = loadPrinters();
  const localProducts = loadProducts();
  const localSettings = { ...settings };

  const ref = await fb.addDoc(fb.collection(fb.db, 'groups'), {
    name: name.trim(),
    joinCode: generateJoinCode(),
    ownerUid: state.user.uid,
    members: [state.user.uid],
    memberEmails: { [state.user.uid]: state.user.email || '' },
    createdAt: fb.serverTimestamp(),
  });
  await registerJoinCode(ref);
  await fb.updateDoc(fb.doc(fb.db, 'users', state.user.uid), { currentGroupId: ref.id });

  state.groupId = ref.id;
  if (localSpools.length)   await seedGroupCollection('spools', localSpools);
  if (localHistory.length)  await seedGroupCollection('archive', localHistory);
  if (localPrinters.length) await seedGroupCollection('printers', localPrinters);
  if (localProducts.length) await seedGroupCollection('products', localProducts);
  await fb.setDoc(fb.doc(fb.db, 'groups', ref.id, 'settings', 'main'), localSettings);

  await subscribeToGroup(ref.id);
  await logActivity(`created the group`);
  return ref.id;
}

// Publishes joinCodes/{code} → { gid }. That lookup is the only way for a
// non-member to find a group. If the code is already taken by another group
// (the create is refused), pick a new code and try again.
async function registerJoinCode(groupRef) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const snap = await fb.getDoc(groupRef);
    const code = snap.data().joinCode;
    try {
      await fb.setDoc(fb.doc(fb.db, 'joinCodes', code), { gid: groupRef.id });
      return;
    } catch {
      await fb.updateDoc(groupRef, { joinCode: generateJoinCode() });
    }
  }
  throw new Error('Could not create a join code — try again');
}

export async function joinGroupByCode(code) {
  if (!fb || !state.user || state.user.isAnonymous) throw new Error('Sign in first');
  // Codes are stored as ABC-DEF; accept "abcdef", "ABC DEF", "abc-def", ...
  const chars = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (chars.length !== 6) throw new Error('Join codes are 6 characters, like ABC-DEF');
  const snap = await fb.getDoc(fb.doc(fb.db, 'joinCodes', `${chars.slice(0, 3)}-${chars.slice(3)}`)).catch(() => null);
  if (!snap?.exists()) throw new Error('No group found with that code');
  const gid = snap.data().gid;
  if (state.groupId !== gid) {
    // Adding yourself is allowed for anyone who knows the group's ID; a repeat
    // join by an existing member leaves members unchanged.
    await fb.updateDoc(fb.doc(fb.db, 'groups', gid), {
      members: fb.arrayUnion(state.user.uid),
      [`memberEmails.${state.user.uid}`]: state.user.email || '',
    });
  }
  await fb.updateDoc(fb.doc(fb.db, 'users', state.user.uid), { currentGroupId: gid });
  await subscribeToGroup(gid);
  await logActivity(`joined the group`);
}

export async function leaveGroup() {
  if (!fb || !state.groupId || !state.user) return;
  await logActivity(`left the group`);
  const gid = state.groupId;
  await fb.updateDoc(fb.doc(fb.db, 'groups', gid), {
    members: fb.arrayRemove(state.user.uid),
    [`memberEmails.${state.user.uid}`]: fb.deleteField(),
  });
  await fb.updateDoc(fb.doc(fb.db, 'users', state.user.uid), { currentGroupId: null });
  clearListeners();
  state.groupId = null;
  state.groupDoc = null;
  state.members = [];
  updateAccountUI();
  renderGroupSection();
}

// ---- activity feed write ----

export async function logActivity(action) {
  if (!isInCloudMode()) return;
  try {
    await fb.addDoc(fb.collection(fb.db, 'groups', state.groupId, 'activity'), {
      uid: state.user.uid,
      email: state.user.email || '',
      action,
      timestamp: Date.now(),
    });
  } catch (e) { /* activity logs are best-effort */ }
}

// ---- auth state change wiring ----

export function startAuthListener() {
  if (!fb) return;
  fb.onAuthStateChanged(fb.auth, async user => {
    state.user = user;
    if (user && !user.isAnonymous) {
      await ensureUserDoc(user);
      await loadUserGroup();
    } else {
      clearListeners();
      state.groupId = null;
      state.groupDoc = null;
      state.members = [];
    }
    updateAccountUI();
    renderGroupSection();
  });
}
