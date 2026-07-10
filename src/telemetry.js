// One telemetry reading, decoded from the compact wire JSON a rider broadcasts.
// The keys must stay identical to lib/telemetry/telemetry_sample.dart and
// ios/RideFollowWatch (TelemetrySample.swift) — this is the shared contract.
//
//   t      elapsed seconds        dist  km            spd  km/h
//   elev   m gained               top   km/h          paused / finished  bool
//   lat/lng position              hdg   heading deg    name  rider name
//   ts     capture wall-clock (epoch ms) — dates the point in real time

/** @param {Record<string, any>} j */
export function decodeSample(j = {}) {
  return {
    elapsed: int(j.t),
    distance: float(j.dist),
    speed: float(j.spd),
    elevation: float(j.elev),
    topSpeed: float(j.top),
    paused: Boolean(j.paused),
    finished: Boolean(j.finished),
    lat: floatOrNull(j.lat),
    lng: floatOrNull(j.lng),
    heading: floatOrNull(j.hdg),
    name: typeof j.name === 'string' && j.name.trim() ? j.name.trim() : null,
    capturedAtMs: intOrNull(j.ts),
  };
}

/** Decode a raw MQTT payload (Buffer/string) into a sample, or null if garbage. */
export function decodePayload(raw) {
  try {
    const obj = JSON.parse(raw.toString('utf8'));
    if (obj && typeof obj === 'object') return decodeSample(obj);
  } catch {
    /* not JSON — ignore */
  }
  return null;
}

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const float = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const floatOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const intOrNull = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
