// Study Time - helpers shared by background.js, the popup and the stats page.
// Plain top-level declarations, no DOM: background.js loads this with importScripts(),
// the pages with a <script> tag.

// Topic mastery levels. A topic reaches a level once its total session time
// reaches `hours`. Tune the names and thresholds here; nothing else hard-codes them.
const LEVELS = [
  { level: 1, name: 'Spark', hours: 0 },
  { level: 2, name: 'Curious', hours: 1 },
  { level: 3, name: 'Steady', hours: 5 },
  { level: 4, name: 'Focused', hours: 20 },
  { level: 5, name: 'Deep', hours: 50 },
  { level: 6, name: 'Mastery', hours: 100 }
];

// 0 means "no goal set". perTopic maps a topicKey to a total target in minutes.
const DEFAULT_GOALS = { dailyMin: 0, weeklyMin: 0, perTopic: {} };

// Weeks start on Monday (0 = Sunday, 1 = Monday, ...).
const WEEK_STARTS_ON = 1;

// The one place topics are normalised: "Rust" and " rust " are the same topic.
// The 24h search cache uses the same key.
function topicKey(topic) {
  return String(topic || '').trim().toLowerCase();
}

// Returns { level, name, hours, next } for a total in minutes.
// `next` is the next LEVELS entry, or null at the top level.
function levelFor(totalMin) {
  let index = 0;
  while (index + 1 < LEVELS.length && totalMin >= LEVELS[index + 1].hours * 60) index++;
  return { ...LEVELS[index], next: LEVELS[index + 1] || null };
}

// Local midnight at the start of the day containing `ms`.
function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// Local midnight at the start of the week containing `ms`.
function startOfWeek(ms) {
  const date = new Date(startOfDay(ms));
  date.setDate(date.getDate() - ((date.getDay() - WEEK_STARTS_ON + 7) % 7));
  return date.getTime();
}

// Total actualMin of the records that ended in [from, to).
function minutesBetween(log, from, to) {
  let total = 0;
  for (const record of log || []) {
    if (record.endedAt >= from && record.endedAt < to) total += record.actualMin;
  }
  return total;
}

// 0 -> "0 m", 45 -> "45 m", 80 -> "1 h 20 m", 120 -> "2 h"
function formatMinutes(min) {
  const rounded = Math.round(min);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  if (!hours) return `${minutes} m`;
  return minutes ? `${hours} h ${minutes} m` : `${hours} h`;
}
