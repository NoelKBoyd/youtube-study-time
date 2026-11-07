import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadContent, flush, closeAllPages } from './load.js';

afterEach(closeAllPages);

const session = (minutes = 10, topic = 'linear algebra') => ({ topic, endTime: Date.now() + minutes * 60000 });

// Minimal copies of the YouTube elements content.js looks for.
const WATCH_PAGE = `
  <ytd-page-manager>
    <ytd-watch-flexy>
      <div id="secondary"><div id="related"></div></div>
    </ytd-watch-flexy>
  </ytd-page-manager>`;

const HOME_PAGE = `
  <ytd-page-manager>
    <ytd-browse page-subtype="home">
      <ytd-rich-grid-renderer><div id="header"></div><div id="contents"></div></ytd-rich-grid-renderer>
    </ytd-browse>
  </ytd-page-manager>`;

function videos(prefix, count) {
  return Array.from({ length: count }, (_, i) => ({
    videoId: `${prefix}${i}`,
    title: `Video ${prefix}${i}`,
    channel: 'Channel',
    thumbnail: 'https://i.ytimg.com/vi/x/mqdefault.jpg',
    published: new Date().toISOString()
  }));
}

test('no session: no panel and no yst-active class', async () => {
  const page = loadContent({ url: 'https://www.youtube.com/watch?v=v1', html: WATCH_PAGE });
  await flush();
  assert.equal(page.document.getElementById('yst-panel'), null);
  assert.equal(page.document.documentElement.classList.contains('yst-active'), false);
  page.close();
});

test('watch page: the panel goes right before #related and lists search results', async () => {
  const page = loadContent({
    url: 'https://www.youtube.com/watch?v=current',
    html: WATCH_PAGE,
    storage: { session: session() },
    search: async () => ({ items: [...videos('a', 3), { ...videos('current', 1)[0], videoId: 'current' }], nextPageToken: '' })
  });
  await flush();

  const panel = page.document.getElementById('yst-panel');
  assert.ok(panel);
  assert.equal(panel.className, 'yst-sidebar');
  assert.equal(panel.nextElementSibling.id, 'related');
  assert.ok(page.document.documentElement.classList.contains('yst-active'));
  assert.equal(panel.querySelector('.yst-topic').textContent, 'linear algebra');
  assert.match(panel.querySelector('.yst-countdown').textContent, /^(9:59|10:00) left$/);

  // The video being watched is not suggested again.
  const ids = [...panel.querySelectorAll('.yst-card')].map((c) => c.dataset.videoId);
  assert.deepEqual(ids, ['a0', 'a1', 'a2']);
  assert.equal(panel.querySelector('.yst-status').textContent, 'End of results.');
  page.close();
});

test('home page: the panel is a grid inside ytd-page-manager', async () => {
  const page = loadContent({
    url: 'https://www.youtube.com/',
    html: '<ytd-page-manager></ytd-page-manager>',
    storage: { session: session() }
  });
  await flush();
  const panel = page.document.querySelector('ytd-page-manager > #yst-panel');
  assert.ok(panel);
  assert.equal(panel.className, 'yst-home');
  assert.equal(panel.querySelector('.yst-status').textContent, 'No videos found for this topic.');
  page.close();
});

test('infinite scroll follows nextPageToken and skips duplicates', async () => {
  const tokens = [];
  const page = loadContent({
    url: 'https://www.youtube.com/',
    html: '<ytd-page-manager></ytd-page-manager>',
    storage: { session: session() },
    search: async ({ pageToken }) => {
      tokens.push(pageToken);
      if (!pageToken) return { items: videos('p', 2), nextPageToken: 'T2' };
      return { items: [...videos('p', 1), ...videos('q', 2)], nextPageToken: '' };
    }
  });
  await flush(20);
  assert.deepEqual(tokens, ['', 'T2']);
  assert.equal(page.document.querySelectorAll('.yst-card').length, 4);
  page.close();
});

