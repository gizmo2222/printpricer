// Group activity feed — shows who did what.

import { state } from './state.js?v=12';
import { escapeHtml } from './utils.js?v=12';

export function renderActivity(events) {
  const list = document.getElementById('activity-list');
  const wrap = document.getElementById('activity-wrap');
  if (!list || !wrap) return;
  if (!state.groupId || !events.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  list.innerHTML = '';
  events.slice(0, 20).forEach(e => {
    const d = new Date(+e.timestamp || 0);
    const item = document.createElement('div');
    item.className = 'activity-item';
    item.innerHTML = `
      <span class="activity-when"></span>
      <span class="activity-who"></span>
      <span class="activity-action"></span>
    `;
    item.querySelector('.activity-when').textContent = d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    item.querySelector('.activity-who').textContent = e.email || e.uid || '?';
    item.querySelector('.activity-action').textContent = e.action || '';
    list.appendChild(item);
  });
}
