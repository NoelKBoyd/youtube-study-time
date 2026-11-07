import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground, flush } from './load.js';
import { sendToBackground } from './fake-chrome.js';

const DAY = 24 * 60 * 60 * 1000;

function apiResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('start creates the session, alarm and badge', async () => {
  const { chrome } = loadBackground();
  const before = Date.now();
  const reply = await sendToBackground(chrome, { type: 'start', topic: 'calculus', minutes: 25 });

  assert.deepEqual(reply, { ok: true });
  const { session } = chrome._store;
  assert.equal(session.topic, 'calculus');
  assert.ok(session.endTime >= before + 25 * 60000 && session.endTime <= Date.now() + 25 * 60000);
  assert.equal(chrome._alarms.get('study-end').when, session.endTime);
  assert.equal(chrome.action.badge.text, 'ON');
});

test('start removes cache entries older than 24h and keeps fresh ones', async () => {
  const { chrome } = loadBackground({
    storage: {
      'cache:old|': { savedAt: Date.now() - DAY - 1000, data: {} },
      'cache:new|': { savedAt: Date.now(), data: {} },
      apiKey: 'k'
    }
  });
  await sendToBackground(chrome, { type: 'start', topic: 't', minutes: 1 });
  assert.ok(!('cache:old|' in chrome._store));
  assert.ok('cache:new|' in chrome._store);
  assert.equal(chrome._store.apiKey, 'k');
});

test('stop clears everything without a notification', async () => {
  const { chrome } = loadBackground();
  await sendToBackground(chrome, { type: 'start', topic: 't', minutes: 5 });
  await sendToBackground(chrome, { type: 'stop' });
  assert.ok(!('session' in chrome._store));
  assert.equal(chrome._alarms.size, 0);
  assert.equal(chrome.action.badge.text, '');
  assert.equal(chrome.notifications.created.length, 0);
});

test('the alarm ends the session and shows a notification', async () => {
  const { chrome } = loadBackground();
  await sendToBackground(chrome, { type: 'start', topic: 't', minutes: 5 });
  chrome.alarms.onAlarm.fire({ name: 'study-end' });
  await flush();
  assert.ok(!('session' in chrome._store));
  assert.equal(chrome.notifications.created.length, 1);
});

test('on browser startup, a running session gets its alarm and badge back', async () => {
  const endTime = Date.now() + 60000;
  const { chrome } = loadBackground({ storage: { session: { topic: 't', endTime } } });
  chrome.runtime.onStartup.fire();
  await flush();
  assert.equal(chrome._alarms.get('study-end').when, endTime);
  assert.equal(chrome.action.badge.text, 'ON');
});

test('on browser startup, an expired session is ended quietly', async () => {
  const { chrome } = loadBackground({ storage: { session: { topic: 't', endTime: Date.now() - 1 } } });
  chrome.runtime.onStartup.fire();
  await flush();
  assert.ok(!('session' in chrome._store));
  assert.equal(chrome.notifications.created.length, 0);
});

test('search without an API key returns nokey', async () => {
  const { chrome } = loadBackground();
  assert.deepEqual(await sendToBackground(chrome, { type: 'search', topic: 'x', pageToken: '' }), {
    error: 'nokey'
  });
});

test('search calls the API, trims results, and caches them', async () => {
  const calls = [];
  const { chrome } = loadBackground({
    storage: { apiKey: 'KEY' },
    fetch: async (url) => {
      calls.push(new URL(url));
      return apiResponse(200, {
        nextPageToken: 'P2',
        items: [
          {
            id: { videoId: 'abc' },
            snippet: { title: 'Rock &amp; Roll &#39;101&#39;', channelTitle: 'A &quot;B&quot;', publishedAt: '2024-01-01' }
          },
          { id: { channelId: 'not-a-video' }, snippet: {} }
        ]
      });
    }
  });

  const first = await sendToBackground(chrome, { type: 'search', topic: 'Physics', pageToken: '' });
  assert.deepEqual(first, {
    nextPageToken: 'P2',
    items: [
      {
        videoId: 'abc',
        title: "Rock & Roll '101'",
        channel: 'A "B"',
        thumbnail: 'https://i.ytimg.com/vi/abc/mqdefault.jpg',
        published: '2024-01-01'
      }
    ]
  });
  assert.equal(calls[0].searchParams.get('q'), 'Physics');
  assert.equal(calls[0].searchParams.get('key'), 'KEY');
  assert.equal(calls[0].searchParams.has('pageToken'), false);
  assert.ok('cache:physics|' in chrome._store);

  // Same topic, different case: served from cache, no second API call.
  const second = await sendToBackground(chrome, { type: 'search', topic: 'PHYSICS', pageToken: '' });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
});

