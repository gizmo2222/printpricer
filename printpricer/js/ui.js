// Shared UI primitives: toast (with sticky errors and undo affordance),
// the picker overlay used by both spool and printer pickers, and the tab
// switcher.

let toastTimer = null;
let toastClickHandler = null;
let undoHandler = null;

export function toast(msg, isError, variant) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('error', 'stamp', 'undo');
  if (isError) t.classList.add('error');
  if (variant === 'stamp') t.classList.add('stamp');
  t.classList.add('show');

  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (toastClickHandler) { t.removeEventListener('click', toastClickHandler); toastClickHandler = null; }
  undoHandler = null;

  if (isError) {
    // Sticky: stays until clicked.
    console.error('[toast]', msg);
    toastClickHandler = () => { t.classList.remove('show'); };
    t.addEventListener('click', toastClickHandler, { once: true });
  } else {
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }
}

// A toast with an "Undo" affordance. The undoFn runs on click; auto-dismisses
// after `windowMs` (default 5000).
export function toastWithUndo(msg, undoFn, windowMs = 5000) {
  const t = document.getElementById('toast');
  t.classList.remove('error', 'stamp');
  t.classList.add('show', 'undo');
  t.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'toast-undo-btn';
  btn.type = 'button';
  btn.textContent = 'Undo';
  t.appendChild(text);
  t.appendChild(btn);

  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (toastClickHandler) { t.removeEventListener('click', toastClickHandler); toastClickHandler = null; }
  undoHandler = undoFn;

  const close = () => { t.classList.remove('show', 'undo'); undoHandler = null; };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (undoHandler) undoHandler();
    close();
  }, { once: true });

  toastTimer = setTimeout(close, windowMs);
}

// Generic picker overlay — used by spool picker (filaments.js) and the
// active-printer picker (printers.js). Caller supplies a title and a list
// of items. Each item has { swatchColor, name, meta, accent, onPick }.
export function openPicker({ title, items, emptyMessage }) {
  const overlay = document.getElementById('picker-overlay');
  const list = document.getElementById('picker-list');
  const head = document.querySelector('.picker-head h3');
  if (head) head.textContent = title;
  list.innerHTML = '';
  if (!items.length && emptyMessage) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = emptyMessage;
    list.appendChild(empty);
  } else {
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'picker-item';
      btn.type = 'button';
      const accentMark = item.accent ? '✓' : '';
      btn.innerHTML = `
        <div class="picker-swatch" style="background:${item.swatchColor || 'var(--paper-dim)'}"></div>
        <div>
          <div class="picker-name"></div>
          <div class="picker-meta"></div>
        </div>
        <div class="picker-cost"></div>
      `;
      btn.querySelector('.picker-name').textContent = item.name;
      btn.querySelector('.picker-meta').textContent = item.meta || '';
      btn.querySelector('.picker-cost').textContent = item.costLabel || accentMark;
      btn.addEventListener('click', () => { closePicker(); item.onPick(); });
      list.appendChild(btn);
    });
  }
  overlay.classList.add('show');
}

export function closePicker() {
  document.getElementById('picker-overlay').classList.remove('show');
}

export function initPickerOverlay() {
  document.getElementById('picker-close').addEventListener('click', closePicker);
  document.getElementById('picker-overlay').addEventListener('click', e => {
    if (e.target.id === 'picker-overlay') closePicker();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closePicker();
      // Also close account modal if open.
      const m = document.getElementById('account-modal');
      if (m && m.classList.contains('show')) m.classList.remove('show');
    }
  });
}

// Tab switcher with per-pane on-show callback.
const tabHandlers = {};
export function onPaneShow(pane, fn) { tabHandlers[pane] = fn; }

export function initTabs() {
  document.querySelectorAll('.layer').forEach(tab => {
    tab.addEventListener('click', () => {
      const pane = tab.dataset.pane;
      document.querySelectorAll('.layer').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('pane-' + pane).classList.add('active');
      if (tabHandlers[pane]) tabHandlers[pane]();
    });
  });
}

export function activePane() {
  return document.querySelector('.layer.active')?.dataset.pane || null;
}

export function switchToPane(pane) {
  document.querySelector(`.layer[data-pane="${pane}"]`)?.click();
}

// Pending-writes indicator inside the title-block account cell.
//   pending > 0  → "syncing N"
//   pending = 0  → "synced ✓" (briefly), then blank
let lastPending = 0;
let syncedFlashTimer = null;
export function updateSyncIndicator(pending) {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  if (pending > 0) {
    el.textContent = ` · syncing ${pending}`;
    el.classList.add('pending');
    el.classList.remove('complete');
  } else if (lastPending > 0) {
    // Just transitioned to caught-up — show a brief stamp moment.
    el.textContent = ' · synced ✓';
    el.classList.remove('pending');
    el.classList.add('complete');
    if (syncedFlashTimer) clearTimeout(syncedFlashTimer);
    syncedFlashTimer = setTimeout(() => {
      el.textContent = '';
      el.classList.remove('complete');
    }, 1500);
  } else {
    el.textContent = '';
    el.classList.remove('pending', 'complete');
  }
  lastPending = pending;
}
