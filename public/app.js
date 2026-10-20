(() => {
  "use strict";

  /* ================================================================
     Tunables
     ================================================================ */
  const DRIFT_LIMIT = 0.10;          // seconds of drift before the regular check corrects it
  const SETTLE_LIMIT = 0.05;         // tighter limit for the checks right after a start
  const SETTLE_AT = [1800, 3600];    // ms after a start when we re-check without waiting for a cooldown
  const SETTLE_RETRIES = 4;          // extra re-checks allowed after a settle correction
  const CORRECTION_COOLDOWN = 3000;  // ms between regular corrections
  const SAMPLE_EVERY = 60;           // ms between drift samples
  const SAMPLE_WINDOW = 1500;        // ms of samples kept for the drift estimate
  const MIN_SAMPLES = 10;            // samples needed before trusting the estimate
  const PING_BURST = 10;             // pings sent on connect to measure the clock offset
  const PING_EVERY = 15000;          // ms between background clock refreshes
  const CAL_TIMEOUT = 9000;          // ms before silent calibration gives up

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
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
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
  let startTimer = null, lastCorrection = 0, drift = 0;
  let awaiting = null;    // {kind: "start" | "seek", at}: a play or seek whose delay we are measuring
  let samplesD = [], overCount = 0, settleTimers = [], settleBudget = 0;
  let cal = null, calDelay = null; // silent calibration state
  // How long this device takes to turn playVideo() / seekTo() into sound (seconds). Learned and saved.
  let lagKnown = store.get("unison.startLag") !== null;
  let startLag = num(store.get("unison.startLag"), 0.15);
  let seekLag = num(store.get("unison.seekLag"), 0.25);
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
    cancelCalibration();
    clearSettle();
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

  // Send a quick series of pings to refine the clock offset.
  function burst() {
    let n = 0;
    const tick = () => {
      if (n++ >= PING_BURST || !ws || ws.readyState !== 1) return;
      send({ t: "ping", c: nowMs() });
      setTimeout(tick, 80);
    };
    tick();
  }

  // Full restart of clock sync; the room state is requested once it completes.
  function startClockSync() {
    samples = [];
    synced = false;
    burst();
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

  // Phones freeze timers in the background; refresh the clock when the tab returns.
  // (The drift check then fixes the position, or shows the "Start audio" bar if the OS paused us.)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wantOpen && ws && ws.readyState === 1) {
      burst();
      setTimeout(() => checkDrift(true), 1500);
    }
  });

  // Manual "Resync this device": re-measure the clock and re-apply the room state.
  $("#resync").addEventListener("click", () => {
    if (!ws || ws.readyState !== 1) return;
    synced = false;   // keeps the samples; the first pong marks us synced and requests the state
    burst();
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
      if (cal) { calOnPlaying(); return; }
      hideBlocked();
      // Learn how long this device takes to go from playVideo() / seekTo() to sound.
      if (awaiting && nowMs() - awaiting.at < 2000) {
        const lag = (nowMs() - awaiting.at) / 1000;
        if (lag >= 0.02 && lag < 1.2) {
          if (awaiting.kind === "start") {
            startLag = 0.6 * startLag + 0.4 * lag;
            store.set("unison.startLag", String(startLag));
          } else {
            seekLag = 0.4 * seekLag + 0.6 * lag;
            store.set("unison.seekLag", String(seekLag));
          }
        }
      }
      awaiting = null;
    }
    if (ps === 0 && state && state.playing) send({ t: "ended", version: state.version });
  }

  // Make this device match the room state.
  function applyState(s) {
    state = s;
    renderControls();
    if (!playerReady) return;
    cancelCalibration();
    clearTimeout(startTimer);
    clearSettle();
    awaiting = null;
    samplesD = [];
    overCount = 0;
    drift = 0;
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
        if (fresh) {
          player.loadVideoById({ videoId: s.videoId, startSeconds: expectedPos(now) + startLag });
        } else {
          awaiting = { kind: "seek", at: nowMs() };
          player.seekTo(expectedPos(now) + seekLag, true);
          player.playVideo();
        }
        lastCorrection = performance.now();
        scheduleSettle([2500, 4500]);
      }
    } else if (fresh) {
      player.cueVideoById({ videoId: s.videoId, startSeconds: s.position });
      // Once the video is cued, warm it up silently and measure this device's start delay.
      calDelay = setTimeout(startCalibration, 500);
    } else {
      player.seekTo(s.position, true);
      player.pauseVideo();
    }
  }

  function startNow() {
    awaiting = { kind: "start", at: nowMs() };
    samplesD = [];
    overCount = 0;
    player.playVideo();
    lastCorrection = performance.now();
    scheduleSettle(SETTLE_AT);
  }

  /* ---------- silent calibration ----------
     After a video is loaded (and before anyone presses play), each device plays it
     muted for a moment. That (1) fills the buffer, so the first real start is not a
     slow "cold" start, and (2) measures how long this device takes to start from a
     paused, buffered state, so the first scheduled start is already compensated.   */
  function startCalibration() {
    calDelay = null;
    if (!playerReady || !state || state.playing || state.videoId !== loadedId) return;
    cancelCalibration();
    cal = { step: 0, armed: true, t0: nowMs(), samples: [], timer: null, guard: null };
    cal.guard = setTimeout(() => finishCalibration(false), CAL_TIMEOUT);
    player.mute();
    player.playVideo(); // step 0: cold start, only to fill the buffer
  }

  function calKick() {
    if (!cal) return;
    cal.armed = true;
    cal.t0 = nowMs();
    player.playVideo();
  }

  function calOnPlaying() {
    const c = cal;
    if (!c || !c.armed) return;   // ignore extra PLAYING events (e.g. resuming after buffering)
    c.armed = false;
    if (c.step > 0) c.samples.push((nowMs() - c.t0) / 1000);
    c.step++;
    player.pauseVideo();
    if (c.samples.length >= 2) finishCalibration(true);
    else c.timer = setTimeout(calKick, 350);
  }

  function finishCalibration(ok) {
    const c = cal;
    if (!c) return;
    clearTimeout(c.timer);
    clearTimeout(c.guard);
    cal = null;
    if (ok && c.samples.length) {
      const avg = c.samples.reduce((a, b) => a + b, 0) / c.samples.length;
      if (avg > 0.02 && avg < 1.2) {
        startLag = lagKnown ? 0.5 * startLag + 0.5 * avg : avg;
        lagKnown = true;
        store.set("unison.startLag", String(startLag));
      }
    }
    try {
      player.pauseVideo();
      player.seekTo(state ? state.position : 0, true);
      player.unMute();
    } catch {}
    renderStatus();
  }

  // Stop calibrating because the room state changed; the new state is applied right after.
  function cancelCalibration() {
    clearTimeout(calDelay);
    calDelay = null;
    if (!cal) return;
    clearTimeout(cal.timer);
    clearTimeout(cal.guard);
    cal = null;
    try { player.unMute(); } catch {}
  }

  /* ---------- drift measurement and correction ----------
     player.getCurrentTime() can lag behind the real position by a few hundred ms,
     which always makes a device look *further behind* than it is. The freshest reading
     is the one with the smallest apparent drift, so we use the minimum over the last
     ~1.2 s of samples instead of a single reading.                                  */
  setInterval(() => {
    if (!playerReady || !state || !state.playing || !synced || cal) return;
    const now = serverNow();
    if (now < state.updatedAt || player.getPlayerState() !== 1) return;
    const t = performance.now();
    samplesD.push({ t, d: expectedPos(now) - player.getCurrentTime() });
    while (samplesD.length && t - samplesD[0].t > SAMPLE_WINDOW) samplesD.shift();
  }, SAMPLE_EVERY);

  const measuredDrift = () =>
    samplesD.length < MIN_SAMPLES ? null : Math.min(...samplesD.map((x) => x.d));

  function scheduleSettle(list) {
    clearSettle();
    settleBudget = SETTLE_RETRIES;
    settleTimers = list.map((ms) => setTimeout(() => checkDrift(true), ms));
  }
  // After a correction (or when there are too few samples), look again soon.
  function recheckSoon(ms) {
    if (settleBudget-- > 0) settleTimers.push(setTimeout(() => checkDrift(true), ms));
  }
  function clearSettle() {
    settleTimers.forEach(clearTimeout);
    settleTimers = [];
  }

  // settle = true: a check just after a start; uses a tighter limit and ignores the cooldown.
  function checkDrift(settle) {
    if (!playerReady || !state || !state.videoId || !synced || cal) return;
    if (!state.playing) { drift = 0; return; }
    const now = serverNow();
    if (now < state.updatedAt) return; // waiting for the scheduled start
    const ps = player.getPlayerState();
    if (ps === 3 || ps === 0) return;  // buffering or finished
    if (ps !== 1) {
      if (now - state.updatedAt > 1500) showBlocked();
      return;
    }
    const d = measuredDrift();
    if (d === null) { if (settle) recheckSoon(500); return; }
    drift = d; // positive = this device is behind the room
    if (Math.abs(d) <= (settle ? SETTLE_LIMIT : DRIFT_LIMIT)) { overCount = 0; return; }
    if (!settle) {
      if (++overCount < 2) return; // two checks in a row, to avoid reacting to noise
      if (performance.now() - lastCorrection < CORRECTION_COOLDOWN) return;
    }
    awaiting = { kind: "seek", at: nowMs() };
    player.seekTo(expectedPos(now) + seekLag, true);
    lastCorrection = performance.now();
    samplesD = [];
    overCount = 0;
    if (settle) recheckSoon(1800);
  }

  setInterval(() => {
    if (!playerReady) return;
    // Safety: never leave this device muted by accident.
    if (!cal && player.isMuted && player.isMuted()) player.unMute();
    checkDrift(false);
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
    const lag = `this device starts audio ${Math.round(startLag * 1000)} ms after play`;
    statusEl.textContent = `${people}. Synced: ${clock}${d}. ${cal ? "Calibrating this device…" : lag[0].toUpperCase() + lag.slice(1) + "."}`;
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