test('an expired cache entry is fetched again', async () => {
  let calls = 0;
  const { chrome } = loadBackground({
    storage: { apiKey: 'K', 'cache:x|': { savedAt: Date.now() - DAY - 1, data: { items: [], nextPageToken: '' } } },
    fetch: async () => {
      calls++;
      return apiResponse(200, { items: [] });
    }
  });
  await sendToBackground(chrome, { type: 'search', topic: 'x', pageToken: '' });
  assert.equal(calls, 1);
});

test('API errors are reduced to short codes and not cached', async () => {
  const cases = [
    [{ error: { errors: [{ reason: 'quotaExceeded' }] } }, 'quota'],
    [{ error: { errors: [{ reason: 'accessNotConfigured' }] } }, 'disabled'],
    [{ error: { message: 'API key not valid. Please pass a valid API key.' } }, 'badkey'],
    [{ error: { message: 'something else' } }, 'api']
  ];
  for (const [body, code] of cases) {
    const { chrome } = loadBackground({ storage: { apiKey: 'K' }, fetch: async () => apiResponse(403, body) });
    const result = await sendToBackground(chrome, { type: 'search', topic: 't', pageToken: '' });
    assert.deepEqual(result, { error: code });
    assert.ok(!Object.keys(chrome._store).some((k) => k.startsWith('cache:')));
  }
});

test('a failed fetch returns network', async () => {
  const { chrome } = loadBackground({
    storage: { apiKey: 'K' },
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    }
  });
  assert.deepEqual(await sendToBackground(chrome, { type: 'search', topic: 't', pageToken: '' }), {
    error: 'network'
  });
});

test('testKey uses the given key, not the stored one', async () => {
  let key;
  const { chrome } = loadBackground({
    storage: { apiKey: 'OLD' },
    fetch: async (url) => {
      key = new URL(url).searchParams.get('key');
      return apiResponse(200, { items: [] });
    }
  });
  await sendToBackground(chrome, { type: 'testKey', apiKey: 'NEW' });
  assert.equal(key, 'NEW');
});

test('openOptions opens the options page', async () => {
  const { chrome } = loadBackground();
  await sendToBackground(chrome, { type: 'openOptions' });
  assert.equal(chrome.runtime.optionsOpened, 1);
});

// ---------- Session log ----------

const MIN = 60000;

// A running session that started `elapsedMin` ago and has `leftMin` to go.
function running(elapsedMin, leftMin, extra = {}) {
  const now = Date.now();
  return {
    id: 'sess-1',
    topic: 'Rust',
    startedAt: now - elapsedMin * MIN,
    segmentStart: now - elapsedMin * MIN,
    accumulatedMs: 0,
    endTime: now + leftMin * MIN,
    plannedMin: elapsedMin + leftMin,
    ...extra
  };
}

const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 0.1, `${label}: ${actual} is not about ${expected}`);

test('start gives the session an id, start time and an empty accumulator', async () => {
  const { chrome } = loadBackground();
  await sendToBackground(chrome, { type: 'start', topic: 'Rust', minutes: 30 });
  const { session } = chrome._store;
  assert.ok(session.id);
  assert.equal(session.accumulatedMs, 0);
  assert.equal(session.segmentStart, session.startedAt);
  assert.equal(session.plannedMin, 30);
  assert.ok(!('sessionLog' in chrome._store), 'nothing is logged at start');
});

test('the alarm logs one completed record with actualMin about planned', async () => {
  const { chrome } = loadBackground({ storage: { session: running(25, 0) } });
  chrome.alarms.onAlarm.fire({ name: 'study-end' });
  await flush();
  const [record, ...rest] = chrome._store.sessionLog;
  assert.equal(rest.length, 0);
  assert.equal(record.id, 'sess-1');
  assert.equal(record.topic, 'Rust');
  assert.equal(record.topicKey, 'rust');
  assert.equal(record.outcome, 'completed');
  assert.equal(record.plannedMin, 25);
  near(record.actualMin, 25, 'actualMin');
  assert.ok(!('session' in chrome._store));
  assert.equal(chrome.notifications.created[0].id, 'study-finished');
});

