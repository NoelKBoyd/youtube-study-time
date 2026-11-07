// YouTube Study Time - content script
//
// Runs on every youtube.com page. While a study session is active it:
//   - adds the "yst-active" class to <html>, which content.css uses to hide
//     YouTube's own recommendations
//   - shows a "study feed" of videos about the chosen topic instead:
//       watch page -> in place of the sidebar
//       home page  -> as a full-page grid over the normal feed
//   - sends Shorts pages to the normal watch page (no endless Shorts feed)
//   - makes autoplay play the next study video instead of YouTube's pick
//   - lets the user edit or stop the session from the panel itself
// With no session, the home page gets a slim "start studying" bar instead.

const MAX_PAGES = 10; // safety limit: at most 10 API calls per page view

// YouTube's page structure is not a public API and changes now and then.
// Every element name this script depends on is listed here (plus the top of content.css).
const YT = {
  related: 'ytd-watch-flexy #related', // recommendations column on the watch page
  secondary: 'ytd-watch-flexy #secondary', // the whole right-hand column (fallback)
  pageContent: 'ytd-page-manager', // main content area, right of the left menu
  player: '#movie_player',
  autoplayToggle: '.ytp-autonav-toggle-button', // aria-checked="true" when autoplay is on
  autoplayCancel: '.ytp-autonav-endscreen-upnext-cancel-button'
};

let session = null; // { topic, endTime } or null
let panel = null; // the study panel currently on the page
let updateCount = 0; // goes up on every update(), so older runs can tell they are out of date

function isActive() {
  return session !== null && session.endTime > Date.now();
}

// ---------- Main update: called on load, on navigation and when the session changes ----------

async function update() {
  const thisUpdate = ++updateCount;
  removePanel();
  document.documentElement.classList.toggle('yst-active', isActive());
  if (!isActive()) {
    try {
      sessionStorage.removeItem('yst-watched'); // next session starts fresh
    } catch {}
    if (location.pathname === '/' && !startBarDismissed()) {
      const defaults = await chrome.storage.local.get(['lastTopic', 'lastMinutes']);
      if (thisUpdate !== updateCount) return; // user moved on while we waited
      const content = document.querySelector(YT.pageContent);
      if (content) {
        panel = createStartBar(defaults);
        content.prepend(panel);
      }
    }
    return;
  }

  // Shorts: open the same video on the normal watch page, where the study feed is shown.
  if (location.pathname.startsWith('/shorts/')) {
    const videoId = location.pathname.split('/')[2];
    location.replace(videoId ? '/watch?v=' + encodeURIComponent(videoId) : '/');
    return;
  }

  if (location.pathname === '/watch') {
    rememberWatched(new URLSearchParams(location.search).get('v'));
    const related = await waitFor(YT.related, 5000);
    if (thisUpdate !== updateCount) return; // user moved on while we waited
    if (related) {
      panel = createPanel('yst-sidebar');
      related.before(panel);
    } else {
      // YouTube probably changed its layout. Still show the feed, and say what broke.
      const secondary = document.querySelector(YT.secondary);
      console.warn(
        `[YouTube Study Time] "${YT.related}" not found` +
          (secondary ? `, using "${YT.secondary}" instead.` : ', showing a floating panel.')
      );
      panel = createPanel(secondary ? 'yst-sidebar' : 'yst-floating');
      if (secondary) secondary.prepend(panel);
      else document.body.append(panel);
    }
  } else if (location.pathname === '/') {
    // Put the grid in YouTube's main content area, which already sits to the right of
    // the left menu and below the top bar. Covering the whole window instead would put
    // the grid underneath the menu, whose background is transparent.
    const content = document.querySelector(YT.pageContent);
    if (content) {
      panel = createPanel('yst-home');
      content.prepend(panel);
    } else {
      console.warn(`[YouTube Study Time] "${YT.pageContent}" not found, covering the page instead.`);
      panel = createPanel('yst-overlay');
      document.body.append(panel);
    }
  }
}

function removePanel() {
  if (!panel) return;
  panel.cleanup();
  panel.remove();
  panel = null;
}

// YouTube is a single-page app: it does not reload the page when you click a video.
// It fires its own "yt-navigate-finish" event instead.
document.addEventListener('yt-navigate-finish', update);

// The popup (start/stop) and the background timer change the session in storage.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.session) {
    session = changes.session.newValue || null;
    update();
  }
});

chrome.storage.local.get('session').then((data) => {
  session = data.session || null;
  update();
});

