// YouTube Study Time - toolbar popup
// Start a session (topic + minutes), or see the countdown and stop early.

fillIcons();

const startView = document.getElementById('start-view');
const sessionView = document.getElementById('session-view');
const topicInput = document.getElementById('topic');
const minutesInput = document.getElementById('minutes');
const keyWarning = document.getElementById('key-warning');
const currentTopic = document.getElementById('current-topic');
const countdown = document.getElementById('countdown');
const todayRow = document.getElementById('today');
const todayTotal = document.getElementById('today-total');
const todayGoal = document.getElementById('today-goal');
const todayProgress = document.getElementById('today-progress');

let countdownTimer = null;

async function render() {
  const { session, apiKey, lastTopic, lastMinutes, sessionLog, goals } = await chrome.storage.local.get([
    'session', 'apiKey', 'lastTopic', 'lastMinutes', 'sessionLog', 'goals'
  ]);
  const active = session && session.endTime > Date.now();
  renderToday(sessionLog, goals);

  startView.hidden = active;
  sessionView.hidden = !active;
  keyWarning.hidden = Boolean(apiKey);
  clearInterval(countdownTimer);

  if (active) {
    currentTopic.textContent = session.topic;
    const tick = () => {
      const msLeft = session.endTime - Date.now();
      if (msLeft <= 0) return render();
      countdown.textContent = formatTime(msLeft);
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  } else {
    // Pre-fill with the last session's values
    if (lastTopic) topicInput.value = lastTopic;
    if (lastMinutes) minutesInput.value = lastMinutes;
    topicInput.focus();
  }
}

// "Today: 25 m", plus "of 1 h" and a progress bar when a daily goal is set.
// Finished sessions only; the running one is added to the log when it ends.
function renderToday(sessionLog, goals) {
  const today = minutesBetween(sessionLog, startOfDay(Date.now()), Infinity);
  const dailyMin = goals && goals.dailyMin > 0 ? goals.dailyMin : 0;
  todayRow.hidden = !(today > 0 || dailyMin);
  todayTotal.textContent = todayRow.hidden ? '' : `Today: ${formatMinutes(today)}`;
  todayGoal.textContent = dailyMin ? ` of ${formatMinutes(dailyMin)}` : '';
  todayProgress.hidden = !dailyMin;
  if (dailyMin) {
    todayProgress.setAttribute('aria-valuemin', '0');
    todayProgress.setAttribute('aria-valuemax', String(Math.round(dailyMin)));
    todayProgress.setAttribute('aria-valuenow', String(Math.round(Math.min(today, dailyMin))));
    todayProgress.firstElementChild.style.width = `${Math.min(100, (today / dailyMin) * 100)}%`;
  }
}

startView.addEventListener('submit', async (event) => {
  event.preventDefault();
  const topic = topicInput.value.trim();
  const minutes = Number(minutesInput.value);
  if (!topic || !(minutes > 0)) return;

  await chrome.storage.local.set({ lastTopic: topic, lastMinutes: minutes });
  await chrome.runtime.sendMessage({ type: 'start', topic, minutes });
  render();
});

document.getElementById('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  render();
});

document.getElementById('open-stats').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') });
  window.close();
});

for (const link of document.querySelectorAll('.open-options')) { // a link and a button
  link.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
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

render();
