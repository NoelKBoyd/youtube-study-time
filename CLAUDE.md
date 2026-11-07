# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Manifest V3 Chrome extension in plain JavaScript/CSS/HTML. There is no build step and no runtime dependencies: the files in `extension/` are loaded into Chrome as they are. Everything at the top level (`package.json`, `web-ext-config.mjs`, `test/`, `docs/`) is dev tooling (`web-ext`, `jsdom`) or docs; run `npm install` once.

### Layout

```
extension/            the extension itself (web-ext's sourceDir; this is what gets zipped)
  manifest.json
  background.js       service worker
  shared/             shared.js, ui.js, theme.css, fonts.css (used by the worker, pages and content script)
  content/            content.js, content.css (injected into youtube.com)
  popup/              popup.html/.js/.css (toolbar popup)
  options/            options.html/.js/.css (settings page)
  stats/              stats.html/.js/.css, constellation.js (stats page)
  assets/             fonts/ (Roboto), icons/
test/                 unit tests (paths in load.js / loadPage are relative to extension/)
docs/                 FEATURES.md, design specs
```

Paths in `manifest.json`, `importScripts()` and `chrome.runtime.getURL()` are relative to `extension/`; paths in the pages' `<link>`/`<script>` tags are relative to the page (`../shared/theme.css`). A new page gets its own folder under `extension/`.

## Running and testing