// ---------- Building the panel ----------

function createPanel(layout) {
  const el = make('div', layout);
  el.id = 'yst-panel';

  const header = make('div', 'yst-header');
  const titleBox = make('div');
  titleBox.append(make('div', 'yst-label', 'Study time'), make('div', 'yst-topic', session.topic));
  const countdown = make('div', 'yst-countdown');
  const editButton = make('button', 'yst-edit-button', 'Edit');
  editButton.type = 'button';
  const headerRight = make('div', 'yst-header-right');
  headerRight.append(countdown, editButton);
  header.append(titleBox, headerRight);

  const editor = createEditor(() => {
    editor.hidden = true;
    editButton.hidden = false;
  });
  editor.hidden = true;
  editButton.addEventListener('click', () => {
    editor.open();
    editButton.hidden = true;
  });

  const list = make('div', 'yst-list');
  const status = make('div', 'yst-status');
  const sentinel = make('div', 'yst-sentinel'); // when this scrolls into view, load more

  el.append(header, editor, list, status, sentinel);

  const stopCountdown = startCountdown(countdown);
  const stopFeed = startFeed(list, status, sentinel);
  el.cleanup = () => {
    stopCountdown();
    stopFeed();
  };
  return el;
}

// Inline form to change the topic and time left, or stop, without opening the popup.
// Saving restarts the session through the background worker ('start' overwrites the
// session and its alarm); the storage change then rebuilds the panel with the new values.
function createEditor(close) {
  const form = make('form', 'yst-editor');
  const { topicInput, minutesInput, topicLabel, minutesLabel } = sessionFields('Topic', 'Minutes left');

  const save = make('button', 'yst-button', 'Save');
  save.type = 'submit';
  const cancel = make('button', 'yst-button yst-secondary', 'Cancel');
  cancel.type = 'button';
  const stop = make('button', 'yst-button yst-danger', 'Stop session');
  stop.type = 'button';
  const actions = make('div', 'yst-actions');
  actions.append(save, cancel, stop);

  const error = make('p', 'yst-error');
  error.hidden = true;

  form.append(topicLabel, minutesLabel, actions, error);

  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  keepKeysFromYouTube(form);
  const send = sender(error);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitSession(topicInput, minutesInput, send);
  });
  cancel.addEventListener('click', close);
  stop.addEventListener('click', () => send({ type: 'stop' }));

  form.open = () => {
    topicInput.value = session.topic;
    minutesInput.value = Math.max(1, Math.ceil((session.endTime - Date.now()) / 60000));
    error.hidden = true;
    form.hidden = false;
    topicInput.focus();
  };
  return form;
}

// Home page, no session running: a slim bar to start one without opening the popup.
// The × hides it for the rest of this tab's life (sessionStorage is per tab).
function createStartBar({ lastTopic, lastMinutes }) {
  const form = make('form', 'yst-start');
  form.id = 'yst-panel';
  const { topicInput, minutesInput, topicLabel, minutesLabel } = sessionFields(
    'What are you studying?',
    'Minutes'
  );
  topicInput.placeholder = 'e.g. Embedded C STM32';
  topicInput.value = lastTopic || '';
  minutesInput.value = lastMinutes || 45;

  const start = make('button', 'yst-button', 'Start studying');
  start.type = 'submit';
  const dismiss = make('button', 'yst-dismiss', '×');
  dismiss.type = 'button';
  dismiss.title = 'Hide for this tab';
  dismiss.setAttribute('aria-label', 'Hide for this tab');

  const error = make('p', 'yst-error');
  error.hidden = true;

  form.append(make('div', 'yst-label', 'Study time'), topicLabel, minutesLabel, start, dismiss, error);
  keepKeysFromYouTube(form);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitSession(topicInput, minutesInput, sender(error));
  });
  dismiss.addEventListener('click', () => {
    try {
      sessionStorage.setItem('yst-start-hidden', '1');
    } catch {}
    removePanel();
  });

  form.cleanup = () => {};
  return form;
}

function startBarDismissed() {
  try {
    return sessionStorage.getItem('yst-start-hidden') === '1';
  } catch {
    return false;
  }
}

