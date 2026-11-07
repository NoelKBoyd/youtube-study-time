import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, flush, closeAllPages } from './load.js';

afterEach(closeAllPages);

const STATS_SCRIPTS = ['shared.js', 'stats.js'];

// Midday `daysAgo` local days back (or now, if today's midday hasn't come yet).
function dayAt(daysAgo) {
  const now = new Date();
  const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12).getTime();
  return Math.min(noon, now.getTime());
}

let nextId = 0;
function record(daysAgo, actualMin, { outcome = 'completed', topic = 'Rust', plannedMin = actualMin } = {}) {
  const endedAt = dayAt(daysAgo);
  return {
    id: 'r' + nextId++,
    topic,
    topicKey: topic.trim().toLowerCase(),
    startedAt: endedAt - actualMin * 60000,
    endedAt,
    plannedMin,
    actualMin,
    outcome
  };
}

async function openStats(storage, messageHandler) {
  const page = loadPage('stats.html', STATS_SCRIPTS, { storage, messageHandler });
  await flush();
  return page;
}

const text = (page, id) => page.document.getElementById(id).textContent;
const rows = (page, table) => [...page.document.querySelectorAll(`#${table} tbody tr`)];
const cells = (row) => [...row.children].map((cell) => cell.textContent);

test('with no history: zero tiles, empty messages, nothing to export or clear', async () => {
  const page = await openStats({});
  assert.equal(text(page, 'tile-today'), '0 m');
  assert.equal(text(page, 'tile-week'), '0 m');
  assert.equal(text(page, 'tile-streak'), '0 days');
  assert.equal(text(page, 'tile-best'), '0 days');
  assert.equal(page.document.getElementById('topics-empty').hidden, false);
  assert.equal(page.document.getElementById('history-empty').hidden, false);
  assert.equal(page.document.getElementById('clear').disabled, true);
  assert.equal(page.document.getElementById('export').disabled, true);
  assert.match(text(page, 'goal-bars'), /No goals set/);
});

test('today and this week count session time from completed and stopped sessions', async () => {
  const page = await openStats({
    sessionLog: [
      record(0, 30),
      record(0, 12.4, { outcome: 'stopped' }),
      record(8, 500) // more than a week ago
    ]
  });
  assert.equal(text(page, 'tile-today'), '42 m');
  assert.equal(text(page, 'tile-week'), '42 m');
});

test('streaks with no daily goal: days with a completed session', async () => {
  const page = await openStats({});
  const computeStreaks = page.get('computeStreaks');
  const goals = { dailyMin: 0 };
  // Yesterday and the day before; today has nothing yet, so the streak is still alive.
  assert.deepEqual({ ...computeStreaks([record(1, 10), record(2, 10)], goals) }, { current: 2, best: 2 });
  // A day with only a stopped session doesn't count.
  assert.deepEqual(
    { ...computeStreaks([record(0, 10), record(1, 50, { outcome: 'stopped' }), record(2, 10), record(3, 10), record(4, 10)], goals) },
    { current: 1, best: 3 }
  );
  // Nothing yesterday or today: no current streak.
  assert.equal(computeStreaks([record(2, 10)], goals).current, 0);
});

test('streaks with a daily goal: the day total must reach it, stopped sessions included', async () => {
  const page = await openStats({});
  const computeStreaks = page.get('computeStreaks');
  const goals = { dailyMin: 30 };
  const log = [
    record(0, 20, { outcome: 'stopped' }),
    record(0, 15, { outcome: 'stopped' }), // today: 35 min, all stopped -> counts
    record(1, 25), // yesterday: completed but under the goal -> breaks the streak
    record(2, 30),
    record(3, 45)
  ];
  assert.deepEqual({ ...computeStreaks(log, goals) }, { current: 1, best: 2 });
});

test('topics group by trimmed, lowercased text, show the latest spelling, and sort by column', async () => {
  const page = await openStats({
    sessionLog: [
      record(3, 50, { topic: 'rust' }),
      record(1, 20, { topic: 'Rust ' }),
      record(2, 90, { topic: 'Go' }),
      record(0, 5, { topic: 'algebra' })
    ]
  });
  const names = () => rows(page, 'topics-table').map((row) => row.querySelector('th').textContent);
  // Default: most total time first.
  assert.deepEqual(names(), ['Go', 'Rust ', 'algebra']);
  const rust = cells(rows(page, 'topics-table')[1]);
  assert.deepEqual(rust.slice(1, 3), ['1 h 10 m', '2']);
  assert.match(rust[4], /2 · Curious/);

  const sortBy = (column) => page.document.querySelector(`.sort[data-sort="${column}"]`).click();
  sortBy('topic');
  assert.deepEqual(names(), ['algebra', 'Go', 'Rust ']);
  sortBy('topic');
  assert.deepEqual(names(), ['Rust ', 'Go', 'algebra']);
  sortBy('lastAt');
  assert.deepEqual(names(), ['algebra', 'Rust ', 'Go']);
  sortBy('sessions');
  assert.equal(names()[0], 'Rust ');
  assert.equal(page.document.querySelector('[data-sort="sessions"]').closest('th').getAttribute('aria-sort'), 'descending');
});

