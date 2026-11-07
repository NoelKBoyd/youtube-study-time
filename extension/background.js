// YouTube Study Time - background service worker
//
// This file does three jobs:
//   1. Runs the study session timer (start, stop, and end when time is up).
//   2. Records every finished session in the session log (the only writer of it).
//   3. Makes all calls to the YouTube Data API, and caches the results.
//
// Everything is kept in chrome.storage.local:
//   session    -> the running session (see startSession), missing otherwise
//   sessionLog -> [{ id, topic, topicKey, startedAt, endedAt, plannedMin, actualMin, outcome }]
//   goals      -> { dailyMin, weeklyMin, perTopic: { [topicKey]: targetMin } }
//   apiKey     -> the user's YouTube Data API key
//   cache:*    -> saved search results (one entry per topic + page)

importScripts('shared/shared.js'); // topicKey(), DEFAULT_GOALS, ...

const ALARM_NAME = 'study-end';
const NOTIFICATION_ID = 'study-finished';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const API_URL = 'https://www.googleapis.com/youtube/v3/search';

// ---------- Messages from the popup, options page, stats page and content script ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start') {
    startSession(msg.topic, msg.minutes).then(sendResponse);
    return true; // tells Chrome we will reply asynchronously
  }
  if (msg.type === 'stop') {
    endSession().then(sendResponse);
    return true;
  }
  if (msg.type === 'search') {
    searchVideos(msg.topic, msg.pageToken).then(sendResponse);
    return true;
  }
  if (msg.type === 'testKey') {
    callSearchApi(msg.apiKey, 'study', '').then(sendResponse);
    return true;
  }
  if (msg.type === 'deleteLog') {
    deleteLogEntry(msg.id).then(sendResponse);
    return true;
  }
  if (msg.type === 'clearLog') {
    clearLog().then(sendResponse);
    return true;
  }
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
  if (msg.type === 'openStats') {
    openStats(msg.section === 'goals' ? 'goals-heading' : '');
  }
});

// Session and log changes run one at a time, so a Stop and the alarm arriving
// together can't both read the same session and log it twice.
let queue = Promise.resolve();
function serial(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

// ---------- Session timer ----------

// The running session:
//   { id, topic, startedAt, endTime, plannedMin, accumulatedMs, segmentStart }
// The panel's Edit sends 'start' again with the minutes left. With the same topic
// that is the same session: the time studied so far moves into accumulatedMs and a
// new segment starts now. A different topic logs the old session and starts a new
// one, so each topic gets its own time.
function startSession(topic, minutes) {
  return serial(async () => {
    const now = Date.now();
    const endTime = now + minutes * 60 * 1000;
    const { session: old } = await chrome.storage.local.get('session');

    let session;
    if (old && old.id && old.endTime > now && topicKey(old.topic) === topicKey(topic)) {
      const accumulatedMs = studiedMs(old, now);
      session = {
        ...old,
        topic,
        endTime,
        accumulatedMs,
        segmentStart: now,
        plannedMin: roundMin(accumulatedMs + minutes * 60 * 1000)
      };
    } else {
      if (old) await logSession(old, now);
      session = {
        id: now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        topic,
        startedAt: now,
        endTime,
        plannedMin: minutes,
        accumulatedMs: 0,
        segmentStart: now
      };
    }

    await chrome.storage.local.set({ session });
    await chrome.alarms.create(ALARM_NAME, { when: endTime });
    await showBadge(true);
    await removeOldCache();
    return { ok: true };
  });
}

// Ends the running session: log it, then clear it.
// `completed` forces the outcome (used by the alarm). Otherwise it is 'completed'
// only if the time had already run out, e.g. Stop pressed just after the end.
function endSession({ notify = false, completed = false } = {}) {
  return serial(async () => {
    const now = Date.now();
    const { session } = await chrome.storage.local.get('session');
    if (session) await logSession(session, now, completed);

    await chrome.storage.local.remove('session');
    await chrome.alarms.clear(ALARM_NAME);
    await showBadge(false);

    if (notify && session) {
      chrome.notifications.create(NOTIFICATION_ID, {
        type: 'basic',
        iconUrl: 'assets/icons/icon128.png',
        title: 'Study session finished',
        message: 'Time is up. YouTube is back to normal. Click to see your stats.'
      });
    }
    return { ok: true };
  });
}

// Session time so far, in ms. Never counts time past the planned end, so a session
// cleaned up long after it ran out (browser closed) still logs the right amount.
function studiedMs(session, now) {
  const segmentEnd = Math.min(now, session.endTime);
  return (session.accumulatedMs || 0) + Math.max(0, segmentEnd - session.segmentStart);
}

const roundMin = (ms) => Math.round(ms / 600) / 100; // ms -> minutes, 2 decimals

// Appends the session to sessionLog, at most once per session id.
// Sessions started before v1.1 have no id or start time, so they are not logged.
async function logSession(session, now, completed = false) {
  if (!session.id || !session.startedAt) return;
  const { sessionLog = [] } = await chrome.storage.local.get('sessionLog');
  if (sessionLog.some((record) => record.id === session.id)) return;

  const record = {
    id: session.id,
    topic: session.topic,
    topicKey: topicKey(session.topic),
    startedAt: session.startedAt,
    endedAt: Math.min(now, session.endTime),
    plannedMin: session.plannedMin,
    actualMin: roundMin(studiedMs(session, now)),
    outcome: completed || session.endTime <= now ? 'completed' : 'stopped'
  };
  await chrome.storage.local.set({ sessionLog: [...sessionLog, record] });
}

function deleteLogEntry(id) {
  return serial(async () => {
    const { sessionLog = [] } = await chrome.storage.local.get('sessionLog');
    await chrome.storage.local.set({ sessionLog: sessionLog.filter((record) => record.id !== id) });
    return { ok: true };
  });
}

function clearLog() {
  return serial(async () => {
    await chrome.storage.local.set({ sessionLog: [] });
    return { ok: true };
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) endSession({ notify: true, completed: true });
});

// Alarms and the badge can be lost when Chrome restarts, so check again on startup.
// A session that ran out while Chrome was closed is logged as completed, quietly.
chrome.runtime.onStartup.addListener(async () => {
  const { session } = await chrome.storage.local.get('session');
  if (!session) return;

  if (session.endTime <= Date.now()) {
    endSession();
  } else {
    chrome.alarms.create(ALARM_NAME, { when: session.endTime });
    showBadge(true);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const { goals } = await chrome.storage.local.get('goals');
  if (!goals) await chrome.storage.local.set({ goals: DEFAULT_GOALS });
});

chrome.notifications.onClicked.addListener((id) => {
  if (id !== NOTIFICATION_ID) return;
  openStats();
  chrome.notifications.clear(id);
});

// `anchor` is an element id on the stats page to scroll to (e.g. the goals form).
function openStats(anchor = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL('stats/stats.html') + (anchor ? '#' + anchor : '') });
}

