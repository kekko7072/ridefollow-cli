// Unit + integration checks for the RideFollow terminal client. Pure Node — no
// broker needed (the live MQTT path is covered manually against a real broker).
// Run with: npm test
import http from 'node:http';
import assert from 'node:assert';

import { parseTarget, deriveApiBase } from '../src/link.js';
import { decodePayload, decodeSample } from '../src/telemetry.js';
import { Ui, formatDuration, formatAge, compass, compassLong, renderBig, bigWidth } from '../src/ui.js';
import { resolveRide, fetchHistory, fetchRoute } from '../src/api.js';

let pass = 0;
const ok = (name) => {
  pass++;
  console.log('  ✓', name);
};
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI, '');
const stripAll = (s) => strip(s).replace(/\x1b\[[0-9]*[A-Za-z]/g, '');

console.log('link parsing');
{
  const a = parseTarget('https://ridefollow.live/?ride=abcDEF123456_-xyz');
  assert.equal(a.token, 'abcDEF123456_-xyz');
  assert.equal(a.apiBase, 'https://api.ridefollow.live:8443');
  assert.equal(a.shareHost, 'ridefollow.live');
  ok('full https share link');

  assert.equal(parseTarget('ridefollow.live/?ride=abcDEF123456_-xyz').apiBase, 'https://api.ridefollow.live:8443');
  ok('bare host + query (no scheme)');

  assert.equal(parseTarget('abcDEF123456_-xyz').token, 'abcDEF123456_-xyz');
  ok('bare token');

  assert.equal(parseTarget('"https://ridefollow.live/?ride=abcDEF123456_-xyz"').token, 'abcDEF123456_-xyz');
  ok('strips surrounding quotes');

  assert.equal(parseTarget('http://localhost/?ride=abcDEF123456_-xyz').apiBase, 'http://localhost:8443');
  ok('localhost -> http api');

  assert.equal(
    parseTarget('https://ridefollow.live/?ride=abcDEF123456_-xyz', { apiOverride: 'my.host:9000' }).apiBase,
    'https://my.host:9000',
  );
  ok('--api override wins');

  assert.equal(deriveApiBase('api.ridefollow.live'), 'https://api.ridefollow.live:8443');
  ok('api-prefixed host not double-prefixed');

  for (const bad of ['', 'https://ridefollow.live/', 'not a token!!', 'https://x.com/?ride=short']) {
    assert.throws(() => parseTarget(bad), `should reject: ${bad}`);
  }
  ok('rejects empty / missing / malformed tokens');
}

console.log('telemetry decode');
{
  const wire = { t: 3725, dist: 42.15, spd: 28.4, elev: 340.6, top: 51.2, paused: false, finished: false, lat: 45.07, lng: 7.68, hdg: 45, name: 'Ada', ts: 1_700_000_000_000 };
  const s = decodePayload(Buffer.from(JSON.stringify(wire)));
  assert.equal(s.elapsed, 3725);
  assert.equal(s.distance, 42.15);
  assert.equal(s.name, 'Ada');
  assert.equal(s.capturedAtMs, 1_700_000_000_000);
  ok('decodes the wire keys (t/dist/spd/elev/top/lat/lng/hdg/name/ts)');

  assert.equal(decodePayload(Buffer.from('not json')), null);
  ok('garbage payload -> null');

  const empty = decodeSample({});
  assert.equal(empty.elapsed, 0);
  assert.equal(empty.lat, null);
  ok('missing fields default safely');
}

console.log('formatting');
{
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatAge(2), 'just now');
  assert.equal(formatAge(45), '45s ago');
  assert.equal(formatAge(120), '2m ago');
  assert.equal(compass(45), 'NE');
  assert.equal(compass(0), 'N');
  assert.equal(compass(null), '—');
  assert.equal(compassLong(45), 'NORTH-EAST');
  assert.equal(compassLong(180), 'SOUTH');
  ok('duration / age / compass');
}

console.log('seven-segment digits');
{
  const rows = renderBig('35:00');
  assert.equal(rows.length, 3, 'three rows tall');
  assert.ok(rows.every((r) => r.length === rows[0].length), 'rows equal width');
  assert.ok(bigWidth('35:00') > bigWidth('35:00', true), 'compact is narrower than spaced');
  assert.ok(strip(rows.join('')).includes('_') && strip(rows.join('')).includes('|'), 'uses LCD strokes');
  ok('renderBig produces aligned 3-row glyphs');
}

