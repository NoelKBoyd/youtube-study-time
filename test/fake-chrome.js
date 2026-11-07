// A small in-memory stand-in for the chrome.* APIs the extension uses,
// so background.js and content.js can run under Node without a browser.

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn) >>> 0, 1),
    // Test helper: call every listener, return what they returned.
    fire: (...args) => listeners.map((fn) => fn(...args))
  };
}

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

export function createFakeChrome(initialStorage = {}) {
  const store = structuredClone(initialStorage);
  const onChanged = event();

  function emit(changes) {
    if (Object.keys(changes).length) onChanged.fire(changes, 'local');
  }

  const local = {
    async get(keys) {
      if (keys === null || keys === undefined) return clone(store);
      if (typeof keys === 'string') keys = [keys];
      const result = {};
      if (Array.isArray(keys)) {
        for (const key of keys) if (key in store) result[key] = clone(store[key]);
      } else {
        for (const [key, fallback] of Object.entries(keys)) {
          result[key] = key in store ? clone(store[key]) : fallback;
        }
      }
      return result;
    },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: clone(store[key]), newValue: clone(value) };
        store[key] = clone(value);
      }
      emit(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const key of [].concat(keys)) {
        if (key in store) {
          changes[key] = { oldValue: store[key] };
          delete store[key];
        }
      }
      emit(changes);
    },
    async clear() {
      await local.remove(Object.keys(store));
    }
  };

  const alarms = new Map();
  const sentMessages = [];

  const chrome = {
    storage: { local, onChanged },
    alarms: {
      async create(name, info) {
        alarms.set(name, info);
      },
      async clear(name) {
        return alarms.delete(name);
      },
      async get(name) {
        return alarms.get(name);
      },
      onAlarm: event()
    },
    action: {
      badge: { text: '', color: null },
      async setBadgeText({ text }) {
        chrome.action.badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        chrome.action.badge.color = color;
      }
    },
    notifications: {
      created: [],
      cleared: [],
      // Accepts create(options) or create(id, options), like Chrome.
      create(id, options) {
        chrome.notifications.created.push(typeof id === 'string' ? { id, ...options } : id);
      },
      clear(id) {
        chrome.notifications.cleared.push(id);
      },
      onClicked: event()
    },
    tabs: {
      created: [],
      async create(info) {
        chrome.tabs.created.push(info);
      }
    },
    runtime: {
      onMessage: event(),
      onStartup: event(),
      onInstalled: event(),
      optionsOpened: 0,
      getURL: (path) => 'chrome-extension://test-id/' + path,
      openOptionsPage() {
        chrome.runtime.optionsOpened++;
      },
      sentMessages,
      // Tests replace this to answer messages from content/popup scripts.
      messageHandler: async () => undefined,
      async sendMessage(msg) {
        sentMessages.push(structuredClone(msg));
        return chrome.runtime.messageHandler(msg);
      }
    },
    // Test-only access to internals.
    _store: store,
    _alarms: alarms
  };
  return chrome;
}

// Sends a message the way chrome.runtime.sendMessage would reach background.js,
// and resolves with whatever the listener passes to sendResponse.
export function sendToBackground(chrome, msg) {
  return new Promise((resolve) => {
    let replied = false;
    const sendResponse = (value) => {
      replied = true;
      // Objects made inside the sandbox have its own Object prototype; copy them
      // into this realm so assert.deepEqual compares them by value.
      resolve(structuredClone(value));
    };
    const results = chrome.runtime.onMessage.fire(msg, {}, sendResponse);
    if (!replied && !results.includes(true)) resolve(undefined);
  });
}