async function showBadge(on) {
  await chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
}

// ---------- YouTube Data API ----------

// Returns { items, nextPageToken } or { error }.
// Uses the cache first, so repeating a topic does not use any quota.
async function searchVideos(topic, pageToken = '') {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) return { error: 'nokey' };

  const cacheKey = 'cache:' + topicKey(topic) + '|' + pageToken;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached && Date.now() - cached.savedAt < CACHE_MAX_AGE_MS) {
    return cached.data;
  }

  const result = await callSearchApi(apiKey, topic, pageToken);
  if (!result.error) {
    await chrome.storage.local.set({ [cacheKey]: { savedAt: Date.now(), data: result } });
  }
  return result;
}

async function callSearchApi(apiKey, topic, pageToken) {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '50',
    q: topic,
    key: apiKey
  });
  if (pageToken) params.set('pageToken', pageToken);

  let response;
  try {
    response = await fetch(API_URL + '?' + params);
  } catch {
    return { error: 'network' };
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { error: getErrorType(data) };

  // Keep only the fields the panel needs, so the cache stays small.
  const items = (data.items || [])
    .filter((item) => item.id && item.id.videoId)
    .map((item) => ({
      videoId: item.id.videoId,
      title: decodeHtml(item.snippet.title),
      channel: decodeHtml(item.snippet.channelTitle),
      thumbnail: `https://i.ytimg.com/vi/${item.id.videoId}/mqdefault.jpg`,
      published: item.snippet.publishedAt
    }));

  return { items, nextPageToken: data.nextPageToken || '' };
}

// Turns a Google API error response into one of a few simple error names.
function getErrorType(data) {
  const text = JSON.stringify(data.error || {});
  if (/quota/i.test(text)) return 'quota';
  if (/accessNotConfigured|SERVICE_DISABLED/.test(text)) return 'disabled';
  if (/API key not valid|API_KEY_INVALID|keyInvalid/.test(text)) return 'badkey';
  return 'api';
}

// The API returns titles with HTML escapes like &#39; - turn them back into plain text.
function decodeHtml(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(code))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function removeOldCache() {
  const everything = await chrome.storage.local.get(null);
  const oldKeys = Object.keys(everything).filter(
    (key) => key.startsWith('cache:') && Date.now() - everything[key].savedAt > CACHE_MAX_AGE_MS
  );
  if (oldKeys.length) await chrome.storage.local.remove(oldKeys);
}
