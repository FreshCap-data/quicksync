(() => {
  "use strict";

  /* ================================================================
     Tunables
     ================================================================ */
  const DRIFT_LIMIT = 0.25;          // seconds of drift before we seek to correct
  const CORRECTION_COOLDOWN = 5000;  // ms to wait after a correction or start
  const PING_BURST = 8;              // pings sent on connect to measure the clock offset
  const PING_EVERY = 15000;          // ms between background clock refreshes

  /* ================================================================
     Helpers
     ================================================================ */
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  // High-resolution wall clock in ms.
  const nowMs = () => performance.timeOrigin + performance.now();
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const cleanRoom = (v) => (v || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  const randomRoom = () => {
    const chars = "abcdefghjkmnpqrstuvwxyz23456789";
    return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  };
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function parseYouTubeId(text) {
    const ok = (id) => (id && /^[\w-]{11}$/.test(id) ? id : null);
    text = (text || "").trim();
    if (ok(text)) return text;
    try {
      const u = new URL(text.includes("://") ? text : "https://" + text);
      const host = u.hostname.replace(/^(www|m|music)\./, "");
      if (host === "youtu.be") return ok(u.pathname.slice(1).split("/")[0]);
      if (host === "youtube.com" || host === "youtube-nocookie.com") {
        if (u.searchParams.get("v")) return ok(u.searchParams.get("v"));
        const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
        if (m) return m[1];
      }
    } catch {}
    return null;
  }

  /* ================================================================
     State
     ================================================================ */
  let ws = null, room = null, wantOpen = false, retry = 0, pingTimer = null;

  // Clock sync: serverNow() = local clock + offset
  let offset = 0, bestRtt = Infinity, samples = [], synced = false;

  let state = null;       // authoritative room state from the server
  let listeners = 0;

  // Player
  let player = null, playerReady = false, loadedId = null;
  let startTimer = null, awaitingPlay = null, lastCorrection = 0, drift = 0;
  let startLag = parseFloat(store.get("unison.startLag")) || 0.15; // seconds between playVideo() and sound
  let scrubbing = false;

  const serverNow = () => nowMs() + offset;
  const expectedPos = (t) => {
    if (!state) return 0;
    return state.playing ? state.position + Math.max(0, t - state.updatedAt) / 1000 : state.position;
  };

  /* ================================================================
     Elements
     ================================================================ */
  const joinSec = $("#join"), roomSec = $("#room");
  const roomInput = $("#room-input"), roomCode = $("#room-code");
  const statusEl = $("#status"), beat = $("#beat");
  const stage = $("#stage"), emptyEl = $("#empty"), nowEl = $("#now-playing");
  const linkInput = $("#link-input"), linkError = $("#link-error");
  const playBtn = $("#play"), seek = $("#seek"), tPos = $("#t-pos"), tDur = $("#t-dur");
  const vol = $("#vol"), blocked = $("#blocked");

  /* ================================================================
     Join / leave
     ================================================================ */
  roomInput.value = cleanRoom(new URLSearchParams(location.search).get("room")) || randomRoom();

  $("#join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = cleanRoom(roomInput.value);
    if (code.length < 3) { roomInput.focus(); return; }
    joinRoom(code);
  });

  function joinRoom(code) {
    room = code;
    wantOpen = true;
    roomCode.textContent = code;
    document.title = `${code} · Unison`;
    history.replaceState(null, "", `?room=${code}`);
    joinSec.hidden = true;
    roomSec.hidden = false;
    renderControls();
    connect();
  }

  $("#leave").addEventListener("click", () => {
    wantOpen = false;
    clearInterval(pingTimer);
    clearTimeout(startTimer);
    if (ws) ws.close();
    if (playerReady) { try { player.stopVideo(); } catch {} }
    state = null; loadedId = null; synced = false; listeners = 0;
    hideBlocked();
    history.replaceState(null, "", location.pathname);
    document.title = "Unison";
    roomSec.hidden = true;
    joinSec.hidden = false;
  });

  $("#copy-link").addEventListener("click", async (e) => {
    const url = `${location.origin}/?room=${room}`;
    try {
      await navigator.clipboard.writeText(url);
      e.target.textContent = "Copied";
      setTimeout(() => (e.target.textContent = "Copy invite link"), 1500);
    } catch {
      prompt("Copy this link:", url);
    }
  });

  /* ================================================================
     WebSocket + clock sync
     ================================================================ */
  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function connect() {
    renderStatus();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = (ws = new WebSocket(`${proto}://${location.host}/ws/${room}`));

    sock.onopen = () => {
      retry = 0;
      startClockSync();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ t: "ping", c: nowMs() }), PING_EVERY);
    };
    sock.onmessage = onMessage;
    sock.onclose = () => {
      if (sock !== ws) return;
      synced = false;
      clearInterval(pingTimer);
      renderStatus();
      if (wantOpen) setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    };
  }

  function startClockSync() {
    samples = [];
    synced = false;
    let n = 0;
    const tick = () => {
      if (n++ >= PING_BURST || !ws || ws.readyState !== 1) return;
      send({ t: "ping", c: nowMs() });
      setTimeout(tick, 100);
    };
    tick();
  }

  function onPong(m) {
    const t1 = nowMs();
    const rtt = t1 - m.c;
    if (rtt < 0) return;
    // Assume the reply took half the round trip.
    samples.push({ rtt, off: m.s - (m.c + rtt / 2) });
    if (samples.length > 16) samples.shift();
    // The lowest-latency sample is the most trustworthy.
    const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    offset = best.off;
    bestRtt = best.rtt;
    if (!synced && samples.length >= PING_BURST) {
      synced = true;
      send({ t: "hello" }); // now that our clock is aligned, ask for the room state
    }
    renderStatus();
  }

  function onMessage(e) {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "pong") return onPong(m);
    if (m.t === "count") { listeners = m.n; renderStatus(); return; }
    if (m.t === "state" && synced) applyState(m.state);
  }

  // Phones freeze timers in the background; re-align when the tab returns.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wantOpen && ws && ws.readyState === 1) {
      startClockSync();
    }
  });

  /* ================================================================
     Player (YouTube IFrame API)
     ================================================================ */
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);

  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player("player", {
      playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0, fs: 0, iv_load_policy: 3, modestbranding: 1 },
      events: {
        onReady: () => {
          playerReady = true;
          player.setVolume(Number(vol.value));
          if (state) applyState(state);
        },
        onStateChange: onPlayerState,
      },
    });
  };

  function onPlayerState(e) {
    const ps = e.data; // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    if (ps === 1) {
      hideBlocked();
      // Learn how long this device takes to go from playVideo() to sound.
      if (awaitingPlay !== null) {
        const lag = (serverNow() - awaitingPlay) / 1000;
        if (lag >= 0 && lag < 1) {
          startLag = 0.6 * startLag + 0.4 * lag;
          store.set("unison.startLag", String(startLag));
        }
        awaitingPlay = null;
      }
    }
    if (ps === 0 && state && state.playing) send({ t: "ended", version: state.version });
  }

  // Make this device match the room state.
  function applyState(s) {
    state = s;
    renderControls();
    if (!playerReady) return;
    clearTimeout(startTimer);
    awaitingPlay = null;
    if (!s.videoId) return;

    const now = serverNow();
    const fresh = s.videoId !== loadedId;
    loadedId = s.videoId;

    if (s.playing) {
      const wait = s.updatedAt - now;
      if (wait > 0) {
        // Scheduled start: park at the start position, then play at the agreed moment.
        if (fresh) player.loadVideoById({ videoId: s.videoId, startSeconds: s.position });
        else player.seekTo(s.position, true);
        player.pauseVideo();
        startTimer = setTimeout(startNow, Math.max(0, wait - startLag * 1000));
      } else {
        // Already running (late join, or returning to the tab): jump to where it should be.
        const pos = expectedPos(now) + startLag;
        if (fresh) player.loadVideoById({ videoId: s.videoId, startSeconds: pos });
        else { player.seekTo(pos, true); player.playVideo(); }
        lastCorrection = performance.now();
      }
    } else {
      if (fresh) player.cueVideoById({ videoId: s.videoId, startSeconds: s.position });
      else { player.seekTo(s.position, true); player.pauseVideo(); }
    }
  }

  function startNow() {
    awaitingPlay = serverNow();
    player.playVideo();
    lastCorrection = performance.now();
  }

  // Drift check once a second.
  setInterval(() => {
    if (!playerReady || !state || !state.videoId || !synced) return;
    drift = 0;
    if (!state.playing) { renderStatus(); return; }
    const now = serverNow();
    if (now < state.updatedAt) return; // waiting for the scheduled start
    const ps = player.getPlayerState();
    if (ps === 3 || ps === 0) return;  // buffering or finished
    if (ps !== 1) {
      if (now - state.updatedAt > 1500) showBlocked();
      return;
    }
    const target = expectedPos(now);
    drift = target - player.getCurrentTime(); // positive = this device is behind
    if (Math.abs(drift) > DRIFT_LIMIT && performance.now() - lastCorrection > CORRECTION_COOLDOWN) {
      player.seekTo(target + startLag, true);
      lastCorrection = performance.now();
    }
    renderStatus();
  }, 1000);

  /* ---------- audio blocked fallback ---------- */
  function showBlocked() { blocked.hidden = false; stage.classList.add("tappable"); }
  function hideBlocked() { blocked.hidden = true; stage.classList.remove("tappable"); }
  $("#unblock").addEventListener("click", () => { if (state) applyState(state); });

  /* ================================================================
     Controls
     ================================================================ */
  $("#load-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = parseYouTubeId(linkInput.value);
    if (!id) {
      linkError.textContent = "That doesn't look like a YouTube link. Paste the full link from the Share button.";
      return;
    }
    linkError.textContent = "";
    linkInput.value = "";
    send({ t: "load", videoId: id });
  });

  playBtn.addEventListener("click", () => {
    if (!state || !state.videoId) return;
    send({ t: state.playing ? "pause" : "play" });
  });

  seek.addEventListener("input", () => {
    scrubbing = true;
    const dur = playerReady ? player.getDuration() : 0;
    tPos.textContent = fmt((seek.value / 1000) * dur);
  });
  seek.addEventListener("change", () => {
    const dur = playerReady ? player.getDuration() : 0;
    if (dur) send({ t: "seek", position: Math.min((seek.value / 1000) * dur, Math.max(0, dur - 0.5)) });
    setTimeout(() => (scrubbing = false), 600);
  });

  vol.value = store.get("unison.volume") ?? "100";
  vol.addEventListener("input", () => {
    store.set("unison.volume", vol.value);
    if (playerReady) player.setVolume(Number(vol.value));
  });

  /* ================================================================
     Rendering
     ================================================================ */
  function renderControls() {
    const has = !!(state && state.videoId);
    playBtn.disabled = !has;
    seek.disabled = !has;
    emptyEl.hidden = has;
    const playing = !!(state && state.playing);
    playBtn.dataset.playing = String(playing);
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  function renderStatus() {
    if (!ws || ws.readyState !== 1) {
      statusEl.textContent = wantOpen && retry > 0 ? "Connection lost. Reconnecting…" : "Connecting…";
      return;
    }
    if (!synced) { statusEl.textContent = "Syncing clocks…"; return; }
    const people = `${listeners} ${listeners === 1 ? "device" : "devices"} in this room`;
    const clock = `clock accurate to about ${Math.max(1, Math.round(bestRtt / 2))} ms`;
    const d = state && state.playing && drift ? `, ${Math.round(Math.abs(drift) * 1000)} ms ${drift > 0 ? "behind" : "ahead"} of the room` : "";
    statusEl.textContent = `${people}. Synced: ${clock}${d}.`;
  }

  // Position / duration / title, four times a second.
  setInterval(() => {
    if (!playerReady || !state || !state.videoId) { nowEl.textContent = ""; return; }
    const dur = player.getDuration ? player.getDuration() : 0;
    let pos = expectedPos(serverNow());
    if (dur) pos = Math.min(pos, dur);
    if (!scrubbing) {
      tPos.textContent = fmt(pos);
      if (dur) seek.value = Math.round((pos / dur) * 1000);
    }
    tDur.textContent = fmt(dur);
    const data = player.getVideoData ? player.getVideoData() : null;
    nowEl.textContent = (data && data.title) || "";
  }, 250);

  // The beat: flashes on every whole second of the shared server clock.
  // When devices are in sync, they flash together.
  (function frame() {
    let k = 0;
    if (synced) {
      k = reduceMotion ? 1 : Math.exp(-((serverNow() % 1000) / 1000) * 7);
    }
    beat.style.setProperty("--k", k.toFixed(3));
    requestAnimationFrame(frame);
  })();
})();
