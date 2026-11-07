# YouTube Study Time: Features

A full list of what the extension does today (v1.1.0), followed by the gaps that are the most obvious places to expand it.

## Study sessions

- **Start a session** with a topic (up to 100 characters) and a length (1–600 minutes). You can start one from the toolbar popup or from the bar on the YouTube home page.
- **Your last topic and length are filled in for you** in both start forms. A fresh install defaults to 45 minutes.
- **The timer is a real Chrome alarm**, so the session still ends on time if every YouTube tab is closed.
- **You can survive a browser restart.** On startup the alarm and badge are rebuilt from storage, and a session whose time already ran out is ended quietly.
- **An "ON" badge** in green sits on the toolbar icon while a session is running.
- **You get a desktop notification** ("Study session finished") when time runs out.
- **The page goes back to normal right away** when the countdown hits zero, even if the alarm hasn't fired yet.
- **All open YouTube tabs update together.** Every tab follows the shared session in storage, so starting, editing or stopping updates them all.

## Controls

- **Toolbar popup:** the start form when no session is running. During a session it shows the topic, a live countdown and a **Stop early** button. It warns you, with a link to settings, if no API key is set. Its footer shows today's session time and a **View stats** link.
- **Edit button on the panel** (on the YouTube page itself): change the topic or the minutes left, or **Stop session**, without opening the popup. Esc or Cancel closes it.
- **Start bar on the home page** when no session is running. It sits inside YouTube's feed, just above the videos. Its **×** hides it for that tab only.
- **Typing in the forms doesn't trigger YouTube's shortcuts** (k, j, f, / and so on).

## Stats, goals and topic mastery

- **Every session is logged when it ends**, as `completed` (time ran out) or `stopped` (stopped early, or switched to another topic). It's logged once, by the background worker, even with several YouTube tabs open, with every YouTube tab closed, or after a browser restart.
- **Editing the minutes keeps the time already studied.** The session's time is the time before the edit plus the time after it.
- **Stats page** (from **View stats** in the popup, or by clicking the "Study session finished" notification): today, this week, current streak and best streak. Times are labelled *session time*, since the extension can't verify you were watching.
- **Goals:** a daily and a weekly target in minutes, shown as progress bars, and an optional total target (in hours) per topic, shown on its row.
- **Streaks** use local midnight. A day counts when its total reaches the daily goal, stopped sessions included; with no daily goal, it needs one completed session. Today not counting yet doesn't break the streak.
- **Topics table:** total time, sessions, last studied and level, sortable by any column. "Rust" and " rust " are the same topic.
- **Mastery levels:** Spark (0 h), Curious (1 h), Steady (5 h), Focused (20 h), Deep (50 h), Mastery (100 h).
- **Constellation:** each topic is a star on a night sky, bigger and brighter (with sparkles from level 4) as it levels up. Hover, focus or click a star for its total and the time to the next level. A completed session makes its star twinkle. Stars keep their place as new topics appear.
- **History**, newest first, 50 at a time, with a delete button per entry, **Clear history** (asks first) and **Export JSON**.
- Stopping early is never punished: stopped sessions still count towards totals and levels.

## What gets hidden during a session

- The **"Up next" / related sidebar** on watch pages, plus a backup rule that hides the suggestion cards themselves if YouTube renames the sidebar.
- The **suggestions inside the player**: the end screen grid, the cards that pop up during the video, and the autoplay "Up next" screen.
- The **home page feed**, replaced by the study grid.
- **Shorts**: `/shorts/<id>` opens as a normal `/watch?v=<id>` page, and the Shorts player is hidden while that happens.

## Study feed

- **On watch pages** it takes the sidebar's place as a list of videos on your topic. **On the home page** it fills the main area as a grid.
- **Infinite scroll:** it loads 50 videos per page as you scroll, with no duplicates and without the video you're watching. It stops after 10 pages per page view to save quota.
- **Cards** show the thumbnail, title, channel and how long ago the video was posted ("3 days ago").
- **It matches YouTube's light and dark themes.**
- **When the feed can't load**, it shows a plain-English error. For key problems it adds an **Open settings** button, and every error comes with a "Search YouTube for '<topic>' instead" link that needs no API.
- **If YouTube changes its layout**, the feed moves to the right-hand column, then to a floating panel, and logs a console warning. It doesn't just disappear.

## Autoplay

- **When a video ends, the next study video plays** instead of YouTube's pick. It cancels YouTube's "Up next" countdown and opens the first feed video you haven't watched in that tab.
- **It keeps track of what you've watched in each tab** (up to 200 videos), so autoplay doesn't bounce between the same two videos. The list resets when the session ends.
- **It respects your choices:** it does nothing if the player's autoplay switch is off, during ads, or in a playlist you picked. YouTube's auto-generated Mixes (`list=RD…`) are still taken over, since they count as recommendations.
- **Safety net:** if YouTube navigates by itself within 15 seconds of a video ending, with no click or key press from you, it's treated as autoplay and redirected. If there's no study video to go to, it goes back.

## API key, quota and cache

- **Settings page** with step-by-step setup for a free YouTube Data API v3 key, **Save** and **Test key** buttons, and specific messages for an invalid key, the API not being enabled, quota used up, or a network error.
- **Results are saved for 24 hours**, per topic and page, so repeating a topic costs no quota. Topics are matched regardless of capitalization. Old entries are cleared each time a session starts.
- **Clear saved results** button, which reports how many pages it removed.
- **Explains the quota:** about 100 searches a day, one per 50-video page, reset at midnight Pacific time.

## Privacy and safety

- The only extra site permission is `googleapis.com`. Nothing is sent anywhere else, and there's no account or server. Session history and goals stay in `chrome.storage.local`.
- Video titles are always inserted as plain text, never HTML.

## Gaps and expansion ideas

- **Only the home and watch pages get the study feed.** Search results, channel pages, Subscriptions and the left menu are left as they are during a session.
- **The feed is a keyword search ranked by relevance.** There are no filters (length, language, date, channel), and it's not "related to this video", because the API dropped that in 2023.
- **One topic at a time.** Stats are local to this Chrome profile; there's no sync between devices and no friends leaderboard (parked as phase 2 in the spec).
- **Nothing stops you from leaving.** You can stop anytime with no friction, and other sites aren't affected.
- **Editing the minutes restarts the timer** from "minutes left" rather than adjusting it (the time already studied is still counted in the log).