test('infinite scroll stops after MAX_PAGES API calls', async () => {
  let calls = 0;
  const page = loadContent({
    url: 'https://www.youtube.com/',
    html: '<ytd-page-manager></ytd-page-manager>',
    storage: { session: session() },
    search: async () => ({ items: videos(`page${calls++}-`, 1), nextPageToken: 'more' })
  });
  await flush(60);
  assert.equal(calls, page.get('MAX_PAGES'));
  page.close();
});

test('an API error shows the message, a settings button and a search link', async () => {
  const page = loadContent({
    url: 'https://www.youtube.com/',
    html: '<ytd-page-manager></ytd-page-manager>',
    storage: { session: session(10, 'C++ & you') },
    search: async () => ({ error: 'nokey' })
  });
  await flush();
  const status = page.document.querySelector('.yst-status');
  assert.equal(status.querySelector('.yst-error').textContent, page.get('ERROR_MESSAGES').nokey);
  status.querySelector('.yst-button').click();
  assert.deepEqual(page.chrome.runtime.sentMessages.at(-1), { type: 'openOptions' });
  assert.equal(
    status.querySelector('.yst-link').getAttribute('href'),
    '/results?search_query=' + encodeURIComponent('C++ & you')
  );
  page.close();
});

test('titles are inserted as text, never as HTML', async () => {
  const page = loadContent({
    url: 'https://www.youtube.com/',
    html: '<ytd-page-manager></ytd-page-manager>',
    storage: { session: session() },
    search: async () => ({ items: [{ ...videos('x', 1)[0], title: '<img src=x onerror=alert(1)>' }], nextPageToken: '' })
  });
  await flush();
  const title = page.document.querySelector('.yst-video-title');
  assert.equal(title.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(title.children.length, 0);
  page.close();
});

test('stopping the session removes the panel', async () => {
  const page = loadContent({
    url: 'https://www.youtube.com/watch?v=v1',
    html: WATCH_PAGE,
    storage: { session: session() }
  });
  await flush();
  assert.ok(page.document.getElementById('yst-panel'));
  await page.chrome.storage.local.remove('session');
  await flush();
  assert.equal(page.document.getElementById('yst-panel'), null);
  assert.equal(page.document.documentElement.classList.contains('yst-active'), false);
  page.close();
});

test('the panel editor changes topic and time, and can stop the session', async () => {
  const page = loadContent({
    url: 'https://www.youtube.com/',
    html: '<ytd-page-manager></ytd-page-manager>',
    storage: { session: session(10) }
  });
  await flush();
  const panel = page.document.getElementById('yst-panel');
  const editor = panel.querySelector('.yst-editor');
  assert.equal(editor.hidden, true);

  panel.querySelector('.yst-edit-button').click();
  assert.equal(editor.hidden, false);
  const [topicInput, minutesInput] = editor.querySelectorAll('input');
  assert.equal(topicInput.value, 'linear algebra');
  assert.equal(minutesInput.value, '10');

  topicInput.value = '  calculus ';
  minutesInput.value = '25';
  editor.requestSubmit();
  await flush();
  assert.deepEqual(page.chrome.runtime.sentMessages.at(-1), { type: 'start', topic: 'calculus', minutes: 25 });
  const { lastTopic, lastMinutes } = await page.chrome.storage.local.get(['lastTopic', 'lastMinutes']);
  assert.deepEqual([lastTopic, lastMinutes], ['calculus', 25]);

  editor.querySelector('.yst-danger').click();
  await flush();
  assert.deepEqual(page.chrome.runtime.sentMessages.at(-1), { type: 'stop' });
  page.close();
});

test('home page with no session: a start bar starts one with the last values', async () => {
  const page = loadContent({
    url: 'https://www.youtube.com/',
    html: HOME_PAGE,
    storage: { lastTopic: 'physics', lastMinutes: 30 }
  });
  await flush();
  // Between the filter chips and the videos, not a sibling of the feed in ytd-page-manager.
  const bar = page.document.querySelector('ytd-rich-grid-renderer > form.yst-start');
  assert.ok(bar);
  assert.equal(bar.previousElementSibling.id, 'header');
  assert.equal(bar.nextElementSibling.id, 'contents');
  assert.equal(page.document.documentElement.classList.contains('yst-active'), false);
  const [topicInput, minutesInput] = bar.querySelectorAll('input');
  assert.deepEqual([topicInput.value, minutesInput.value], ['physics', '30']);

  topicInput.value = 'chemistry';
  bar.requestSubmit();
  await flush();
  assert.deepEqual(page.chrome.runtime.sentMessages.at(-1), { type: 'start', topic: 'chemistry', minutes: 30 });
  page.close();
});

test('start bar quick-pick chips fill the Minutes field and show which one matches', async () => {
  const page = loadContent({ url: 'https://www.youtube.com/', html: HOME_PAGE, storage: { lastTopic: 'physics', lastMinutes: 25 } });
  await flush();
  const bar = page.document.querySelector('.yst-start');
  const minutesInput = bar.querySelectorAll('input')[1];
  const chips = [...bar.querySelectorAll('.yst-picks .yst-chip')];
  const pressed = () => chips.filter((chip) => chip.getAttribute('aria-pressed') === 'true').map((chip) => chip.textContent);
  assert.deepEqual(chips.map((chip) => chip.textContent), ['15 min', '25 min', '45 min', '60 min']);
  assert.deepEqual(pressed(), ['25 min']);

  chips[3].click();
  assert.equal(minutesInput.value, '60');
  assert.deepEqual(pressed(), ['60 min']);

  minutesInput.value = '50';
  minutesInput.dispatchEvent(new page.window.Event('input'));
  assert.deepEqual(pressed(), []);

  chips[0].click();
  bar.requestSubmit();
  await flush();
  assert.equal(page.chrome.runtime.sentMessages.at(-1).minutes, 15);
  page.close();
});

test('start bar offers up to 3 recent topics that fill the Topic field', async () => {
  const now = Date.now();
  const entry = (id, topic, ago) => ({ id, topic, topicKey: topic.toLowerCase(), endedAt: now - ago, actualMin: 5 });
  const page = loadContent({
    url: 'https://www.youtube.com/',
    html: HOME_PAGE,
    storage: {
      sessionLog: [
        entry('a', 'Rust', 5000),
        entry('b', 'Physics', 1000),
        entry('c', 'physics', 4000), // same topic as b, listed once
        entry('d', 'Chemistry', 2000),
        entry('e', 'Biology', 3000)
      ]
    }
  });
  await flush();
  const bar = page.document.querySelector('.yst-start');
  const chips = [...bar.querySelectorAll('.yst-recent .yst-chip')];
  assert.deepEqual(chips.map((chip) => chip.textContent), ['Physics', 'Chemistry', 'Biology']);
  assert.ok(bar.querySelector('.yst-start-grid').classList.contains('yst-has-recent'));
  chips[1].click();
  assert.equal(bar.querySelector('input').value, 'Chemistry');
  page.close();

  const empty = loadContent({ url: 'https://www.youtube.com/', html: HOME_PAGE });
  await flush();
  assert.equal(empty.document.querySelector('.yst-recent').hidden, true);
  empty.close();
});

test('start bar with no goals: a "set your goals" button, and a Stats button', async () => {
  const page = loadContent({ url: 'https://www.youtube.com/', html: HOME_PAGE });
  await flush();
  const bar = page.document.querySelector('.yst-start');
  assert.equal(bar.querySelectorAll('.yst-goal').length, 0);
  bar.querySelector('.yst-goal-placeholder').click();
  await flush();
  assert.deepEqual(page.chrome.runtime.sentMessages.at(-1), { type: 'openStats', section: 'goals' });
  bar.querySelector('.yst-stats-button').click();
  await flush();
  assert.deepEqual(page.chrome.runtime.sentMessages.at(-1), { type: 'openStats' });
  page.close();
});

test('start bar shows today and this week against the goals, and follows changes', async () => {
  const now = Date.now();
  const page = loadContent({
    url: 'https://www.youtube.com/',
    html: HOME_PAGE,
    storage: {
      goals: { dailyMin: 60, weeklyMin: 0, perTopic: {} },
      sessionLog: [{ id: 'a', topic: 'x', topicKey: 'x', endedAt: now - 1000, actualMin: 30 }]
    }
  });
  await flush();
  const goalTexts = () => [...page.document.querySelectorAll('.yst-goal')].map((g) => g.textContent);
  assert.deepEqual(goalTexts(), ['Today30 m / 1 h', 'This weekSet a goal']);
  assert.equal(page.document.querySelector('.yst-goal .yst-progress-fill').style.width, '50%');

  await page.chrome.storage.local.set({ goals: { dailyMin: 30, weeklyMin: 120, perTopic: {} } });
  await flush();
  assert.deepEqual(goalTexts(), ['Today✓ 30 m / 30 m', 'This week30 m / 2 h']);
  assert.ok(page.document.querySelector('.yst-goal').classList.contains('yst-goal-done'));
  page.close();
});

test('the start bar can be hidden for the tab, and is not shown on watch pages', async () => {
  const home = loadContent({ url: 'https://www.youtube.com/', html: HOME_PAGE });
  await flush();
  assert.ok(home.document.querySelector('.yst-start'));
  home.document.querySelector('.yst-dismiss').click();
  assert.equal(home.document.querySelector('.yst-start'), null);
  home.document.dispatchEvent(new home.window.Event('yt-navigate-finish'));
  await flush();
  assert.equal(home.document.querySelector('.yst-start'), null);
  home.close();

  const watch = loadContent({ url: 'https://www.youtube.com/watch?v=v1', html: WATCH_PAGE });
  await flush();
  assert.equal(watch.document.querySelector('.yst-start'), null);
  watch.close();
});

test('watched videos are remembered per tab, without duplicates', async () => {
  const page = loadContent({ url: 'https://www.youtube.com/watch?v=v1', html: WATCH_PAGE, storage: { session: session() } });
  await flush();
  page.get('rememberWatched')('v2');
  page.get('rememberWatched')('v1');
  assert.deepEqual([...page.get('getWatched')()], ['v1', 'v2']);
  page.close();
});

test('formatTime', async () => {
  const page = loadContent();
  await flush(); // let the script's startup storage read finish
  const formatTime = page.get('formatTime');
  assert.equal(formatTime(59_001), '1:00');
  assert.equal(formatTime(5_000), '0:05');
  assert.equal(formatTime(25 * 60000), '25:00');
  assert.equal(formatTime(3600_000 + 61_000), '1:01:01');
  page.close();
});

test('timeAgo', async () => {
  const page = loadContent();
  await flush(); // let the script's startup storage read finish
  const timeAgo = page.get('timeAgo');
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  assert.equal(timeAgo(ago(0)), 'today');
  assert.equal(timeAgo(ago(1)), '1 day ago');
  assert.equal(timeAgo(ago(45)), '1 month ago');
  assert.equal(timeAgo(ago(800)), '2 years ago');
  assert.equal(timeAgo('not a date'), 'today');
  page.close();
});

// CLAUDE.md: background.js error codes and content.js ERROR_MESSAGES must stay in step.
test('every error code from background.js has a message in content.js', async () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const codes = new Set([...background.matchAll(/(?:error:\s*|return\s+)'([a-z]+)'/g)].map((m) => m[1]));
  const page = loadContent();
  await flush(); // let the script's startup storage read finish
  const messages = page.get('ERROR_MESSAGES');
  assert.ok(codes.size >= 5, 'found codes: ' + [...codes]);
  for (const code of codes) assert.ok(code in messages, `no ERROR_MESSAGES entry for "${code}"`);
  page.close();
});