- `npm test` runs the unit tests (Node's built-in `node:test`, about 1s). `npm run test:watch` reruns on save. Run a single file with `node --test test/background.test.js`, or a single test with `node --test --test-name-pattern="formatTime" "test/*.test.js"`.
- `npm run dev` opens Chrome with the extension already loaded on youtube.com and reloads it automatically when a file changes. It uses a persistent dev profile in `node_modules/.chrome-dev-profile`, so the API key and YouTube login survive restarts. Open YouTube tabs still need a page refresh after a reload to get the new content script.
- `npm run zip` writes a clean package of `extension/` to `web-ext-artifacts/` (`sourceDir` in `web-ext-config.mjs`, so dev files never need excluding; keep them out of `extension/`).
- Manual load still works: `chrome://extensions` → Developer mode → **Load unpacked** → the `extension/` folder. Tabs already open on youtube.com keep the old content script after a reload (its `chrome.runtime.sendMessage` calls fail, which `content.js` shows as the `reloaded` error).
- Debug the service worker via the "service worker" link on the extension card; debug `content.js` in the YouTube tab's DevTools.
- The feed needs a YouTube Data API v3 key, entered in the options page. Without one the panel still renders and falls back to a plain YouTube search link.

### How the tests work

The tests load the real source files unchanged, so the extension code never needs `export`s or test hooks:
- `test/fake-chrome.js` is an in-memory `chrome.*` (storage with `onChanged`, alarms, badge, notifications, runtime messaging). `sendToBackground()` delivers a message to `background.js`'s `onMessage` listener and resolves with its `sendResponse` value.
- `test/load.js`: `loadBackground({ storage, fetch })` runs `background.js` in a `node:vm` context with a stubbed `fetch` (its `importScripts('shared/shared.js')` runs `shared.js` in the same context). `loadContent({ url, html, storage, search })` runs the manifest's content scripts (`shared/shared.js`, `shared/ui.js`, `content/content.js`) in a jsdom page at that URL, with a fake `IntersectionObserver` that always reports the sentinel as visible, and `search` answering the `search` message. `loadPage(file, scripts, { storage, messageHandler })` opens one of the extension's own pages (e.g. `stats/stats.html`, `popup/popup.html`) in jsdom with its real markup and runs the listed scripts in order (all paths relative to `extension/`). All three return `get(name)` to read any top-level function or `const` from the script.
- Objects coming out of a sandbox have a different `Object` prototype, so `assert.deepEqual` fails on them; copy them first (`structuredClone`, or `[...arr]`). `sendToBackground` already does this.
- jsdom has `<dialog>` but no `showModal()`/`close()`; the stats test stubs them. jsdom can't navigate, so code paths that call `location.replace/assign` (Shorts redirect, autoplay) aren't unit-tested; check those in `npm run dev`. CSS and real YouTube layout are also only checked there.
- One test checks that every error code returned in `background.js` has an `ERROR_MESSAGES` entry in `content.js`.

## Architecture

All shared state lives in `chrome.storage.local`, and components coordinate through it instead of messaging each other directly:

- `session` → `{ id, topic, startedAt, endTime, plannedMin, accumulatedMs, segmentStart }` while a session runs (missing otherwise)
- `sessionLog` → `[{ id, topic, topicKey, startedAt, endedAt, plannedMin, actualMin, outcome }]`, one record per finished session, `outcome` is `completed` or `stopped`
- `goals` → `{ dailyMin, weeklyMin, perTopic: { [topicKey]: targetMin } }` (0 or missing = no goal)
- `apiKey` → the user's API key
- `cache:<lowercased topic>|<pageToken>` → `{ savedAt, data }`, cached search results (24h)
- `lastTopic`, `lastMinutes` → popup form defaults

**shared.js** holds what several scripts need, as plain top-level declarations: the mastery `LEVELS` thresholds, `DEFAULT_GOALS`, `topicKey()` (trim + lowercase; also the cache key), and the date/format helpers. `background.js` loads it with `importScripts`, the pages with a `<script>` tag before their own, and the manifest lists it before `content.js` in `content_scripts` (they share one scope, so `content.js` must not redeclare its names).

**background.js** (service worker) is the only place that writes `session` and `sessionLog`, and the only place that calls the YouTube API (`host_permissions` covers googleapis.com only). It handles runtime messages `start`, `stop`, `search`, `testKey`, `deleteLog`, `clearLog`, `openOptions`, `openStats` (`section: 'goals'` opens it at `#goals-heading`). The session end is driven by a `chrome.alarms` alarm. On `onStartup`, the alarm and badge are rebuilt from storage because they can be lost on browser restart; a session that ran out while Chrome was closed is logged as `completed`, without a notification.

Session logging: every way a session ends (alarm, `stop`, startup cleanup, or a `start` that replaces it) appends one record via `logSession()`, which skips ids already in the log. Session changes run through `serial()`, a promise queue, so a Stop and the alarm can't both log. The panel's Edit sends `start` again: with the same `topicKey` that is the same session (time so far moves into `accumulatedMs`, `segmentStart` resets), with a different topic the old session is logged as `stopped` and a new one starts. `actualMin` is session time capped at `endTime`. Sessions from before v1.1 (no `id`) end without being logged. The page's countdown hitting zero is UI-only and never logs. API errors are reduced to short codes (`nokey`, `badkey`, `disabled`, `quota`, `network`, `api`), which `content.js` maps to messages in `ERROR_MESSAGES`. Keep these two lists in step.

**content.js** reacts to `chrome.storage.onChanged` for `session` and to YouTube's SPA event `yt-navigate-finish`; both call `update()`. `update()` removes any existing panel, toggles the `yst-active` class on `<html>`, then builds a panel: a sidebar before `ytd-watch-flexy #related` on `/watch`, or a grid prepended into `ytd-page-manager` on `/` (the home feed is `display:none`; a fixed full-window overlay is the fallback). `updateCount` guards against stale async runs after navigation. Each panel carries a `cleanup()` that stops its countdown interval and its `IntersectionObserver` infinite-scroll feed (capped at `MAX_PAGES` = 10 API calls per page view). The countdown also calls `update()` when time runs out, so the page reverts even before the alarm fires. The panel header has an **Edit** button that opens an inline form (`createEditor()`) to change the topic and minutes left, or stop: saving sends `start` again (which overwrites `session` and the alarm) and stopping sends `stop`, so the storage change rebuilds the panel. With no session, the home page gets a slim start bar (`createStartBar()`, pre-filled from `lastTopic`/`lastMinutes`) that sends `start`. It goes inside YouTube's home feed, right before the video grid (`YT.homeGrid`), which puts it below the in-flow placeholder of the filter chips (`#chips-wrapper` is `position: fixed` at the top of the window). Don't put it in `ytd-page-manager`: that is a flex row, and a full-width bar there squeezes the feed to 0px wide. If the grid isn't found within 5s the bar is skipped with a console warning. It is one card, weighted to the left so the right edge only holds actions: a header row (title + goals on the left in `.yst-start-lead` | **Stats**, ×) and a CSS grid (`.yst-start-grid`, named areas in content.css): Topic | Minutes | Start on the first row, then one left-aligned chip row (`.yst-start-chips`): up to 3 recent topics from `sessionLog` (`renderRecentTopics()`, fill the Topic field), a divider, and quick-pick minute chips (`QUICK_MINUTES`, `minutePicks()`). Below 720px the grid stacks (Topic, Minutes + Start, then recent topics and minute chips on their own lines) and the header's labelled buttons (`collapsibleButton()`) become icon buttons with tooltips. Only Start uses a solid primary fill; Stats is tonal on a neutral surface (`yst-neutral`). The header shows today/this week against `goals` (computed from `sessionLog`; each pill, or a single "Set daily & weekly goals" text button when neither is set, opens the stats page at the goals form); the storage listener calls the bar's `refresh()` when `goals` or `sessionLog` change. Its × hides it for the tab via the `sessionStorage` key `yst-start-hidden`. DOM is built with the `make()` helper using `textContent` only, never `innerHTML`.

**content.css** hides YouTube's own suggestions with selectors scoped under `html.yst-active`, and lays out the panel (all selectors under `#yst-panel`). Its colours and components come from `theme.css`; content.css only sets `color-scheme` on `#yst-panel` from YouTube's `html[dark]` attribute, which flips every `light-dark()` token.

**theme.css / ui.js / fonts.css** are the shared UI. `theme.css` holds the design tokens (`--yst-*`, each written once with `light-dark()`) and every component (`yst-button` + `yst-tonal`/`yst-outlined`/`yst-text`/`yst-danger`, `yst-icon-button` with `data-tooltip`, outlined `yst-field` with floating label and suffix, `yst-chip`, `yst-status-chip`, `yst-progress`, `yst-table`, `yst-banner`, `yst-dialog`, `yst-snackbar`, `yst-filled-card`). Tokens sit on `.yst-theme` (the pages' `<html>`, `color-scheme: light dark`, so they follow the system) and on `#yst-panel` (content.css pins its `color-scheme` to YouTube's `html[dark]`). The manifest injects `theme.css` before `content.css`, so everything in it must stay scoped: `yst-` class names only, nothing on bare elements outside `.yst-theme`, px not rem (YouTube's root font size is 10px), and no `@font-face` (that is in `fonts.css`, pages only, since declaring Roboto on youtube.com would make YouTube's own text request it). Don't name a component `.yst-card`: that is the panel's video card. `ui.js` has the Material Symbols path data (`ICON_PATHS`), `makeIcon(name)`, `fillIcons()` (each page script calls it first, to turn `<span data-icon="name">` placeholders into SVGs) and `showSnackbar(text)`; it is loaded by the pages and listed between `shared.js` and `content.js` in `content_scripts`. A test checks that every icon name used in the HTML/JS exists in `ICON_PATHS`.

**popup.js / options.js** only read and write storage and send messages to the background worker. The popup also shows today's session time (with the daily goal's progress if one is set) and **View stats** / **Settings**. The settings page shows Test key results in an inline banner and confirms saves with a snackbar.

