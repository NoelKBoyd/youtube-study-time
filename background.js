// YouTube Study Time - background service worker
//
// This file does two jobs:
//   1. Runs the study session timer (start, stop, and end when time is up).
//   2. Makes all calls to the YouTube Data API, and caches the results.
//
// Everything is kept in chrome.storage.local:
//   session  -> { topic, endTime } while a session is running
//   apiKey   -> the user's YouTube Data API key
//   cache:*  -> saved search results (one entry per topic + page)

const ALARM_NAME = 'study-end';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const API_URL = 'https://www.googleapis.com/youtube/v3/search';

// ---------- Messages from the popup, options page and content script ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start') {
    startSession(msg.topic, msg.minutes).then(sendResponse);
    return true; // tells Chrome we will reply asynchronously
  }
  if (msg.type === 'stop') {
    endSession(false).then(sendResponse);
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
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
});

// ---------- Session timer ----------

async function startSession(topic, minutes) {
  const endTime = Date.now() + minutes * 60 * 1000;
  await chrome.storage.local.set({ session: { topic, endTime } });
  await chrome.alarms.create(ALARM_NAME, { when: endTime });
  await showBadge(true);
  await removeOldCache();
  return { ok: true };
}

async function endSession(timeIsUp) {
  await chrome.storage.local.remove('session');
  await chrome.alarms.clear(ALARM_NAME);
  await showBadge(false);

  if (timeIsUp) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Study session finished',
      message: 'Time is up. YouTube is back to normal.'
    });
  }
  return { ok: true };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) endSession(true);
});

// Alarms and the badge can be lost when Chrome restarts, so check again on startup.
chrome.runtime.onStartup.addListener(async () => {
  const { session } = await chrome.storage.local.get('session');
  if (!session) return;

  if (session.endTime <= Date.now()) {
    endSession(false);
  } else {
    chrome.alarms.create(ALARM_NAME, { when: session.endTime });
    showBadge(true);
  }
});

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

  const cacheKey = 'cache:' + topic.toLowerCase() + '|' + pageToken;
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
