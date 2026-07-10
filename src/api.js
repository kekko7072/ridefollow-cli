// Thin client for the RideFollow control-plane API — only the public,
// token-scoped endpoints a follower needs. The token is the capability, so
// none of these send credentials. Mirrors lib/telemetry/provisioning.dart.

import { decodeSample } from './telemetry.js';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function getJson(url, { timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('the server took too long to respond', 0);
    throw new ApiError(`could not reach the RideFollow server (${err.code || err.message})`, 0);
  } finally {
    clearTimeout(timer);
  }
  return res;
}

/**
 * GET /v1/ride/<token> → the rider + read-only broker account scoped to this
 * one ride. Returns null when the link has expired or is invalid (404).
 */
export async function resolveRide(apiBase, token) {
  const res = await getJson(`${apiBase}/v1/ride/${encodeURIComponent(token)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(await errorOf(res), res.status);
  const j = await res.json();
  const share = {
    rider: str(j.rider),
    host: str(j.host),
    tcpPort: num(j.tcpPort, 8883),
    wsPort: num(j.wsPort, 8084),
    username: str(j.username),
    password: str(j.password),
    topic: str(j.topic),
    cheersTopic: str(j.cheersTopic),
    soundTopic: str(j.soundTopic),
  };
  if (!share.rider || !share.username || !share.password) return null;
  if (!share.topic) share.topic = `riders/${share.rider}/telemetry`;
  if (!share.cheersTopic) share.cheersTopic = `riders/${share.rider}/cheers`;
  return share;
}

/**
 * GET /v1/ride/<token>/history → samples so far (oldest first) so we can draw
 * the trail already ridden, plus freshness so we can tell live from stale
 * before the first live sample lands. Non-fatal: returns empty on any failure.
 */
export async function fetchHistory(apiBase, token) {
  try {
    const res = await getJson(`${apiBase}/v1/ride/${encodeURIComponent(token)}/history`);
    if (!res.ok) return { samples: [], serverNowMs: null, latestAgeSeconds: null };
    const j = await res.json();
    return {
      samples: (Array.isArray(j.samples) ? j.samples : []).map(decodeSample),
      serverNowMs: numOrNull(j.serverNowMs),
      latestAgeSeconds: numOrNull(j.latestAgeSeconds),
    };
  } catch {
    return { samples: [], serverNowMs: null, latestAgeSeconds: null };
  }
}

/**
 * GET /v1/ride/<token>/route → the rider's planned route, or null. Used to draw
 * the intended line under the live trail. Non-fatal.
 */
export async function fetchRoute(apiBase, token) {
  try {
    const res = await getJson(`${apiBase}/v1/ride/${encodeURIComponent(token)}/route`);
    if (!res.ok) return null;
    const j = await res.json();
    const points = (Array.isArray(j.points) ? j.points : [])
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => [Number(p[0]), Number(p[1])]);
    if (points.length < 2) return null;
    return { points, distanceKm: numOrNull(j.distanceKm) };
  } catch {
    return null;
  }
}

async function errorOf(res) {
  try {
    const j = await res.json();
    return String(j.error || `request failed (${res.status})`);
  } catch {
    return `request failed (${res.status})`;
  }
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export { ApiError };
