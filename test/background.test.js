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