test('stopping early logs a stopped record with the real elapsed time', async () => {
  const { chrome } = loadBackground({ storage: { session: running(10, 20) } });
  await sendToBackground(chrome, { type: 'stop' });
  const [record] = chrome._store.sessionLog;
  assert.equal(record.outcome, 'stopped');
  assert.equal(record.plannedMin, 30);
  near(record.actualMin, 10, 'actualMin');
  assert.ok(Math.abs(record.endedAt - Date.now()) < 1000);
});

test('editing the minutes keeps the session and counts time before and after the edit', async () => {
  const { chrome } = loadBackground({ storage: { session: running(5, 25) } });
  // The panel's Edit: same topic (different case and spaces), 10 minutes left.
  await sendToBackground(chrome, { type: 'start', topic: ' rust ', minutes: 10 });
  const edited = chrome._store.session;
  assert.equal(edited.id, 'sess-1');
  near(edited.accumulatedMs / MIN, 5, 'accumulated');
  near(edited.plannedMin, 15, 'plannedMin');
  assert.ok(!('sessionLog' in chrome._store), 'an edit does not log');

  // Pretend the 10 minutes have passed, then the alarm fires.
  const later = { ...edited, segmentStart: edited.segmentStart - 10 * MIN, endTime: Date.now() };
  await chrome.storage.local.set({ session: later });
  chrome.alarms.onAlarm.fire({ name: 'study-end' });
  await flush();
  const [record] = chrome._store.sessionLog;
  assert.equal(record.outcome, 'completed');
  near(record.actualMin, 15, 'actualMin');
});

test('editing to a different topic logs the old session and starts a new one', async () => {
  const { chrome } = loadBackground({ storage: { session: running(8, 22) } });
  await sendToBackground(chrome, { type: 'start', topic: 'Go', minutes: 15 });
  const [record] = chrome._store.sessionLog;
  assert.equal(record.topic, 'Rust');
  assert.equal(record.outcome, 'stopped');
  near(record.actualMin, 8, 'actualMin');
  assert.notEqual(chrome._store.session.id, 'sess-1');
  assert.equal(chrome._store.session.topic, 'Go');
});

test('starting after the time ran out (alarm not fired yet) logs the old one as completed', async () => {
  const { chrome } = loadBackground({ storage: { session: running(30, -1) } });
  await sendToBackground(chrome, { type: 'start', topic: 'Rust', minutes: 10 });
  const [record] = chrome._store.sessionLog;
  assert.equal(record.outcome, 'completed');
  near(record.actualMin, 29, 'actualMin stops at the planned end');
  assert.notEqual(chrome._store.session.id, 'sess-1');
});

test('Stop and the alarm arriving together log exactly one record', async () => {
  const { chrome } = loadBackground({ storage: { session: running(30, 0) } });
  const stop = sendToBackground(chrome, { type: 'stop' });
  chrome.alarms.onAlarm.fire({ name: 'study-end' });
  chrome.alarms.onAlarm.fire({ name: 'study-end' });
  await stop;
  await flush();
  assert.equal(chrome._store.sessionLog.length, 1);
});

test('a session already in the log is not logged again', async () => {
  const { chrome } = loadBackground({
    storage: { session: running(5, 0), sessionLog: [{ id: 'sess-1', actualMin: 5 }] }
  });
  chrome.alarms.onAlarm.fire({ name: 'study-end' });
  await flush();
  assert.equal(chrome._store.sessionLog.length, 1);
  assert.ok(!('session' in chrome._store));
});

test('on browser startup after expiry: one completed record, capped at the planned end, no notification', async () => {
  const session = running(120, -60); // ran 60 min, ended an hour ago
  const { chrome } = loadBackground({ storage: { session } });
  chrome.runtime.onStartup.fire();
  await flush();
  const [record, ...rest] = chrome._store.sessionLog;
  assert.equal(rest.length, 0);
  assert.equal(record.outcome, 'completed');
  assert.equal(record.endedAt, session.endTime);
  near(record.actualMin, 60, 'actualMin');
  assert.equal(chrome.notifications.created.length, 0);
});

