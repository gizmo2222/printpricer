// Preloaded with `node --import ./tests/setup.js --test ...`.
//
// The app is plain browser ES modules, so before any test imports it we:
//   1. map the Firebase CDN imports to a local stub (firebase.js does a
//      top-level `await import('https://www.gstatic.com/...')`);
//   2. strip the `?v=N` cache-busting query from app module URLs, so a test
//      that imports `state.js` shares the instance that `calc.js?v=35` sees,
//      and bumping N never breaks the tests;
//   3. install fake browser globals (localStorage, document, rAF, JSZip).

import { registerHooks } from 'node:module';
import './helpers/env.js';
import { JSZip } from './stubs/jszip.js';

const FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/';
const FIREBASE_STUB = new URL('./stubs/firebase.js', import.meta.url).href;
const APP_DIR = new URL('../printpricer/js/', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(FIREBASE_CDN)) {
      return { url: FIREBASE_STUB, shortCircuit: true };
    }
    const result = nextResolve(specifier, context);
    if (result.url.startsWith(APP_DIR)) {
      return { ...result, url: result.url.replace(/\?v=\d+$/, '') };
    }
    return result;
  },
});

globalThis.JSZip = JSZip;