// Topic + minutes inputs, shared by the start bar and the session editor.
function sessionFields(topicText, minutesText) {
  const topicInput = make('input', 'yst-input');
  topicInput.type = 'text';
  topicInput.required = true;
  topicInput.maxLength = 100;
  const topicLabel = make('label', 'yst-field', topicText);
  topicLabel.append(topicInput);

  const minutesInput = make('input', 'yst-input');
  minutesInput.type = 'number';
  minutesInput.required = true;
  minutesInput.min = '1';
  minutesInput.max = '600';
  const minutesLabel = make('label', 'yst-field yst-field-minutes', minutesText);
  minutesLabel.append(minutesInput);

  return { topicInput, minutesInput, topicLabel, minutesLabel };
}

// Starts (or restarts) the session. The background worker writes `session`,
// and the storage change rebuilds the panel.
async function submitSession(topicInput, minutesInput, send) {
  const topic = topicInput.value.trim();
  const minutes = Number(minutesInput.value);
  if (!topic || !(minutes > 0)) return;
  await chrome.storage.local.set({ lastTopic: topic, lastMinutes: minutes });
  await send({ type: 'start', topic, minutes });
}

// Returns a function that messages the background worker and shows a failure in `errorEl`.
function sender(errorEl) {
  return async (message) => {
    try {
      await chrome.runtime.sendMessage(message);
    } catch {
      // Happens if the extension was reloaded while this tab stayed open.
      errorEl.textContent = ERROR_MESSAGES.reloaded;
      errorEl.hidden = false;
    }
  };
}

// YouTube's keyboard shortcuts (k, j, f, /...) listen on document; keep typing in our forms.
function keepKeysFromYouTube(el) {
  el.addEventListener('keydown', (event) => event.stopPropagation());
}

function startCountdown(element) {
  const tick = () => {
    const msLeft = session ? session.endTime - Date.now() : 0;
    if (msLeft <= 0) {
      update(); // time is up: removes the panel and shows YouTube normally again
      return;
    }
    element.textContent = formatTime(msLeft) + ' left';
  };
  tick();
  const interval = setInterval(tick, 1000);
  return () => clearInterval(interval);
}

// Loads videos page by page as the user scrolls (infinite scroll).
function startFeed(list, status, sentinel) {
  const currentVideo = new URLSearchParams(location.search).get('v');
  const shown = new Set([currentVideo]); // don't show the same video twice
  const topic = session.topic;
  let pageToken = '';
  let pagesLoaded = 0;
  let loading = false;
  let stopped = false;

  const observer = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting || loading || stopped) return;

    loading = true;
    status.textContent = 'Loading…';
    const result = await search(topic, pageToken);
    loading = false;
    if (stopped) return; // panel was removed while we were waiting

    if (result.error) {
      observer.disconnect();
      showError(status, result.error, topic);
      return;
    }

    for (const video of result.items) {
      if (shown.has(video.videoId)) continue;
      shown.add(video.videoId);
      list.append(createCard(video));
    }

    pagesLoaded++;
    pageToken = result.nextPageToken;
    if (!pageToken || pagesLoaded >= MAX_PAGES) {
      observer.disconnect();
      status.textContent = list.children.length ? 'End of results.' : 'No videos found for this topic.';
      return;
    }

    status.textContent = '';
    // Observe again so this callback runs once more if the sentinel is still on screen.
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  });

  observer.observe(sentinel);
  return () => {
    stopped = true;
    observer.disconnect();
  };
}

async function search(topic, pageToken) {
  try {
    return await chrome.runtime.sendMessage({ type: 'search', topic, pageToken });
  } catch {
    // Happens if the extension was reloaded while this tab stayed open.
    return { error: 'reloaded' };
  }
}

function createCard(video) {
  const card = make('a', 'yst-card');
  card.href = '/watch?v=' + encodeURIComponent(video.videoId);
  card.dataset.videoId = video.videoId;

  // The wrapper keeps the 16:9 shape even before the image has loaded
  const thumb = make('div', 'yst-thumb');
  const image = make('img');
  image.src = video.thumbnail;
  image.alt = '';
  image.loading = 'lazy';
  thumb.append(image);

  const info = make('div', 'yst-info');
  info.append(
    make('div', 'yst-video-title', video.title),
    make('div', 'yst-channel', video.channel),
    make('div', 'yst-channel', timeAgo(video.published))
  );

  card.append(thumb, info);
  return card;
}

const ERROR_MESSAGES = {
  nokey: 'No YouTube API key set yet.',
  badkey: 'Your YouTube API key was rejected.',
  disabled: 'YouTube Data API v3 is not enabled in the Google Cloud project for your key.',
  quota: 'Daily search limit reached. It resets at midnight Pacific time.',
  network: 'Could not reach the YouTube API. Check your connection.',
  reloaded: 'The extension was updated. Refresh this page.',
  api: 'The YouTube API returned an error.'
};

