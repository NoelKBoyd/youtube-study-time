// Loads the extension's own source files (unchanged) into isolated sandboxes.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { createFakeChrome } from './fake-chrome.js';

const root = new URL('../', import.meta.url);
const source = (file) => readFileSync(new URL(file, root), 'utf8');

// Runs background.js in a fresh context, like a service worker with no DOM.
// `get(name)` reads any top-level function or const, e.g. get('decodeHtml').
export function loadBackground({ storage = {}, fetch } = {}) {
  const chrome = createFakeChrome(storage);
  const context = vm.createContext({
    chrome,
    fetch: fetch || (async () => {
      throw new Error('fetch not stubbed in this test');
    }),
    URLSearchParams,
    console
  });
  vm.runInContext(source('background.js'), context, { filename: 'background.js' });
  return { chrome, context, get: (name) => vm.runInContext(name, context) };
}

// Runs content.js inside a jsdom page at the given YouTube URL.
// `html` is the page body before the script runs.
export function loadContent({ url = 'https://www.youtube.com/', html = '', storage = {}, search } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const chrome = createFakeChrome(storage);
  chrome.runtime.messageHandler = async (msg) => {
    if (msg.type === 'search') return search ? search(msg) : { items: [], nextPageToken: '' };
  };

  // jsdom has no layout, so IntersectionObserver is missing. This version reports
  // the sentinel as visible every time it is observed, which drives the infinite scroll.
  const observers = [];
  window.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.connected = true;
      observers.push(this);
    }
    observe(target) {
      if (!this.connected) return;
      queueMicrotask(() => this.connected && this.callback([{ isIntersecting: true, target }], this));
    }
    unobserve() {}
    disconnect() {
      this.connected = false;
    }
  };

  window.chrome = chrome;
  // Run it as a classic script in the page's context, so its top-level consts
  // (ERROR_MESSAGES, MAX_PAGES, ...) stay readable by later get() calls.
  const vmContext = dom.getInternalVMContext();
  vm.runInContext(source('content.js'), vmContext, { filename: 'content.js' });
  const page = {
    dom,
    window,
    document: window.document,
    chrome,
    observers,
    get: (name) => vm.runInContext(name, vmContext),
    close: () => {
      if (window.closed) return;
      vm.runInContext('removePanel()', vmContext);
      window.close();
    }
  };
  openPages.add(page);
  return page;
}

// Every page created by loadContent, so tests can close them even after a failed assertion
// (an open page keeps its countdown timer running and stops Node from exiting).
const openPages = new Set();
export function closeAllPages() {
  for (const page of openPages) page.close();
  openPages.clear();
}

// Waits for pending promises and microtasks to settle.
export const flush = (times = 10) =>
  new Promise((resolve) => {
    let n = 0;
    const step = () => (++n >= times ? resolve() : setImmediate(step));
    setImmediate(step);
  });
