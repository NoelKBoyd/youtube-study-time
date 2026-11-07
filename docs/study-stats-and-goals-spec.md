# YouTube Study Time: Stats, Goals & Topic Mastery (spec for v1.1)

Builds on the v1.0.0 feature list. Closes two of its listed gaps: "no history, stats, streaks or study log" and (partly) "nothing stops you from leaving" by giving sessions a reason to be finished.

## Decisions so far

| Question | Decision |
|---|---|
| Leaderboard | Local stats first. A friends leaderboard is phase 2 (parked below). |
| Topic grouping | Exact topic text, trimmed and lowercased (same key the 24h cache uses). |
| Reward mechanic | Not a Forest-style plant. Reward-only, no penalty. Proposed: **topic mastery levels + constellation** (below). |
| Where it lives | New stats page, opened from a link in the popup. |

## What it adds

1. **Session log**: every session is recorded when it ends.
2. **Stats page**: today / this week totals, per-topic totals, history, streak.
3. **Goals**: daily minutes, weekly minutes, optional per-topic target.
4. **Topic mastery**: each topic levels up with total study time and appears as a star in a constellation.

No new permissions. No server. Data stays in `chrome.storage.local`.

## Data model

```js
// chrome.storage.local
sessionLog: [{
  id,            // same id as the running session, used to log exactly once
  topic,         // as typed
  topicKey,      // trim().toLowerCase()
  startedAt,     // ms epoch
  endedAt,       // ms epoch
  plannedMin,
  actualMin,     // real study time, see "Edit restarts the timer" below
  outcome        // 'completed' | 'stopped'
}]

goals: { dailyMin, weeklyMin, perTopic: { [topicKey]: targetMin } }
```

A record is ~150 bytes, so the 10 MB `chrome.storage.local` default holds tens of thousands of sessions. No `unlimitedStorage` needed.

## Logging: where to hook in

The background service worker owns logging, never the page, so multiple open YouTube tabs can't double-log.

| Session ends because... | Outcome | Hook |
|---|---|---|
| Alarm fires | completed | existing alarm handler |
| **Stop early** (popup or panel) | stopped | existing stop path |
| Browser restarted after time ran out | completed | existing quiet cleanup on startup |

Rules:
- The running session needs an `id` (add one at start). Log, then clear the session, in one step. If a record with that `id` already exists, skip.
- The page's "countdown hit zero" UI change stays UI-only. It must not write to the log.

### Edit restarts the timer
v1.0.0 restarts the timer from "minutes left" when you edit it, so `endedAt - startedAt` would be wrong. Add `accumulatedMs` to the running session: on edit, add `now - segmentStart` to it, then set `segmentStart = now`. At the end, `actualMin = (accumulatedMs + now - segmentStart) / 60000`.

### What "study time" means
It is session time, not watch time. The extension can't verify you're watching. Label it "session time" in the UI.

## Stats page (`stats.html`)

- **Header tiles**: today, this week, current streak, best streak.
- **Goal progress**: bars for daily and weekly targets. Per-topic target shown on that topic's row.
- **Topics table**: topic, total time, sessions, last studied, level. Sort by any column.
- **History**: newest first, with outcome (completed / stopped). Delete one entry or clear all.
- **Constellation**: see below.
- **Export JSON** and **Clear history** buttons. Export also makes phase 2 easier.

Totals count `actualMin` for all sessions, including stopped ones. Stopping early is never punished, it just contributes less.

### Streaks
A day counts if its total reaches the daily goal, or at least one completed session if no goal is set. Use local midnight. Compute from the log, don't store it.

## Topic mastery (the reward)

Each topic has a level based on total study time:

| Level | Name | Total time |
|---|---|---|
| 1 | Spark | 0 |
| 2 | Curious | 1 h |
| 3 | Steady | 5 h |
| 4 | Focused | 20 h |
| 5 | Deep | 50 h |
| 6 | Mastery | 100 h |

Thresholds are constants in one file so they're easy to tune.

### Constellation
Each topic is a star on a dark sky. Size and brightness follow level. Click or hover shows topic, total time and next level. A completed session briefly twinkles that topic's star.

- Plain SVG, no libraries.
- Matches the light/dark theme handling the study feed already has.
- Original theme and artwork. Nothing borrowed from other focus apps.

The data model doesn't depend on the theme, so the visual layer can be swapped later (bookshelf, skyline, etc.) without touching storage.

## Files touched (expected)

- `background.js`: session id, `accumulatedMs`, log-on-end, goals defaults.
- Popup: "View stats" link, optionally today's total.
- `stats.html` / `stats.js` / `stats.css`: new.
- Shared constants: level thresholds, `topicKey()` helper (reuse the cache's normalisation).
- `manifest.json`: nothing new for permissions. Stats page is opened with `chrome.tabs.create`.

## Build order

1. Session id, `accumulatedMs`, and log-on-end in the background. Verify records appear in storage.
2. Stats page with totals, topics table, history.
3. Goals + streaks.
4. Levels + constellation.
5. Export / clear.

## Test checklist

- Complete a session → one record, `completed`, `actualMin` ≈ planned.
- Stop early → one record, `stopped`, `actualMin` = real elapsed.
- Edit minutes mid-session, then finish → `actualMin` includes time before and after the edit.
- Two YouTube tabs open, session ends → exactly one record.
- Close all YouTube tabs, let the alarm fire → record still written.
- Restart browser after expiry → one `completed` record, no notification spam.
- "Rust" and " rust " land in the same topic.
- Clear history → totals, streak and constellation reset.

## Parked: friends leaderboard (phase 2)

- Needs a backend and identity, which breaks the current "no account or server" privacy claim. That page and the settings copy would need updating, and it should be opt-in.
- Join a group by shared code, upload daily totals only (not topics, not titles).
- Study time is self-reported, so expect cheating. Cap per day, count completed sessions only, and keep it friends-only so trust is social.

## Open questions

- Should a day with only stopped sessions keep a streak alive? (Default above: yes, if it meets the daily goal.)
- Level names and thresholds: fine as a starting point?
- Per-topic targets: worth including in v1.1, or leave to later?
