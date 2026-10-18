# SyncWave — YouTube + WebSockets

A starter web app for synchronized YouTube playback across devices. It uses:
- YouTube Data API v3 for search (optional; direct YouTube URLs/video IDs also work)
- YouTube IFrame Player API for playback
- Cloudflare Worker + Durable Objects WebSockets for shared room state
- Cloudflare static assets for hosting

## Important limitations
- YouTube is played through the official embedded player; this app does not extract audio.
- Browsers, especially mobile Safari, may block remote autoplay until the user taps **Enable playback** on each device.
- This is best-effort synchronization, not sample-accurate multi-room audio. Network and YouTube buffering cause timing differences.
- Keep the embedded YouTube player visible and comply with YouTube API policies.
- This starter has no authentication or room permissions. Anyone who knows a room code can control that room. Don't use it for private rooms without adding access control.

## Deploy to Cloudflare Workers

1. Install Node.js LTS.
2. Extract this folder and run:
   ```bash
   npm create cloudflare@latest -- syncwave-youtube
   ```
   Alternatively, in this folder install Wrangler:
   ```bash
   npm install --save-dev wrangler
   ```
3. Ensure `package.json` includes:
   ```json
   { "private": true, "scripts": { "dev": "wrangler dev", "deploy": "wrangler deploy" }, "devDependencies": { "wrangler": "^4.0.0" } }
   ```
4. Run:
   ```bash
   npx wrangler login
   npx wrangler deploy
   ```
   Wrangler creates/deploys the Durable Object migration and static assets. If it asks for billing or account setup, follow the current Cloudflare dashboard prompts.
5. Open the deployed Worker URL. Create a room and share the link with other devices.

For local development:
```bash
npm install
npm run dev
```

## Enable YouTube search (optional)

1. Open Google Cloud Console: https://console.cloud.google.com/
2. Create/select a project and enable **YouTube Data API v3**.
3. Create an API key.
4. Restrict the key to YouTube Data API v3 and HTTP referrers for your deployed domain.
5. Paste it into the app's YouTube Data API key field. It is stored in sessionStorage for the current browser session only.

If you don't set a key, paste a YouTube video URL or 11-character video ID into the search box and add/play it.

## Deploying to Cloudflare Pages
This project uses a Durable Object Worker, so deploy it as a Cloudflare Worker with static assets as configured in `wrangler.jsonc`, rather than uploading only the HTML to Pages. A Pages-only static deployment cannot run this WebSocket server.

## Files
- `public/index.html` — UI and browser client
- `src/worker.js` — Worker routing and Durable Object WebSocket room
- `wrangler.jsonc` — Durable Object and static asset configuration
