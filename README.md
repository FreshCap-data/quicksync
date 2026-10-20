# Unison

Play one YouTube track in sync on every device in a room.
Cloudflare Worker + Durable Objects (WebSockets) on the server, plain HTML/CSS/JS on the client, no build step.

## Run it

```bash
npm install
npm run dev        # http://localhost:8787
```

Open the page in two browser windows (or a laptop and a phone on the same Wi-Fi, using your computer's LAN IP),
join the same room code, paste a YouTube link, press play.

## Deploy (free plan)

```bash
npx wrangler login
npm run deploy     # gives you https://unison.<your-subdomain>.workers.dev
```

No config needed. The free plan works because `wrangler.toml` uses a SQLite-backed Durable Object (`new_sqlite_classes`).

## How the sync works

1. **Server is the clock.** Each room is one Durable Object. It stores `{ videoId, playing, position, updatedAt, version }`.
2. **Clock offset.** On connect, each device sends 10 pings, measures round-trip time, and keeps the offset from the
   lowest-latency sample. `serverNow = localNow + offset`. Refreshed every 15 s and when the tab becomes visible.
3. **Scheduled start.** Play and seek (while playing) are stamped `now + 1200 ms` on the server. Every device parks at the
   start position, then calls `playVideo()` at that server time on its own clock.
4. **Silent calibration.** When a video is loaded and nobody has pressed play yet, each device plays it *muted* for about
   two seconds. This fills the buffer (so the first real start is not a slow "cold" start) and measures how long this
   device takes to turn `playVideo()` into sound. The result is saved in `localStorage` and refined on every later start.
5. **Start and seek compensation.** Each device calls `playVideo()` (or `seekTo()`) early by its own measured delay, so
   sound begins at the scheduled moment on a slow phone and a fast laptop alike.
6. **Drift correction.** `getCurrentTime()` can report a position that is a few hundred ms old, which makes a device look
   further behind than it is. So each device samples every 60 ms and uses the *minimum* drift over the last 1.5 s.
   - Right after every start it re-checks at +1.8 s and +3.6 s with a tight limit (50 ms), and keeps re-checking after each
     correction (up to 4 extra times) until it converges.
   - Afterwards, a regular check once a second corrects drift above 100 ms (two checks in a row, 3 s cooldown).
7. **Late joiners** get the current state, jump to the right position, and go through the same settle checks.
8. **Resync this device** (button) re-measures the clock and re-applies the room state. Use it if one device sounds off.

The flashing yellow disc is a visual check: it pulses on every whole second of the shared server clock,
so devices that are in sync flash together.

## Files

| File | Purpose |
|---|---|
| `src/worker.js` | Worker (routes `/ws/<room>`) and the `Room` Durable Object |
| `public/index.html`, `style.css`, `app.js` | The site |
| `wrangler.toml` | Config: static assets, Durable Object binding, migration |

## Tuning

- `LEAD_MS` in `src/worker.js` (1200): raise if devices on slow networks start late.
- `DRIFT_LIMIT` (0.10 s) and `SETTLE_LIMIT` (0.05 s) in `public/app.js`: lower is tighter but causes more seeks
  (each seek can cause a small stutter). Going below about 0.04 s is not worthwhile, because a seek itself is only
  accurate to a few tens of ms.

## Known limits

- **Expect roughly 50 to 150 ms of difference** between devices with YouTube. The IFrame API gives no control over the audio clock, so this suits a
  listening party, not several speakers in one room (you would hear an echo). For tight sync, host audio files
  (for example on Cloudflare R2) and play them with the Web Audio API, which can schedule to the millisecond.
- **Mobile autoplay.** Browsers may block audio that was not started by a tap. When that happens the page shows a
  "Start audio" bar and makes the video tappable. iOS Safari is the strictest.
- **YouTube's player must stay visible**, so audio-only is not possible with the IFrame API.
- **Anyone with the room code can control playback.** Room codes are the only access control.
- Free-plan limits are generous for small rooms (WebSocket messages count at a 20:1 ratio against the request quota).
  Check Cloudflare's current limits if a room gets large.
