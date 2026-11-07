// YouTube Study Time - stats page
// Reads sessionLog and goals from storage and draws totals, goals, streaks, topics
// and history. It writes only `goals`; deleting history goes through the background
// worker, which owns sessionLog.

const HISTORY_PAGE_SIZE = 50;
const TWINKLE_WINDOW_MS = 10 * 60 * 1000; // a session that ended this recently twinkles on load

const state = {
  log: [],
  goals: DEFAULT_GOALS,
  sort: { column: 'totalMin', dir: -1 },
  historyShown: HISTORY_PAGE_SIZE
};

const $ = (id) => document.getElementById(id);

// Small DOM helper: make('td', { className: 'num' }, 'text', childNode, ...).
// Text is always inserted with textContent, never as HTML.
function make(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key in element) element[key] = value;
    else element.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

// ---------- Calculations (pure) ----------

// "2026-11-07" for the local day containing `ms`.
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The dayKey of the day before or after `key` (DST-safe: it goes through local dates).
function shiftDay(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + days).getTime());
}

// A day counts towards a streak if its total reaches the daily goal, or, with no
// daily goal set, if it has at least one completed session. Days are local.
function countingDays(log, goals) {
  const days = new Map();
  for (const record of log) {
    const key = dayKey(record.endedAt);
    const day = days.get(key) || { min: 0, completed: 0 };
    day.min += record.actualMin;
    if (record.outcome === 'completed') day.completed++;
    days.set(key, day);
  }
  const dailyMin = goals && goals.dailyMin > 0 ? goals.dailyMin : 0;
  const counting = new Set();
  for (const [key, day] of days) {
    if (dailyMin ? day.min >= dailyMin : day.completed > 0) counting.add(key);
  }
  return counting;
}

// { current, best } in days. The current streak is still alive if today doesn't
// count yet but yesterday did.
function computeStreaks(log, goals, now = Date.now()) {
  const counting = countingDays(log, goals);

  let best = 0;
  for (const key of counting) {
    if (counting.has(shiftDay(key, -1))) continue; // not the first day of a run
    let length = 1;
    while (counting.has(shiftDay(key, length))) length++;
    best = Math.max(best, length);
  }

  let key = dayKey(now);
  if (!counting.has(key)) key = shiftDay(key, -1);
  let current = 0;
  while (counting.has(key)) {
    current++;
    key = shiftDay(key, -1);
  }
  return { current, best };
}

// One row per topicKey, with the topic as most recently typed.
function summarizeTopics(log, goals) {
  const topics = new Map();
  for (const record of log) {
    const key = record.topicKey || topicKey(record.topic);
    let topic = topics.get(key);
    if (!topic) {
      topic = { key, topic: record.topic, totalMin: 0, sessions: 0, lastAt: 0, firstAt: Infinity, lastCompletedAt: 0 };
      topics.set(key, topic);
    }
    topic.totalMin += record.actualMin;
    topic.sessions++;
    if (record.endedAt >= topic.lastAt) {
      topic.lastAt = record.endedAt;
      topic.topic = record.topic;
    }
    topic.firstAt = Math.min(topic.firstAt, record.startedAt || record.endedAt);
    if (record.outcome === 'completed') topic.lastCompletedAt = Math.max(topic.lastCompletedAt, record.endedAt);
  }
  const perTopic = (goals && goals.perTopic) || {};
  return [...topics.values()].map((topic) => {
    const level = levelFor(topic.totalMin);
    return { ...topic, level: level.level, levelInfo: level, targetMin: perTopic[topic.key] || 0 };
  });
}

