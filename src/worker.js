import { DurableObject } from "cloudflare:workers";

// How far in the future (ms) a play/seek takes effect. Every device gets the
// message, converts this server timestamp to its own clock, and starts at the
// same moment. Raise it if devices on slow networks start late.
const LEAD_MS = 1200;

const MAX_MESSAGE_BYTES = 2048;
const MAX_POSITION_SECONDS = 24 * 60 * 60;
const VIDEO_ID = /^[\w-]{11}$/;
const ROOM_ID = /^[a-z0-9_-]{3,32}$/;

/* ------------------------------------------------------------------ */
/* Entry point: route /ws/<room> to that room's Durable Object         */
/* ------------------------------------------------------------------ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/ws/")) {
      // Only accept sockets opened from this site, so other sites
      // can't spend your free-tier quota.
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) {
        return new Response("Forbidden origin", { status: 403 });
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket connection", { status: 426 });
      }
      const room = decodeURIComponent(url.pathname.slice(4)).toLowerCase();
      if (!ROOM_ID.test(room)) {
        return new Response("Room codes use 3-32 letters, numbers, - or _", { status: 400 });
      }
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request);
    }

    // Fallback (assets are normally served without invoking the Worker).
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------ */
/* Room: the single source of truth for one listening room             */
/* ------------------------------------------------------------------ */
/*
  Room state (server clock, milliseconds since epoch):
    videoId    YouTube id, or null
    playing    boolean
    position   seconds into the track at the moment `updatedAt`
    updatedAt  server time at which `position` is true. When playing, this
               can be slightly in the future (the scheduled start).
    version    increments on every change

  Position at server time T:
    playing ? position + max(0, T - updatedAt) / 1000 : position
*/
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    // Load saved state before handling any message (also runs after hibernation).
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) ?? {
        videoId: null,
        playing: false,
        position: 0,
        updatedAt: Date.now(),
        version: 0,
      };
    });
  }

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernation API: the Durable Object can sleep between messages
    // without dropping sockets, so idle rooms cost nothing.
    this.ctx.acceptWebSocket(server);
    this.broadcastCount();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    const now = Date.now();
    const r = this.room;

    switch (msg.t) {
      // Clock sync: client sends its time, we add ours.
      case "ping":
        ws.send(JSON.stringify({ t: "pong", c: msg.c, s: now }));
        return;

      // A client asks for the current state (after clock sync or on return to the tab).
      case "hello":
        ws.send(JSON.stringify({ t: "state", state: r }));
        return;

      case "load": {
        const id = typeof msg.videoId === "string" && VIDEO_ID.test(msg.videoId) ? msg.videoId : null;
        if (!id) return;
        return this.commit({ videoId: id, playing: false, position: 0, updatedAt: now });
      }

      case "play":
        if (!r.videoId || r.playing) return;
        return this.commit({ playing: true, updatedAt: now + LEAD_MS });

      case "pause":
        if (!r.playing) return;
        return this.commit({ playing: false, position: this.positionAt(now), updatedAt: now });

      case "seek": {
        const p = Number(msg.position);
        if (!r.videoId || !Number.isFinite(p)) return;
        const position = Math.min(Math.max(p, 0), MAX_POSITION_SECONDS);
        return this.commit({ position, updatedAt: r.playing ? now + LEAD_MS : now });
      }

      // Every device reports the end of the track; only the first one
      // (matching the current version) takes effect.
      case "ended":
        if (msg.version === r.version && r.playing) {
          return this.commit({ playing: false, position: 0, updatedAt: now });
        }
        return;
    }
  }

  async webSocketClose(ws) {
    try {
      ws.close(1000, "bye");
    } catch {}
    this.broadcastCount();
  }

  async webSocketError() {
    this.broadcastCount();
  }

  /* ---------------- helpers ---------------- */

  positionAt(t) {
    const r = this.room;
    return r.playing ? r.position + Math.max(0, t - r.updatedAt) / 1000 : r.position;
  }

  async commit(patch) {
    this.room = { ...this.room, ...patch, version: this.room.version + 1 };
    await this.ctx.storage.put("room", this.room);
    this.broadcast({ t: "state", state: this.room });
  }

  openSockets() {
    return this.ctx.getWebSockets().filter((s) => s.readyState === 1);
  }

  broadcast(obj) {
    const text = JSON.stringify(obj);
    for (const s of this.openSockets()) {
      try {
        s.send(text);
      } catch {}
    }
  }

  broadcastCount() {
    this.broadcast({ t: "count", n: this.openSockets().length });
  }
}
