// Account pill, sign-in modal, and the group section inside the Defaults pane.

import { CLOUD_ENABLED, state } from './state.js?v=23';
import { toast } from './ui.js?v=23';
import { doSignIn, doSignUp, doSignOut, createGroup, joinGroupByCode, leaveGroup } from './firebase.js?v=23';

export function updateAccountUI() {
  const cell = document.getElementById('account-pill');
  const who = document.getElementById('account-who');
  const cfgWarn = document.getElementById('config-warning');
  if (!cell) return;

  if (!CLOUD_ENABLED) {
    cell.classList.remove('signed-in', 'in-group');
    who.textContent = 'Local only';
    if (cfgWarn) cfgWarn.style.display = 'block';
    return;
  }
  if (cfgWarn) cfgWarn.style.display = 'none';

  if (!state.user || state.user.isAnonymous) {
    cell.classList.remove('signed-in', 'in-group');
    who.textContent = 'Local mode';
    return;
  }
  const email = state.user.email || 'Signed in';
  if (state.groupId && state.groupDoc) {
    cell.classList.add('signed-in', 'in-group');
    who.textContent = state.groupDoc.name || email;
  } else {
    cell.classList.add('signed-in');
    cell.classList.remove('in-group');
    who.textContent = email;
  }
}

export function renderGroupSection() {
  const loggedOut = document.getElementById('group-content-loggedout');
  const loggedIn = document.getElementById('group-content-loggedin');
  const noGroup = document.getElementById('group-no-group');
  const inGroup = document.getElementById('group-in-group');
  if (!loggedOut) return;

  // Earn the Account & Group block-detail callout
  const callout = document.getElementById('block-detail-account');
  if (callout) {
    let label;
    if (!CLOUD_ENABLED) label = 'CLOUD OFF';
    else if (!state.user || state.user.isAnonymous) label = 'LOCAL';
    else if (state.groupId && state.groupDoc) label = `GROUP · ${state.members.length} MEMBER${state.members.length !== 1 ? 'S' : ''}`;
    else label = 'PERSONAL';
    callout.classList.add('active-info');
    callout.innerHTML = `${label}<span class="id">A</span>`;
  }

  if (!state.user || state.user.isAnonymous) {
    loggedOut.style.display = '';
    loggedIn.style.display = 'none';
    return;
  }
  loggedOut.style.display = 'none';
  loggedIn.style.display = '';
  document.getElementById('group-acct-email').textContent = state.user.email || '—';

  if (state.groupId && state.groupDoc) {
    document.getElementById('group-acct-name').textContent = state.groupDoc.name;
    document.getElementById('group-acct-name').classList.remove('dim');
    noGroup.style.display = 'none';
    inGroup.style.display = '';
    document.getElementById('group-code-display').textContent = state.groupDoc.joinCode || '——';
    const list = document.getElementById('group-member-list');
    list.innerHTML = '';
    state.members.forEach(m => {
      const li = document.createElement('li');
      if (m.uid === state.user.uid) li.classList.add('you');
      li.textContent = m.email;
      list.appendChild(li);
    });
  } else {
    document.getElementById('group-acct-name').textContent = '— not in a group —';
    document.getElementById('group-acct-name').classList.add('dim');
    noGroup.style.display = '';
    inGroup.style.display = 'none';
  }
}

function openAccountModal() {
  const m = document.getElementById('account-modal');
  const signedIn = state.user && !state.user.isAnonymous;
  document.getElementById('auth-signin').style.display   = signedIn ? 'none' : '';
  document.getElementById('auth-signedin').style.display = signedIn ? '' : 'none';
  if (signedIn) {
    document.getElementById('signed-in-email').textContent = state.user.email || '—';
    document.getElementById('sync-status').textContent = state.groupId ? 'Live · synced to group' : 'Signed in · personal sync';
  }
  document.getElementById('account-modal-title').textContent = signedIn ? 'Account' : 'Sign In';
  document.getElementById('auth-error').classList.remove('show');
  m.classList.add('show');
}
function closeAccountModal() {
  document.getElementById('account-modal').classList.remove('show');
}
function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.add('show');
}

export function initAuthUI() {
  const pill = document.getElementById('account-pill');
  pill.addEventListener('click', openAccountModal);
  pill.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAccountModal(); }
  });
  document.getElementById('account-modal-close').addEventListener('click', closeAccountModal);
  document.getElementById('account-modal').addEventListener('click', e => {
    if (e.target.id === 'account-modal') closeAccountModal();
  });
  document.querySelectorAll('[data-auth-tab]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-auth-tab]').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('[data-auth-section]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelector(`[data-auth-section="${b.dataset.authTab}"]`).classList.add('active');
    });
  });

  document.getElementById('btn-signin').addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    if (!email || !password) { showAuthError('Email and password required'); return; }
    try { await doSignIn(email, password); closeAccountModal(); toast('Signed in'); }
    catch (e) { showAuthError(e.message || 'Sign-in failed'); }
  });
  document.getElementById('btn-signup').addEventListener('click', async () => {
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    if (!email || !password) { showAuthError('Email and password required'); return; }
    if (password.length < 8) { showAuthError('Password must be at least 8 characters'); return; }
    try { await doSignUp(email, password); closeAccountModal(); toast('Account created'); }
    catch (e) { showAuthError(e.message || 'Sign-up failed'); }
  });
  document.getElementById('btn-stay-local').addEventListener('click', closeAccountModal);
  document.getElementById('btn-stay-local-2').addEventListener('click', closeAccountModal);
  document.getElementById('btn-signout').addEventListener('click', async () => {
    await doSignOut(); closeAccountModal(); toast('Signed out');
  });
  document.getElementById('btn-acct-signout').addEventListener('click', async () => {
    await doSignOut(); toast('Signed out');
  });
  document.getElementById('group-signin-btn').addEventListener('click', openAccountModal);

  document.getElementById('btn-create-group').addEventListener('click', async () => {
    const name = document.getElementById('group-create-name').value;
    try { await createGroup(name); toast('Group created · share the code'); document.getElementById('group-create-name').value = ''; }
    catch (e) { toast(e.message || 'Could not create group', true); }
  });
  document.getElementById('btn-join-group').addEventListener('click', async () => {
    const code = document.getElementById('group-join-code').value;
    if (!code.trim()) { toast('Enter a code first', true); return; }
    try { await joinGroupByCode(code); toast('Joined group'); document.getElementById('group-join-code').value = ''; }
    catch (e) { toast(e.message || 'Could not join', true); }
  });
  document.getElementById('btn-leave-group').addEventListener('click', async () => {
    if (!confirm('Leave this group? Your local cache stays in this browser.')) return;
    try { await leaveGroup(); toast('Left the group'); }
    catch (e) { toast(e.message || 'Could not leave', true); }
  });
  document.getElementById('group-code-display').addEventListener('click', e => {
    const code = e.target.textContent.trim();
    if (!code || code.includes('—')) return;
    navigator.clipboard?.writeText(code).then(() => toast('Code copied'));
  });
}