function showError(status, error, topic) {
  status.textContent = '';
  status.append(make('p', 'yst-error', ERROR_MESSAGES[error] || ERROR_MESSAGES.api));

  if (error === 'nokey' || error === 'badkey' || error === 'disabled') {
    const button = make('button', 'yst-button', 'Open settings');
    button.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openOptions' }));
    status.append(button);
  }

  // Fallback that needs no API: a normal YouTube search for the topic.
  const link = make('a', 'yst-link', `Search YouTube for "${topic}" instead`);
  link.href = '/results?search_query=' + encodeURIComponent(topic);
  status.append(link);
}

// ---------- Autoplay ----------
//
// When a video ends with autoplay on, YouTube moves to its own recommended video.
// Instead, we play the next study video the user hasn't watched in this tab yet.
// As a safety net, if YouTube still navigates on its own right after a video ended
// (no click or key press from the user), we redirect that too.

const AUTOPLAY_WINDOW_MS = 15000;
let lastEndedAt = 0;
let lastInputAt = 0;

for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => (lastInputAt = Date.now()), true);
}

// Media events don't bubble, but a capturing listener on document still receives them.
document.addEventListener('ended', onVideoEnded, true);

function onVideoEnded(event) {
  if (!isActive() || location.pathname !== '/watch') return;
  const player = event.target.closest(YT.player);
  if (!player || player.classList.contains('ad-showing')) return; // only the main video, not ads

  // A playlist the user chose themselves keeps going. Mixes (list=RD...) are recommendations.
  const list = new URLSearchParams(location.search).get('list');
  if (list && !list.startsWith('RD')) return;

  // Respect the player's autoplay switch: if it is off, YouTube won't move on anyway.
  const toggle = document.querySelector(YT.autoplayToggle);
  if (toggle && toggle.getAttribute('aria-checked') === 'false') return;

  lastEndedAt = Date.now();
  cancelYouTubeAutoplay();
  playNextStudyVideo();
}

function cancelYouTubeAutoplay() {
  // The "Up next" countdown can appear a moment after the video ends, so try a few times.
  let tries = 0;
  const timer = setInterval(() => {
    const cancel = document.querySelector(YT.autoplayCancel);
    if (cancel) cancel.click();
    if (cancel || ++tries >= 20) clearInterval(timer);
  }, 100);
}

// Returns true if it found a study video to go to.
function playNextStudyVideo() {
  const watched = getWatched();
  const next = [...document.querySelectorAll('#yst-panel .yst-card')].find(
    (card) => !watched.includes(card.dataset.videoId)
  );
  if (!next) return false;
  location.assign(next.href);
  return true;
}

// Safety net: YouTube navigated by itself shortly after a video ended.
document.addEventListener('yt-navigate-finish', () => {
  if (!isActive() || location.pathname !== '/watch') return;
  const sinceEnd = Date.now() - lastEndedAt;
  if (sinceEnd > AUTOPLAY_WINDOW_MS || lastInputAt > lastEndedAt) return;
  lastEndedAt = 0;
  console.warn('[YouTube Study Time] Autoplay got through, redirecting.');
  if (!playNextStudyVideo()) history.back();
});

// Video IDs watched in this tab during the session, so autoplay doesn't bounce
// between the same two videos. sessionStorage is per tab and survives page loads.
function getWatched() {
  try {
    return JSON.parse(sessionStorage.getItem('yst-watched')) || [];
  } catch {
    return [];
  }
}

function rememberWatched(videoId) {
  if (!videoId) return;
  const watched = getWatched();
  if (watched.includes(videoId)) return;
  watched.push(videoId);
  try {
    sessionStorage.setItem('yst-watched', JSON.stringify(watched.slice(-200)));
  } catch {
    // storage unavailable: autoplay may repeat a video, nothing worse
  }
}

// ---------- Small helpers ----------

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text; // textContent, never innerHTML, so titles can't inject HTML
  return el;
}

// Resolves with the element once it exists, or null after the timeout.
function waitFor(selector, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const found = document.querySelector(selector);
    if (found) return resolve(found);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

function formatTime(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

function timeAgo(isoDate) {
  const days = Math.floor((Date.now() - new Date(isoDate)) / 86400000);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (!(days >= 1)) return 'today';
  if (days < 30) return plural(days, 'day');
  if (days < 365) return plural(Math.floor(days / 30), 'month');
  return plural(Math.floor(days / 365), 'year');
}
