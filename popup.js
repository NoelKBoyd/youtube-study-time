// YouTube Study Time - toolbar popup
// Start a session (topic + minutes), or see the countdown and stop early.

const startView = document.getElementById('start-view');
const sessionView = document.getElementById('session-view');
const topicInput = document.getElementById('topic');
const minutesInput = document.getElementById('minutes');
const keyWarning = document.getElementById('key-warning');
const currentTopic = document.getElementById('current-topic');
const countdown = document.getElementById('countdown');

let countdownTimer = null;

async function render() {
  const { session, apiKey, lastTopic, lastMinutes } = await chrome.storage.local.get([
    'session', 'apiKey', 'lastTopic', 'lastMinutes'
  ]);
  const active = session && session.endTime > Date.now();

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

for (const link of document.querySelectorAll('.open-options')) {
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