function sortTopics(topics, { column, dir }) {
  return [...topics].sort((a, b) => {
    const x = a[column];
    const y = b[column];
    const order = typeof x === 'string' ? x.localeCompare(y, undefined, { sensitivity: 'base' }) : x - y;
    return order * dir || b.totalMin - a.totalMin;
  });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function formatDate(ms, withTime = false) {
  const options = { weekday: 'short', day: 'numeric', month: 'short' };
  if (new Date(ms).getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  if (withTime) Object.assign(options, { hour: '2-digit', minute: '2-digit' });
  return new Date(ms).toLocaleString(undefined, options);
}

// ---------- Rendering ----------

function render() {
  const now = Date.now();
  const { log, goals } = state;
  const today = minutesBetween(log, startOfDay(now), Infinity);
  const week = minutesBetween(log, startOfWeek(now), Infinity);
  const streaks = computeStreaks(log, goals, now);

  $('tile-today').textContent = formatMinutes(today);
  $('tile-week').textContent = formatMinutes(week);
  $('tile-streak').textContent = plural(streaks.current, 'day');
  $('tile-best').textContent = plural(streaks.best, 'day');

  renderGoals(today, week);
  const topics = summarizeTopics(log, goals);
  renderTopics(topics);
  renderHistory();
  if (typeof renderConstellation === 'function') renderConstellation($('sky'), topics);
}

function progressBar(label, doneMin, targetMin) {
  const ratio = targetMin > 0 ? Math.min(1, doneMin / targetMin) : 0;
  const bar = make('div', {
    className: 'bar' + (ratio >= 1 ? ' done' : ''),
    role: 'progressbar',
    'aria-label': label,
    'aria-valuemin': '0',
    'aria-valuemax': String(Math.round(targetMin)),
    'aria-valuenow': String(Math.round(Math.min(doneMin, targetMin)))
  }, make('span', { className: 'bar-fill' }));
  bar.firstChild.style.width = `${ratio * 100}%`;
  return bar;
}

function renderGoals(today, week) {
  const { dailyMin = 0, weeklyMin = 0 } = state.goals;
  const bars = $('goal-bars');
  bars.replaceChildren();
  for (const [label, done, target] of [['Today', today, dailyMin], ['This week', week, weeklyMin]]) {
    if (!(target > 0)) continue;
    bars.append(
      make('div', { className: 'goal' },
        make('div', { className: 'goal-text' },
          make('span', {}, label),
          make('span', { className: 'goal-numbers' }, `${formatMinutes(done)} of ${formatMinutes(target)}`)
        ),
        progressBar(`${label} goal`, done, target)
      )
    );
  }
  if (!bars.childElementCount) bars.append(make('p', { className: 'empty' }, 'No goals set yet.'));

  // Don't overwrite what the user is typing.
  if (document.activeElement !== $('goal-daily')) $('goal-daily').value = dailyMin || '';
  if (document.activeElement !== $('goal-weekly')) $('goal-weekly').value = weeklyMin || '';
  $('streak-rule').textContent = dailyMin > 0
    ? `A day counts towards your streak when it reaches ${formatMinutes(dailyMin)}, stopped sessions included.`
    : 'With no daily goal, a day counts towards your streak when it has at least one completed session.';
}

function renderTopics(topics) {
  const tbody = $('topics-table').tBodies[0];
  tbody.replaceChildren();
  $('topics-empty').hidden = topics.length > 0;
  $('topics-table').hidden = topics.length === 0;

  for (const button of document.querySelectorAll('#topics-table .sort')) {
    const active = button.dataset.sort === state.sort.column;
    button.closest('th').setAttribute('aria-sort', active ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
  }

  for (const topic of sortTopics(topics, state.sort)) {
    const target = make('input', {
      type: 'number',
      min: '0',
      step: '0.5',
      className: 'target-input',
      placeholder: '—',
      value: topic.targetMin ? String(Math.round((topic.targetMin / 60) * 100) / 100) : '',
      'aria-label': `Target hours for ${topic.topic}`,
      dataset: { key: topic.key }
    });
    const targetCell = make('td', { className: 'target' }, target);
    if (topic.targetMin) {
      targetCell.append(progressBar(`${topic.topic} target`, topic.totalMin, topic.targetMin));
    }
    tbody.append(
      make('tr', {},
        make('th', { scope: 'row', className: 'topic-name' }, topic.topic),
        make('td', { className: 'num' }, formatMinutes(topic.totalMin)),
        make('td', { className: 'num' }, String(topic.sessions)),
        make('td', {}, formatDate(topic.lastAt)),
        make('td', {}, make('span', { className: `level-badge level-${topic.level}` }, `${topic.level} · ${topic.levelInfo.name}`)),
        targetCell
      )
    );
  }
}

function renderHistory() {
  const records = [...state.log].sort((a, b) => b.endedAt - a.endedAt);
  const tbody = $('history-table').tBodies[0];
  tbody.replaceChildren();
  $('history-empty').hidden = records.length > 0;
  $('history-table').hidden = records.length === 0;
  $('clear').disabled = records.length === 0;
  $('export').disabled = records.length === 0;

  for (const record of records.slice(0, state.historyShown)) {
    tbody.append(
      make('tr', {},
        make('td', {}, formatDate(record.endedAt, true)),
        make('th', { scope: 'row', className: 'topic-name' }, record.topic),
        make('td', { className: 'num' }, formatMinutes(record.plannedMin)),
        make('td', { className: 'num' }, formatMinutes(record.actualMin)),
        make('td', {}, make('span', { className: `outcome ${record.outcome}` }, record.outcome)),
        make('td', {},
          make('button', {
            type: 'button',
            className: 'icon delete',
            title: 'Delete this entry',
            'aria-label': `Delete ${record.topic} session from ${formatDate(record.endedAt, true)}`,
            dataset: { id: record.id }
          }, '×')
        )
      )
    );
  }
  $('more').hidden = records.length <= state.historyShown;
}

// ---------- Actions ----------

async function saveGoals(goals) {
  state.goals = goals;
  await chrome.storage.local.set({ goals });
}

// Minutes from an input; empty, negative or invalid means "no goal" (0).
function readMinutes(input, scale = 1) {
  const value = Number(input.value) * scale;
  return input.value.trim() !== '' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

$('goals-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveGoals({ ...state.goals, dailyMin: readMinutes($('goal-daily')), weeklyMin: readMinutes($('goal-weekly')) });
  $('goals-status').textContent = 'Saved.';
  setTimeout(() => ($('goals-status').textContent = ''), 2000);
  render();
});

$('topics-table').addEventListener('change', async (event) => {
  const input = event.target.closest('.target-input');
  if (!input) return;
  const perTopic = { ...state.goals.perTopic };
  const targetMin = readMinutes(input, 60);
  if (targetMin) perTopic[input.dataset.key] = targetMin;
  else delete perTopic[input.dataset.key];
  await saveGoals({ ...state.goals, perTopic });
  render();
});

$('topics-table').addEventListener('click', (event) => {
  const button = event.target.closest('.sort');
  if (!button) return;
  const column = button.dataset.sort;
  // Text columns start A→Z; number and date columns start biggest/newest first.
  state.sort = state.sort.column === column
    ? { column, dir: -state.sort.dir }
    : { column, dir: column === 'topic' ? 1 : -1 };
  render();
});

$('history-table').addEventListener('click', (event) => {
  const button = event.target.closest('.delete');
  if (button) chrome.runtime.sendMessage({ type: 'deleteLog', id: button.dataset.id });
});

$('more').addEventListener('click', () => {
  state.historyShown += HISTORY_PAGE_SIZE;
  renderHistory();
});

$('clear').addEventListener('click', () => {
  if (!confirm('Delete your whole session history? Totals, streaks and the constellation start again from zero. This cannot be undone.')) return;
  chrome.runtime.sendMessage({ type: 'clearLog' });
});

$('export').addEventListener('click', () => {
  const data = {
    app: 'YouTube Study Time',
    version: 1,
    exportedAt: new Date().toISOString(),
    goals: state.goals,
    sessionLog: state.log
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = make('a', { href: url, download: `study-sessions-${dayKey(Date.now())}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- Loading and live updates ----------

function applyStorage({ sessionLog, goals }) {
  if (sessionLog !== undefined) state.log = Array.isArray(sessionLog) ? sessionLog : [];
  if (goals !== undefined) state.goals = { ...DEFAULT_GOALS, ...goals, perTopic: { ...(goals && goals.perTopic) } };
}

// Topic keys whose star should twinkle: completed sessions that are new since `before`.
function newlyCompleted(before, after) {
  const known = new Set(before.map((record) => record.id));
  return after.filter((record) => record.outcome === 'completed' && !known.has(record.id)).map((r) => r.topicKey);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.sessionLog || changes.goals)) return;
  const before = state.log;
  applyStorage({
    sessionLog: changes.sessionLog ? changes.sessionLog.newValue || [] : undefined,
    goals: changes.goals ? changes.goals.newValue || DEFAULT_GOALS : undefined
  });
  render();
  if (changes.sessionLog && typeof twinkle === 'function') newlyCompleted(before, state.log).forEach(twinkle);
});

async function init() {
  $('levels-legend').textContent =
    'Levels: ' + LEVELS.map((level) => `${level.level} ${level.name} (${level.hours} h)`).join(' · ');
  applyStorage(await chrome.storage.local.get(['sessionLog', 'goals']));
  render();
  if (typeof twinkle !== 'function') return;
  const recent = state.log.filter((r) => r.outcome === 'completed' && Date.now() - r.endedAt < TWINKLE_WINDOW_MS);
  new Set(recent.map((r) => r.topicKey)).forEach(twinkle);
}

init();
