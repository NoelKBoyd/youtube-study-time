// The settings page, the popup's goal row, and the shared icons in ui.js.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadPage, flush, closeAllPages } from './load.js';

afterEach(closeAllPages);

const root = new URL('../extension/', import.meta.url);
const source = (file) => readFileSync(new URL(file, root), 'utf8');

// ---------- Icons ----------

test('every icon the pages and scripts ask for exists in ui.js', () => {
  const page = loadPage('options/options.html', ['shared/ui.js']);
  const icons = page.get('ICON_PATHS');
  const used = new Set();
  // ui.js itself is skipped: its comments mention data-icon="name".
  const files = readdirSync(root, { recursive: true })
    .map((name) => name.replaceAll('\\', '/'))
    .filter((name) => /\.(html|js)$/.test(name) && name !== 'shared/ui.js');
  for (const file of files) {
    const text = source(file);
    for (const [, name] of text.matchAll(/data-icon="([a-z_]+)"/g)) used.add(name);
    for (const [, name] of text.matchAll(/makeIcon\('([a-z_]+)'/g)) used.add(name);
  }
  // Icons picked from a lookup table at runtime
  for (const name of ['check_circle', 'stop_circle', 'error', 'schedule']) used.add(name);
  const missing = [...used].filter((name) => !icons[name]);
  assert.deepEqual(missing, []);
  assert.ok(used.size > 15);
});

test('fillIcons swaps data-icon placeholders for SVG icons, keeping their classes', () => {
  const page = loadPage('options/options.html', ['shared/ui.js', 'options/options.js']);
  assert.equal(page.document.querySelectorAll('[data-icon]').length, 0);
  const key = page.document.querySelector('.yst-field > svg.yst-icon');
  assert.ok(key);
  assert.equal(key.getAttribute('aria-hidden'), 'true');
  assert.ok(page.document.querySelector('#toggle-key svg.show-icon'));
});

// ---------- Settings ----------

test('the settings page shows the YouTube API Services notice and policy links', () => {
  const page = loadPage('options/options.html', ['shared/ui.js']);
  const terms = page.document.querySelector('.api-terms');
  assert.match(terms.textContent, /This extension uses YouTube API Services\./);
  const links = [...terms.querySelectorAll('a')].map((a) => [a.textContent.trim(), a.href, a.target]);
  assert.deepEqual(links, [
    ['Privacy policy', 'https://github.com/NoelKBoyd/youtube-study-time/blob/main/PRIVACY.md', '_blank'],
    ['YouTube Terms of Service', 'https://www.youtube.com/t/terms', '_blank'],
    ['Google Privacy Policy', 'https://policies.google.com/privacy', '_blank'],
  ]);
});

async function openOptions(storage = {}, messageHandler) {
  const page = loadPage('options/options.html', ['shared/ui.js', 'options/options.js'], { storage, messageHandler });
  await flush();
  return page;
}

test('settings: Save stores the key and confirms it in a snackbar', async () => {
  const page = await openOptions();
  const doc = page.document;
  doc.getElementById('api-key').value = '  my-key ';
  doc.getElementById('save').click();
  await flush();
  assert.equal(page.chrome._store.apiKey, 'my-key');
  const snackbar = doc.querySelector('.yst-snackbar');
  assert.equal(snackbar.textContent, 'Key saved.');
  assert.ok(snackbar.classList.contains('yst-show'));
  assert.equal(snackbar.getAttribute('role'), 'status');

  doc.getElementById('api-key').value = '';
  doc.getElementById('save').click();
  await flush();
  assert.equal(page.chrome._store.apiKey, undefined);
  assert.equal(doc.querySelector('.yst-snackbar').textContent, 'Key removed.');
});

test('settings: Test key shows the result in an inline banner', async () => {
  let answer = { ok: true };
  const page = await openOptions({}, async (msg) => (msg.type === 'testKey' ? answer : undefined));
  const doc = page.document;
  const status = doc.getElementById('status');
  assert.equal(status.hidden, true);

  doc.getElementById('test').click();
  assert.equal(status.textContent, 'Paste a key first.');
  assert.ok(status.classList.contains('yst-error'));

  doc.getElementById('api-key').value = 'good';
  doc.getElementById('test').click();
  await flush();
  assert.equal(status.hidden, false);
  assert.ok(status.classList.contains('yst-success'));
  assert.equal(status.textContent, 'The key works. Remember to click Save.');
  assert.ok(status.querySelector('svg.yst-icon'));

  answer = { error: 'quota' };
  doc.getElementById('test').click();
  await flush();
  assert.ok(status.classList.contains('yst-error'));
  assert.match(status.textContent, /search limit is used up/);
});

test('settings: the eye button shows and hides the key', async () => {
  const page = await openOptions({ apiKey: 'secret' });
  const input = page.document.getElementById('api-key');
  const toggle = page.document.getElementById('toggle-key');
  assert.equal(input.value, 'secret');
  assert.equal(input.type, 'password');
  toggle.click();
  assert.equal(input.type, 'text');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Hide key');
  toggle.click();
  assert.equal(input.type, 'password');
  assert.equal(toggle.getAttribute('aria-label'), 'Show key');
});

test('settings: Clear saved results removes only cached pages', async () => {
  const page = await openOptions({ apiKey: 'k', 'cache:rust|': {}, 'cache:go|abc': {}, lastTopic: 'Rust' });
  page.document.getElementById('clear-cache').click();
  await flush();
  assert.deepEqual(Object.keys(page.chrome._store).sort(), ['apiKey', 'lastTopic']);
  assert.equal(page.document.querySelector('.yst-snackbar').textContent, 'Cleared 2 saved result page(s).');
});

// ---------- Popup ----------

test('popup: today row shows the daily goal and its progress when one is set', async () => {
  const now = Date.now();
  const page = loadPage('popup/popup.html', ['shared/shared.js', 'shared/ui.js', 'popup/popup.js'], {
    storage: {
      goals: { dailyMin: 60, weeklyMin: 0, perTopic: {} },
      sessionLog: [{ id: 'a', topic: 'x', topicKey: 'x', endedAt: now - 1000, actualMin: 15 }]
    }
  });
  await flush();
  const doc = page.document;
  assert.equal(doc.getElementById('today').hidden, false);
  assert.equal(doc.getElementById('today-total').textContent, 'Today: 15 m');
  assert.equal(doc.getElementById('today-goal').textContent, ' of 1 h');
  const progress = doc.getElementById('today-progress');
  assert.equal(progress.hidden, false);
  assert.equal(progress.querySelector('.yst-progress-fill').style.width, '25%');
});

test('popup: with nothing today and no goal, the today row is hidden', async () => {
  const page = loadPage('popup/popup.html', ['shared/shared.js', 'shared/ui.js', 'popup/popup.js'], { storage: {} });
  await flush();
  assert.equal(page.document.getElementById('today').hidden, true);
  assert.equal(page.document.getElementById('today-total').textContent, '');
});
