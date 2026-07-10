// The follow loop: resolve the share token, backfill the trail already ridden,
// then stream live telemetry straight from the broker and drive the UI. This is
// the follower half of the RideFollow contract, re-spoken in JS — see
// lib/state/app_state.dart (followViaLink) for the app's version.

import mqtt from 'mqtt';

import { resolveRide, fetchHistory, fetchRoute } from './api.js';
import { decodePayload } from './telemetry.js';
import { Ui, compassLong, formatDuration } from './ui.js';

const OFFLINE_AFTER_S = 90; // no fresh reading for this long ⇒ rider went offline
const TICK_MS = 1000;
const CHECKPOINT_KM = 5; // emit an event log line every N km
const MAX_EVENTS = 200;

// Stable 4-digit session id from the ride token (display only).
function sessionId(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(h % 10000).padStart(4, '0');
}

// Great-circle distance (km) between two [lat,lng] points.
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function routeLengthKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineKm(points[i - 1], points[i]);
  return total;
}

function wallClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export async function follow({ token, apiBase, shareHost }, options = {}) {
  const name = (options.name || process.env.RIDEFOLLOW_NAME || 'Someone').trim() || 'Someone';
  const cheerEmoji = options.cheerEmoji || '📣';
  const insecure = Boolean(options.insecure);

  const ui = new Ui();

  const state = {
    riderName: '',
    rider: '',
    sessionId: sessionId(token),
    sample: null,
    anchor: null, // how we date the last reading — see ageSeconds()
    routeTotalKm: null,
    conn: 'connecting',
    canCheer: false,
    events: [],
    // derived / dedupe trackers
    motion: 'RIDING',
    prevDistance: null,
    prevElevation: null,
    loggedTop: 0,
    nextCheckpointKm: CHECKPOINT_KM,
    gpsAcquired: false,
    lastLoggedStatus: null,
  };

  const ageSeconds = () => {
    const a = state.anchor;
    if (!a) return null;
    if (a.type === 'baseline') return a.ageSec + (Date.now() - a.atMs) / 1000;
    return (Date.now() - a.ms) / 1000;
  };

  const stamp = () =>
    state.sample ? formatDuration(state.sample.elapsed) : wallClock();

  const pushEvent = (text, level = 'info') => {
    state.events.push({ stamp: stamp(), text, level });
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  };

  // Rider-facing status shown in the STATUS box.
  const statusOf = () => {
    const s = state.sample;
    if (s && s.finished) return { kind: 'done', label: 'RIDE COMPLETE' };
    const age = ageSeconds();
    if (age != null && age > OFFLINE_AFTER_S) return { kind: 'warn', label: 'OFFLINE' };
    if (s && s.paused) return { kind: 'warn', label: 'PAUSED' };
    if (s) return { kind: 'live', label: state.motion };
    if (state.conn === 'reconnecting') return { kind: 'warn', label: 'RECONNECTING' };
    return { kind: 'idle', label: 'CONNECTING' };
  };

  // Connection banner shown top-right ("LIVE FEED").
  const liveBanner = () => {
    const s = state.sample;
    if (s && s.finished) return { kind: 'idle', label: 'FEED ENDED' };
    const age = ageSeconds();
    if (state.conn === 'reconnecting') return { kind: 'warn', label: 'RECONNECTING' };
    if (age != null && age > OFFLINE_AFTER_S) return { kind: 'warn', label: 'SIGNAL LOST' };
    if (state.conn === 'live') return { kind: 'live', label: 'LIVE FEED' };
    return { kind: 'idle', label: 'CONNECTING' };
  };

  const etaSeconds = () => {
    const s = state.sample;
    if (!s || state.routeTotalKm == null || s.finished) return null;
    const remaining = Math.max(0, state.routeTotalKm - s.distance);
    const avgKmh = s.elapsed > 0 ? s.distance / (s.elapsed / 3600) : 0;
    if (avgKmh < 0.5) return null;
    return (remaining / avgKmh) * 3600;
  };

  const progressPct = () => {
    const s = state.sample;
    if (!s || !state.routeTotalKm) return null;
    return Math.max(0, Math.min(100, (s.distance / state.routeTotalKm) * 100));
  };

  const subheader = () => {
    const who = (state.riderName || state.rider || 'RIDER').toUpperCase();
    let sub = `TRACKING: ${who} · SESSION #${state.sessionId}`;
    if (state.routeTotalKm != null) sub += ` · ROUTE: ${Math.round(state.routeTotalKm)} KM`;
    return sub;
  };

  const snapshot = () => ({
    riderName: state.riderName || state.rider,
    subheader: subheader(),
    live: liveBanner(),
    status: statusOf(),
    heading: state.sample ? compassLong(state.sample.heading) : '—',
    sample: state.sample,
    etaSeconds: etaSeconds(),
    progressPct: progressPct(),
    routeTotalKm: state.routeTotalKm,
    distanceKm: state.sample ? state.sample.distance : null,
    events: state.events,
    ageSeconds: ageSeconds(),
  });

  // Log status changes as they happen (offline is age-based, so this runs each tick).
  const logTransitions = () => {
    const label = statusOf().label;
    if (label === state.lastLoggedStatus) return;
    const first = state.lastLoggedStatus === null;
    state.lastLoggedStatus = label;
    if (first || label === 'CONNECTING' || label === 'RECONNECTING') return;
    if (label === 'RIDE COMPLETE') pushEvent('RIDE COMPLETE', 'hi');
    else if (label === 'OFFLINE') pushEvent('RIDER OFFLINE — SIGNAL LOST', 'warn');
    else if (label === 'PAUSED') pushEvent('RIDER PAUSED', 'warn');
    else pushEvent(`STATUS · ${label}`, 'info');
  };

  const render = () => {
    logTransitions();
    ui.render(snapshot());
  };

  const applySample = (s, { live } = { live: true }) => {
    state.sample = s;
    if (s.name) state.riderName = s.name;

    if (live) {
      // Climb detection from cumulative elevation gain vs distance covered.
      if (state.prevDistance != null && Number.isFinite(s.distance)) {
        const dDist = s.distance - state.prevDistance; // km
        const dElev = s.elevation - state.prevElevation; // m gained
        if (dDist > 0.02) state.motion = dElev / (dDist * 1000) > 0.03 ? 'CLIMBING' : 'RIDING';
      }
      state.prevDistance = s.distance;
      state.prevElevation = s.elevation;

      // Event log: first fix, checkpoints, new top speed.
      if (!state.gpsAcquired && Number.isFinite(s.lat) && Number.isFinite(s.lng)) {
        state.gpsAcquired = true;
        pushEvent('GPS FIX ACQUIRED', 'info');
      }
      while (Number.isFinite(s.distance) && s.distance >= state.nextCheckpointKm) {
        pushEvent(`CHECKPOINT · ${state.nextCheckpointKm.toFixed(1)} KM`, 'info');
        state.nextCheckpointKm += CHECKPOINT_KM;
      }
      if (Number.isFinite(s.topSpeed) && s.topSpeed > state.loggedTop + 0.5 && state.loggedTop > 0) {
        pushEvent(`NEW TOP SPEED · ${s.topSpeed.toFixed(1)} KM/H`, 'info');
      }
      if (Number.isFinite(s.topSpeed)) state.loggedTop = Math.max(state.loggedTop, s.topSpeed);

      // Date the reading (freshness / offline detection): the sample's own capture
      // clock is best (survives replayed backfill); otherwise stamp now.
      state.anchor = s.capturedAtMs
        ? { type: 'captured', ms: s.capturedAtMs }
        : { type: 'local', ms: Date.now() };
    } else {
      // Backfill: keep trackers current without spamming the event log.
      if (Number.isFinite(s.distance)) {
        state.prevDistance = s.distance;
        state.prevElevation = s.elevation;
        while (s.distance >= state.nextCheckpointKm) state.nextCheckpointKm += CHECKPOINT_KM;
      }
      if (Number.isFinite(s.topSpeed)) state.loggedTop = Math.max(state.loggedTop, s.topSpeed);
      if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) state.gpsAcquired = true;
    }
  };

  // Lifecycle state, declared up front so quitting works even during the
  // initial resolve/backfill (before the broker client exists).
  let client = null;
  let ticker = null;
  let finished = false;
  let resolveDone;
  const done = new Promise((res) => {
    resolveDone = res;
  });

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (ticker) clearInterval(ticker);
    try {
      if (client) client.end(true);
    } catch {
      /* ignore */
    }
    ui.stop();
    resolveDone();
  };

  // Quit handlers first, so Ctrl-C exits cleanly even while we're still
  // resolving the token — before the dashboard (and its key handler) exist.
  const onSignal = () => cleanup();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // 1) Resolve the token → rider + read-only broker creds scoped to this ride.
  // Do this BEFORE opening the full-screen UI: an expired or invalid link then
  // fails with a plain one-line message, instead of flashing the dashboard open
  // and tearing it straight back down — which reads like a crash.
  let share;
  try {
    share = await resolveRide(apiBase, token);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (finished) {
    // User quit during the lookup.
    await done;
    return;
  }
  if (!share) {
    cleanup();
    throw new Error('this ride link has expired or is invalid — ask for a fresh one');
  }

  // Valid ride — bring up the dashboard now.
  ui.start();
  ui.onKey((action) => {
    if (action === 'quit') {
      cleanup();
    } else if (action === 'cheer') {
      if (state.canCheer && client && client.connected) {
        client.publish(share.cheersTopic, JSON.stringify({ from: name, emoji: cheerEmoji }), { qos: 0, retain: false });
        pushEvent(`CHEER SENT → ${(state.riderName || 'RIDER').toUpperCase()}`, 'hi');
      } else {
        pushEvent('CANNOT CHEER — NOT CONNECTED', 'warn');
      }
      render();
    }
  });
  state.rider = share.rider;
  state.riderName = share.rider;
  state.canCheer = Boolean(share.cheersTopic);
  render();

  // 2) Backfill the ride so far + the planned route (both best-effort).
  const [history, route] = await Promise.all([
    fetchHistory(apiBase, token),
    fetchRoute(apiBase, token),
  ]);
  if (route) {
    state.routeTotalKm =
      route.distanceKm && route.distanceKm > 0 ? route.distanceKm : routeLengthKm(route.points) || null;
  }
  for (const s of history.samples) applySample(s, { live: false });
  if (history.samples.length) {
    const newest = history.samples[history.samples.length - 1];
    if (newest.capturedAtMs) state.anchor = { type: 'captured', ms: newest.capturedAtMs };
    else if (history.latestAgeSeconds != null)
      state.anchor = { type: 'baseline', ageSec: history.latestAgeSeconds, atMs: Date.now() };
    else state.anchor = { type: 'local', ms: Date.now() };
    // Seed the transition tracker so we don't log the resumed-from state as "new".
    state.lastLoggedStatus = statusOf().label;
  }
  render();

  // 3) Stream live telemetry from the broker with the ride's reader account.
  // Always MQTT-over-TLS (8883). --insecure only skips cert verification, for a
  // dev broker with a self-signed cert; the certificate is still used.
  const url = `mqtts://${share.host}:${share.tcpPort}`;
  client = mqtt.connect(url, {
    username: share.username,
    password: share.password,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 20000,
    resubscribe: true,
    rejectUnauthorized: !insecure,
  });

  let wasConnected = false;
  client.on('connect', () => {
    state.conn = 'live';
    pushEvent(wasConnected ? 'LINK RE-ESTABLISHED' : 'LIVE FEED CONNECTED', 'info');
    wasConnected = true;
    client.subscribe(share.topic, { qos: 0 }, (err) => {
      if (err) pushEvent('SUBSCRIBE FAILED', 'warn');
    });
    render();
  });
  client.on('reconnect', () => {
    if (!finished && state.conn === 'live') pushEvent('SIGNAL LOST — RECONNECTING', 'warn');
    state.conn = 'reconnecting';
    render();
  });
  client.on('close', () => {
    if (!finished && state.conn === 'live') state.conn = 'reconnecting';
  });
  client.on('error', (err) => {
    // Auth failure means the ride ended and the account was revoked.
    const msg = String(err && err.message ? err.message : err);
    if (/not authoriz|bad user|connack|auth/i.test(msg)) {
      pushEvent('RIDE ENDED — LINK CLOSED', 'hi');
      render();
    }
  });
  client.on('message', (topic, payload) => {
    if (topic !== share.topic) return;
    const s = decodePayload(payload);
    if (!s) return;
    applySample(s, { live: true });
    render();
  });

  // Re-render every second so the clock advances and offline is detected even
  // when no new message arrives.
  ticker = setInterval(render, TICK_MS);
  if (typeof ticker.unref === 'function') ticker.unref();

  await done;
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
}