test('history is newest first, deletes one entry via the background, and pages by 50', async () => {
  const sessionLog = [record(2, 10, { topic: 'old' }), record(0, 20, { topic: 'new', outcome: 'stopped', plannedMin: 45 })];
  for (let i = 0; i < 60; i++) sessionLog.push(record(5, 1, { topic: 'filler' }));
  const page = await openStats({ sessionLog });

  const first = cells(rows(page, 'history-table')[0]);
  assert.equal(first[1], 'new');
  assert.deepEqual(first.slice(2, 5), ['45 m', '20 m', 'stopped']);
  assert.equal(rows(page, 'history-table').length, 50);

  const more = page.document.getElementById('more');
  assert.equal(more.hidden, false);
  more.click();
  assert.equal(rows(page, 'history-table').length, 62);
  assert.equal(more.hidden, true);

  rows(page, 'history-table')[0].querySelector('.delete').click();
  assert.deepEqual(page.chrome.runtime.sentMessages.at(-1), { type: 'deleteLog', id: sessionLog[1].id });
});

test('goals: saving daily and weekly minutes shows progress bars', async () => {
  const page = await openStats({ sessionLog: [record(0, 15)], goals: { dailyMin: 0, weeklyMin: 0, perTopic: {} } });
  const doc = page.document;
  doc.getElementById('goal-daily').value = '30';
  doc.getElementById('goal-weekly').value = '';
  doc.getElementById('goals-form').requestSubmit();
  await flush();

  assert.deepEqual(page.chrome._store.goals, { dailyMin: 30, weeklyMin: 0, perTopic: {} });
  const bars = doc.querySelectorAll('#goal-bars .goal');
  assert.equal(bars.length, 1);
  assert.match(bars[0].textContent, /15 m of 30 m/);
  assert.equal(bars[0].querySelector('.bar-fill').style.width, '50%');
  assert.match(text(page, 'streak-rule'), /reaches 30 m/);
});

test('a per-topic target is saved in minutes and shown on the topic row', async () => {
  const page = await openStats({ sessionLog: [record(0, 60, { topic: 'Rust' })] });
  const input = page.document.querySelector('.target-input');
  input.value = '2';
  input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(page.chrome._store.goals.perTopic, { rust: 120 });
  const row = rows(page, 'topics-table')[0];
  assert.equal(row.querySelector('.target-input').value, '2');
  assert.equal(row.querySelector('.bar-fill').style.width, '50%');

  const cleared = page.document.querySelector('.target-input');
  cleared.value = '';
  cleared.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(page.chrome._store.goals.perTopic, {});
});

test('Clear history asks first, then the background clears it and everything resets', async () => {
  const page = await openStats({ sessionLog: [record(0, 30), record(1, 30)] }, async (msg) => {
    if (msg.type === 'clearLog') await page.chrome.storage.local.set({ sessionLog: [] });
  });
  assert.equal(text(page, 'tile-streak'), '2 days');

  page.window.confirm = () => false;
  page.document.getElementById('clear').click();
  await flush();
  assert.equal(page.chrome.runtime.sentMessages.length, 0);

  page.window.confirm = () => true;
  page.document.getElementById('clear').click();
  await flush();
  assert.deepEqual(page.chrome.runtime.sentMessages, [{ type: 'clearLog' }]);
  assert.equal(text(page, 'tile-today'), '0 m');
  assert.equal(text(page, 'tile-streak'), '0 days');
  assert.equal(text(page, 'tile-best'), '0 days');
  assert.equal(rows(page, 'topics-table').length, 0);
  assert.equal(rows(page, 'history-table').length, 0);
});

test('a session logged while the page is open shows up right away', async () => {
  const page = await openStats({ sessionLog: [] });
  await page.chrome.storage.local.set({ sessionLog: [record(0, 25)] });
  await flush();
  assert.equal(text(page, 'tile-today'), '25 m');
  assert.equal(rows(page, 'history-table').length, 1);
});

test('Export JSON downloads the log and goals', async () => {
  const sessionLog = [record(0, 25)];
  const goals = { dailyMin: 20, weeklyMin: 0, perTopic: {} };
  const page = await openStats({ sessionLog, goals });
  let blob;
  const downloads = [];
  page.window.URL.createObjectURL = (b) => ((blob = b), 'blob:test');
  page.window.URL.revokeObjectURL = () => {};
  page.window.HTMLAnchorElement.prototype.click = function () {
    downloads.push(this.download);
  };
  page.document.getElementById('export').click();

  assert.equal(downloads.length, 1);
  assert.match(downloads[0], /^study-sessions-\d{4}-\d{2}-\d{2}\.json$/);
  // jsdom's Blob has no .text(), so read it the old way.
  const json = await new Promise((resolve) => {
    const reader = new page.window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  });
  const data = JSON.parse(json);
  assert.deepEqual(data.sessionLog, sessionLog);
  assert.deepEqual(data.goals, goals);
});

test('topic names and other text are inserted as text, never HTML', async () => {
  const page = await openStats({ sessionLog: [record(0, 5, { topic: '<img src=x onerror=alert(1)>' })] });
  assert.equal(page.document.querySelectorAll('img').length, 0);
  assert.equal(rows(page, 'history-table')[0].querySelector('th').textContent, '<img src=x onerror=alert(1)>');
});

// ---------- Popup ----------

test('popup shows today\'s session time and opens the stats page', async () => {
  const page = loadPage('popup.html', ['shared.js', 'popup.js'], {
    storage: { sessionLog: [record(0, 40), record(0, 20, { outcome: 'stopped' }), record(1, 99)] }
  });
  await flush();
  assert.equal(page.document.getElementById('today-total').textContent, 'Today: 1 h');
  page.document.getElementById('open-stats').click();
  assert.deepEqual(structuredClone(page.chrome.tabs.created), [{ url: 'chrome-extension://test-id/stats.html' }]);
  assert.equal(page.window.closeCalls, 1);
});