**stats.html / stats.js / stats.css** is the stats page (opened from the popup, or by clicking the "finished" notification, with `chrome.tabs.create`). `stats.js` computes everything from `sessionLog` and `goals` on each render: today/week totals, streaks (by local day; a day counts when it reaches `dailyMin`, or has a completed session if no daily goal), the topics table, history, goal bars. It writes only `goals`; history delete/clear go through the background (Clear history asks first in a `<dialog>`). It re-renders on `storage.onChanged`. Light/dark follows `prefers-color-scheme`. **constellation.js** is the swappable visual for topic mastery: `renderConstellation(container, topics)` and `twinkle(topicKey)`, plain SVG, star positions seeded from the topic key so they stay put.

Beyond the panel, `content.js` also: redirects `/shorts/<id>` to `/watch?v=<id>` during a session; and replaces autoplay. A capturing `ended` listener on `document` (skipping ads via `.ad-showing` and user playlists, but not `list=RD…` Mixes) clicks YouTube's "Up next" cancel button and navigates to the first study card not yet in the per-tab `sessionStorage` `yst-watched` list. A `yt-navigate-finish` safety net treats any navigation within 15s of `ended` with no user pointer/key input as autoplay and redirects it.

## When YouTube's layout changes

Every YouTube DOM name the script depends on is in the `YT` object at the top of `content.js`; the CSS ones are at the top of `content.css` (which also has a second layer hiding recommendation card elements inside `#secondary`, and a rule cutting the `#frosted-glass.with-chipbar` backdrop behind the top bar back to the bar's height, since it otherwise covers the top of the home panel). If `#related` isn't found within 5s, the panel falls back to prepending into `#secondary`, then to a fixed `yst-floating` panel, and logs a `[YouTube Study Time]` console warning.

## Known limits (by design)

The feed is a topic search, not "related videos" (the API dropped related-video search in 2023). The default API quota is about 100 searches per day, at 1 search per 50-result page, which is why the cache and `MAX_PAGES` exist.