test('a session started before v1.1 (no id) ends without being logged', async () => {
  const { chrome } = loadBackground({ storage: { session: { topic: 't', endTime: Date.now() + MIN } } });
  await sendToBackground(chrome, { type: 'stop' });
  assert.ok(!('session' in chrome._store));
  assert.ok(!('sessionLog' in chrome._store));
});

test('"Rust" and " rust " land in the same topic', async () => {
  const { chrome } = loadBackground();
  await sendToBackground(chrome, { type: 'start', topic: 'Rust', minutes: 5 });
  await sendToBackground(chrome, { type: 'stop' });
  await sendToBackground(chrome, { type: 'start', topic: ' rust ', minutes: 5 });
  await sendToBackground(chrome, { type: 'stop' });
  assert.deepEqual(chrome._store.sessionLog.map((r) => r.topicKey), ['rust', 'rust']);
});

test('deleteLog removes one record, clearLog removes all', async () => {
  const sessionLog = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const { chrome } = loadBackground({ storage: { sessionLog } });
  assert.deepEqual(await sendToBackground(chrome, { type: 'deleteLog', id: 'b' }), { ok: true });
  assert.deepEqual(chrome._store.sessionLog.map((r) => r.id), ['a', 'c']);
  await sendToBackground(chrome, { type: 'clearLog' });
  assert.deepEqual(chrome._store.sessionLog, []);
});

test('install sets default goals once, without overwriting existing ones', async () => {
  const fresh = loadBackground();
  fresh.chrome.runtime.onInstalled.fire({ reason: 'install' });
  await flush();
  assert.deepEqual(structuredClone(fresh.chrome._store.goals), { dailyMin: 0, weeklyMin: 0, perTopic: {} });

  const goals = { dailyMin: 30, weeklyMin: 200, perTopic: { rust: 600 } };
  const updated = loadBackground({ storage: { goals } });
  updated.chrome.runtime.onInstalled.fire({ reason: 'update' });
  await flush();
  assert.deepEqual(updated.chrome._store.goals, goals);
});

test('clicking the finished notification, or openStats, opens the stats page', async () => {
  const { chrome } = loadBackground();
  chrome.notifications.onClicked.fire('study-finished');
  await sendToBackground(chrome, { type: 'openStats' });
  await sendToBackground(chrome, { type: 'openStats', section: 'goals' });
  assert.deepEqual(chrome.tabs.created.map((t) => t.url), [
    'chrome-extension://test-id/stats/stats.html',
    'chrome-extension://test-id/stats/stats.html',
    'chrome-extension://test-id/stats/stats.html#goals-heading'
  ]);
  assert.deepEqual(chrome.notifications.cleared, ['study-finished']);
});

// ---------- shared.js ----------

test('levelFor uses the LEVELS thresholds', async () => {
  const { get } = loadBackground();
  const levelFor = get('levelFor');
  const name = (min) => levelFor(min).name;
  assert.equal(name(0), 'Spark');
  assert.equal(name(59), 'Spark');
  assert.equal(name(60), 'Curious');
  assert.equal(name(5 * 60), 'Steady');
  assert.equal(name(20 * 60), 'Focused');
  assert.equal(name(50 * 60), 'Deep');
  assert.equal(name(100 * 60), 'Mastery');
  assert.equal(levelFor(30).next.name, 'Curious');
  assert.equal(levelFor(100 * 60).next, null);
});

test('startOfWeek is local Monday midnight; formatMinutes', async () => {
  const { get } = loadBackground();
  const startOfWeek = get('startOfWeek');
  const sunday = new Date(2026, 10, 8, 15, 30).getTime(); // Sun 8 Nov 2026
  assert.equal(startOfWeek(sunday), new Date(2026, 10, 2).getTime());
  const monday = new Date(2026, 10, 9).getTime();
  assert.equal(startOfWeek(monday), monday);

  const formatMinutes = get('formatMinutes');
  assert.equal(formatMinutes(0), '0 m');
  assert.equal(formatMinutes(45.4), '45 m');
  assert.equal(formatMinutes(80), '1 h 20 m');
  assert.equal(formatMinutes(120), '2 h');
});
