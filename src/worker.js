import { DurableObject } from "cloudflare:workers";

const EMPTY_STATE = {
  videoId: "",
  title: "",
  channel: "",
  playing: false,
  position: 0,
  startAt: 0,
  queue: [],
  revision: 0,
  updatedAt: Date.now()
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/room/")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("SyncWave WebSocket endpoint. Connect with a WebSocket client.", {
          status: 426,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }
      const room = decodeURIComponent(url.pathname.slice("/room/".length))
        .replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
      if (!room) return new Response("Room code required", { status: 400 });
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.state = { ...EMPTY_STATE, queue: [] };
  }

  async loadState() {
    const saved = await this.ctx.storage.get("state");
    if (saved) this.state = saved;
  }

  async fetch(request) {
    await this.loadState();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ joinedAt: Date.now() });
    server.send(JSON.stringify({ type: "state", state: this.state }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); }
    catch { ws.send(JSON.stringify({ type: "error", message: "Invalid message format." })); return; }

    await this.loadState();
    const now = Date.now();
    switch (msg.type) {
      case "hello":
      case "request-state":
        ws.send(JSON.stringify({ type: "state", state: this.state }));
        return;
      case "set-track": {
        if (typeof msg.videoId !== "string" || !/^[\w-]{11}$/.test(msg.videoId)) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid YouTube video ID." }));
          return;
        }
        this.state = {
          ...this.state,
          videoId: msg.videoId,
          title: clean(msg.title, 180),
          channel: clean(msg.channel, 120),
          playing: msg.playing !== false,
          position: 0,
          startAt: Number(msg.startAt) > now ? Math.min(Number(msg.startAt), now + 10000) : now + 1500,
          revision: (this.state.revision || 0) + 1,
          updatedAt: now
        };
        break;
      }
      case "playback": {
        if (msg.videoId && this.state.videoId && msg.videoId !== this.state.videoId) return;
        const pos = Number(msg.position);
        this.state = {
          ...this.state,
          playing: !!msg.playing,
          position: Number.isFinite(pos) ? Math.max(0, Math.min(pos, 86400)) : 0,
          startAt: msg.playing ? (Number(msg.startAt) > now ? Math.min(Number(msg.startAt), now + 10000) : now + 1200) : 0,
          revision: (this.state.revision || 0) + 1,
          updatedAt: now
        };
        break;
      }
      case "queue-add": {
        const t = msg.track || {};
        if (typeof t.videoId !== "string" || !/^[\w-]{11}$/.test(t.videoId)) return;
        const queue = [...(this.state.queue || []), {
          videoId: t.videoId, title: clean(t.title, 180), channel: clean(t.channel, 120)
        }].slice(0, 100);
        this.state = { ...this.state, queue, revision: (this.state.revision || 0) + 1, updatedAt: now };
        break;
      }
      case "queue-remove": {
        const index = Number(msg.index);
        if (!Number.isInteger(index) || index < 0 || index >= (this.state.queue || []).length) return;
        const queue = [...this.state.queue]; queue.splice(index, 1);
        this.state = { ...this.state, queue, revision: (this.state.revision || 0) + 1, updatedAt: now };
        break;
      }
      case "queue-clear":
        this.state = { ...this.state, queue: [], revision: (this.state.revision || 0) + 1, updatedAt: now };
        break;
      case "next":
      case "previous": {
        const queue = [...(this.state.queue || [])];
        if (!queue.length) return;
        const t = msg.type === "previous" ? queue.pop() : queue.shift();
        this.state = {
          ...this.state, queue, videoId: t.videoId, title: t.title, channel: t.channel,
          playing: true, position: 0, startAt: now + 1800,
          revision: (this.state.revision || 0) + 1, updatedAt: now
        };
        break;
      }
      default:
        ws.send(JSON.stringify({ type: "error", message: "Unknown command." }));
        return;
    }
    await this.ctx.storage.put("state", this.state);
    this.broadcast({ type: "state", state: this.state });
  }

  webSocketClose() {}
  webSocketError() {}

  broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch {}
    }
  }
}

function clean(value, max) {
  return String(value || "").replace(/[<>]/g, "").slice(0, max);
}