const liveSnap = () => ({
  riderName: 'Ada Lovelace',
  subheader: 'TRACKING: ADA LOVELACE · SESSION #0417 · ROUTE: 42 KM',
  live: { kind: 'live', label: 'LIVE FEED' },
  status: { kind: 'live', label: 'CLIMBING' },
  heading: 'NORTH-EAST',
  sample: { elapsed: 2100, distance: 15.4, speed: 24.3, elevation: 340, topSpeed: 51.2, heading: 45, paused: false, finished: false, lat: 45.02, lng: 7.63 },
  etaSeconds: 65,
  progressPct: 37,
  routeTotalKm: 42,
  distanceKm: 15.4,
  events: [
    { stamp: '30:24', text: 'GPS FIX ACQUIRED', level: 'info' },
    { stamp: '33:36', text: 'CHECKPOINT · 15.0 KM', level: 'info' },
    { stamp: '34:24', text: 'CHEER SENT → ADA', level: 'hi' },
    { stamp: '35:00', text: 'SIGNAL LOST — RECONNECTING', level: 'warn' },
  ],
  ageSeconds: 2,
});

console.log('UI frame rendering');
{
  const out = [];
  const fakeTty = { isTTY: true, columns: 100, rows: 32, write: (s) => out.push(s), on() {}, removeListener() {} };
  const ui = new Ui({ stream: fakeTty, input: { isTTY: false } });
  ui.render(liveSnap());
  const bare = stripAll(out.join('')).split(/\r?\n/);
  const has = (sub) => bare.some((l) => l.includes(sub));

  assert.ok(has('RIDEFOLLOW') && has('TERMINAL') && has('//'), 'wordmark with brand //');
  assert.ok(has('LIVE FEED'), 'live indicator');
  assert.ok(has('SESSION #0417'), 'subheader');
  assert.ok(has('SPEED KM/H') && has('DISTANCE KM') && has('ELAPSED') && has('ETA') && has('TOP KM/H'), 'metric labels');
  assert.ok(has('STATUS') && has('CLIMBING'), 'status box');
  assert.ok(has('HEADING') && has('NORTH-EAST'), 'heading box');
  assert.ok(has('ROUTE PROGRESS') && has('37%'), 'route progress');
  assert.ok(has('KM 0 · START') && has('KM 42 · FINISH'), 'route endpoints');
  assert.ok(has('EVENT LOG') && has('GPS FIX ACQUIRED') && has('SIGNAL LOST'), 'event log lines');

  const tops = bare.filter((l) => l.includes('╭'));
  const bots = bare.filter((l) => l.includes('╰'));
  assert.ok(tops.length >= 3 && tops.length === bots.length, 'every box opened is closed (metric/status/progress/log)');
  for (const l of bare) assert.ok(l.length <= 100, `line within cols: "${l}"`);
  ok('full-screen frame: header, metric strip, status/progress, event log, boxes balanced');
}

console.log('UI non-TTY fallback');
{
  const out = [];
  const fake = { isTTY: false, write: (s) => out.push(s), on() {}, removeListener() {} };
  const ui = new Ui({ stream: fake, input: { isTTY: false } });
  ui.render({ ...liveSnap(), status: { kind: 'live', label: 'RIDING' } });
  const line = out.join('');
  assert.ok(line.includes('[RIDING]') && line.includes('(Ada Lovelace)'), 'compact line with status + rider');
  ok('pipes a one-line summary when not a TTY');
}

console.log('API client (mock server)');
{
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/ride/GOOD') {
      res.end(JSON.stringify({ rider: 'r-123', host: 'broker.example', tcpPort: 8883, wsPort: 8084, username: 'reader-x', password: 'pw', topic: 'riders/r-123/telemetry', cheersTopic: 'riders/r-123/cheers' }));
    } else if (req.url === '/v1/ride/GONE') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'ride link expired or invalid' }));
    } else if (req.url === '/v1/ride/GOOD/history') {
      res.end(JSON.stringify({ rider: 'r-123', samples: [{ t: 10, dist: 0.5, spd: 20, lat: 45.0, lng: 7.6, ts: 1700 }, { t: 20, dist: 1.0, spd: 24, lat: 45.01, lng: 7.61, ts: 1701 }], serverNowMs: 2000, latestAgeSeconds: 5.0 }));
    } else if (req.url === '/v1/ride/GOOD/route') {
      res.end(JSON.stringify({ points: [[45.0, 7.6], [45.05, 7.7]], distanceKm: 12.3 }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const share = await resolveRide(base, 'GOOD');
  assert.equal(share.rider, 'r-123');
  assert.equal(share.username, 'reader-x');
  assert.equal(share.topic, 'riders/r-123/telemetry');
  ok('resolveRide parses the ride share');

  assert.equal(await resolveRide(base, 'GONE'), null);
  ok('expired token -> null');

  const hist = await fetchHistory(base, 'GOOD');
  assert.equal(hist.samples.length, 2);
  assert.equal(hist.latestAgeSeconds, 5.0);
  ok('fetchHistory backfill decodes + freshness');

  const route = await fetchRoute(base, 'GOOD');
  assert.equal(route.points.length, 2);
  assert.equal(route.distanceKm, 12.3);
  ok('fetchRoute parses the planned line');

  server.close();
}

console.log(`\nAll ${pass} checks passed.`);
