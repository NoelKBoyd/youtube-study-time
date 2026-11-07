# Study Time

A Chrome extension: choose a topic and a length of time. Until the timer ends, YouTube only suggests videos about that topic.

While a session is running:

- **Watch page:** the recommendations sidebar is replaced with a feed of videos about your topic. It loads more as you scroll.
- **Home page:** the normal feed is covered by a grid of videos about your topic.
- **End of a video:** the suggestion cards shown in the player are hidden. If autoplay is on, the next video from your study feed plays instead of YouTube's pick.
- **Shorts:** open as a normal video page with the study feed, so there is no endless Shorts feed.
- **Search** still works as normal, so you can look things up yourself.

When time is up you get a notification and YouTube goes back to normal.

## Stats, goals and topic mastery

Every session is recorded when it ends. Click **View stats** in the popup (or the "finished" notification) to see:

- **Today, this week, current and best streak.** Times are *session time*: how long the session ran, not verified watch time.
- **Goals:** daily and weekly minutes, plus an optional total target per topic. A day keeps your streak when it reaches the daily goal (or, with no goal, has a completed session).
- **Topics:** total time, sessions, last studied and mastery level, sortable by any column. Topics match regardless of case and spaces.
- **Constellation:** each topic is a star that grows as it levels up (Spark 0 h, Curious 1 h, Steady 5 h, Focused 20 h, Deep 50 h, Mastery 100 h). A completed session makes its star twinkle.
- **History** with per-entry delete, **Clear history** and **Export JSON**.

Everything stays in Chrome's local storage. The only thing sent anywhere is your topic and API key, to the YouTube Data API, to fetch the feed. See the [privacy policy](PRIVACY.md).

## Install

1. Unzip the folder somewhere permanent. Chrome loads it from that location.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder inside `youtube-study-time`.
4. Pin the extension from the puzzle-piece menu so the icon is easy to reach.

## Development

Needs [Node.js](https://nodejs.org/). Run `npm install` once, then:

| Command | What it does |
|---|---|
| `npm run dev` | Opens Chrome with the extension loaded on youtube.com, and reloads it whenever you save a file. Uses its own Chrome profile, so your API key and login are kept between runs. |
| `npm test` | Runs the unit tests in a second or so, no browser needed. `npm run test:watch` reruns them on every save. |
| `npm run zip` | Builds a clean `.zip` of the extension (without the dev files) into `web-ext-artifacts/`. |

After an automatic reload, refresh any open YouTube tab so it picks up the new content script.

## Add your YouTube API key (one time)

The study feed comes from the YouTube Data API v3, so you need a free API key.

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/projectcreate).
2. Enable [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
3. Under [Credentials](https://console.cloud.google.com/apis/credentials), choose **Create credentials → API key**.
4. Click the extension icon, then **Settings**. Paste the key, click **Test key**, then **Save**.

Without a key, the panel still appears and shows a link to a normal YouTube search for your topic.

## Daily limit

By default a key gets **100 searches per day**. Each page of results (up to 50 videos) counts as one search. Results are cached for 24 hours, so going back to a topic you already used costs nothing. The limit resets at midnight Pacific time. Each page view is also capped at 10 pages (500 videos).

## Files

```
extension/      The extension itself: this is the folder Chrome loads
  manifest.json   Extension setup and permissions
  background.js   Session timer (alarms, badge, notification), the session log, and all YouTube API calls, with caching
  shared/         Code and styles used everywhere:
                    shared.js  level thresholds, default goals, topicKey() and date helpers
                    ui.js      Material Symbols icons (makeIcon()) and the snackbar
                    theme.css  the design system (Material 3 style colours, type, buttons, fields, chips, tables, dialog, snackbar)
                    fonts.css  Roboto for the extension's pages
  content/        Runs on youtube.com: content.js detects page changes, hides suggestions and builds the
                  study feed; content.css lays out the study panel (follows YouTube's light or dark theme)
  popup/          Toolbar popup: start a session, see the countdown, stop, today's total, link to stats
  options/        Settings page for the API key and the cache
  stats/          Stats page (totals, goals, streaks, topics, history, export) and constellation.js, its star drawing
  assets/         fonts/ (Roboto, SIL Open Font License) and icons/
test/           Unit tests, run with `npm test` (not part of the extension)
docs/           Feature notes and design specs
package.json, web-ext-config.mjs   Dev tooling only (not part of the extension)
```

## Known limits

- The feed is a **topic search**, not "related to this video". YouTube removed related-video search from the API in 2023.
- **Your own playlists** keep playing in order (Mixes, which YouTube picks for you, are treated as recommendations).
- YouTube changes its page structure from time to time. If its own sidebar can't be found, the feed still appears (in the right-hand column, or as a floating panel) and a warning is logged in the page console. All YouTube element names the extension relies on are in the `YT` list at the top of `extension/content/content.js` and at the top of `extension/content/content.css`.
