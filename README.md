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
2. **Clock offset.** On connect, each device sends 8 pings, measures round-trip time, and keeps the offset from the
   lowest-latency sample. `serverNow = localNow + offset`. Refreshed every 15 s and when the tab becomes visible.
3. **Scheduled start.** Play and seek (while playing) are stamped `now + 1200 ms` on the server. Every device parks at the
   start position, then calls `playVideo()` at that server time on its own clock.
4. **Start-lag learning.** Each device measures how long `playVideo()` takes to produce sound and starts that much
   earlier next time (saved in `localStorage`).
5. **Drift correction.** Once a second each device compares the expected position with the player's position. If it is more
   than 250 ms off, it seeks (with a 5 s cooldown).
6. **Late joiners** get the current state and jump to the right position.

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
- `DRIFT_LIMIT` in `public/app.js` (0.25 s): lower is tighter but causes more seeks (each seek can cause a small stutter).

## Known limits

- **Accuracy is roughly 100 to 300 ms** with YouTube. The IFrame API gives no control over the audio clock, so this suits a
  listening party, not several speakers in one room (you would hear an echo). For tight sync, host audio files
  (for example on Cloudflare R2) and play them with the Web Audio API, which can schedule to the millisecond.
- **Mobile autoplay.** Browsers may block audio that was not started by a tap. When that happens the page shows a
  "Start audio" bar and makes the video tappable. iOS Safari is the strictest.
- **YouTube's player must stay visible**, so audio-only is not possible with the IFrame API.
- **Anyone with the room code can control playback.** Room codes are the only access control.
- Free-plan limits are generous for small rooms (WebSocket messages count at a 20:1 ratio against the request quota).
  Check Cloudflare's current limits if a room gets large.
