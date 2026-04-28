// Pure helpers — no DOM, no state.

export function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

export function fmt(n) {
  return '$' + n.toFixed(2);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function formatHours(h) {
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return `${hrs}h ${mins}m`;
}

// Parse "1d 2h 3m 4s" or "1:23:45" → hours.
export function parseTimeStr(s) {
  let total = 0;
  const d = s.match(/(\d+)\s*d/i);   if (d)   total += parseInt(d[1])   * 86400;
  const h = s.match(/(\d+)\s*h/i);   if (h)   total += parseInt(h[1])   * 3600;
  const m = s.match(/(\d+)\s*m(?!s)/i); if (m) total += parseInt(m[1])   * 60;
  const sec = s.match(/(\d+)\s*s(?!\w)/i); if (sec) total += parseInt(sec[1]);
  if (total === 0) {
    const c = s.match(/(\d+):(\d{1,2}):(\d{1,2})/);
    if (c) total = (+c[1]) * 3600 + (+c[2]) * 60 + (+c[3]);
  }
  return total / 3600;
}

// requestAnimationFrame-debounced wrapper. The returned function may be
// called many times per frame; the underlying fn runs once on the next
// frame. Used to coalesce burst updates (e.g. multiple Firestore listener
// emissions in the same tick).
export function rafDebounce(fn) {
  let scheduled = false;
  return (...args) => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...args);
    });
  };
}

// 6-char join-code generator (no easily-confused characters).
export function generateJoinCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s.slice(0, 3) + '-' + s.slice(3);
}

// Convert an array of objects to a CSV string. Headers are the union of all
// keys in order of first appearance, with overrides supported.
export function toCsv(rows, columns) {
  if (!rows.length) return '';
  const cols = columns || [...rows.reduce((set, r) => {
    Object.keys(r).forEach(k => set.add(k));
    return set;
  }, new Set())];
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const header = cols.map(escape).join(',');
  const body = rows.map(r => cols.map(c => escape(r[c])).join(',')).join('\n');
  return header + '\n' + body + '\n';
}

// Trigger a browser download of arbitrary text content.
export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}
