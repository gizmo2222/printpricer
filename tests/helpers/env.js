// Minimal browser globals for the app modules: an in-memory localStorage,
// a document whose getElementById always returns a stub element (created on
// first use and kept until resetEnv), and requestAnimationFrame.

const elements = new Map();
const store = new Map();

function makeElement(id) {
  const classes = new Set();
  const attrs = new Set();
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: c => classes.has(c),
    },
    toggleAttribute(name, force) {
      const on = force === undefined ? !attrs.has(name) : !!force;
      if (on) attrs.add(name); else attrs.delete(name);
      return on;
    },
    hasAttribute: name => attrs.has(name),
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    click() {},
  };
}

/** The stub element for an id (the same object the app sees). */
export function el(id) {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
}

/** Clear all stub elements and localStorage. */
export function resetEnv() {
  elements.clear();
  store.clear();
}

globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
  clear: () => store.clear(),
  key: i => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

globalThis.document = {
  getElementById: el,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: tag => makeElement(tag),
  body: makeElement('body'),
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
};

globalThis.window = globalThis;
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
