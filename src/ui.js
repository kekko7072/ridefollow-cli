// The terminal UI: an amber/orange "RIDEFOLLOW // TERMINAL" dashboard that
// redraws in place, plus a plain line-per-update fallback when stdout isn't a
// TTY (piped, CI, logs).
//
// Look: a retro amber-phosphor CRT built around the RideFollow brand flame
// (#FF3B20) — warm orange on near-black, all-caps labels, rounded box-drawing
// borders, seven-segment "LCD" digits for the headline metrics, and a warm
// event log. Everything is drawn with width-1 glyphs so the borders line up in
// any monospace font.

// Amber/orange monochrome CRT, built around the RideFollow brand flame #FF3B20.
const TEXT = '38;2;255;120;62'; // primary readable orange — body text / values
const HI = '38;2;255;170;108'; // brightest — big LCD digits, %, highlights
const DIM = '38;2;150;74;42'; // labels, borders, spent bar, timestamps
const FLAME = '38;2;255;59;32'; // brand pop — wordmark, live dot, progress
const WARN = '38;2;255;214;130'; // warnings/alerts — lighter, stands out

const colorEnabled = () =>
  !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR);

function wrap(open, s) {
  return colorEnabled() ? `\x1b[${open}m${s}\x1b[39m` : String(s);
}

// `c` is a live binding; kept tiny and dependency-free.
export const c = {
  text: (s) => wrap(TEXT, s),
  hi: (s) => wrap(HI, s),
  dim: (s) => wrap(DIM, s),
  flame: (s) => wrap(FLAME, s),
  warn: (s) => wrap(WARN, s),
  bold: (s) => (colorEnabled() ? `\x1b[1m${s}\x1b[22m` : String(s)),
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

function dispWidth(s) {
  const bare = stripAnsi(s);
  let w = 0;
  for (const ch of bare) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  );
}

function pad(s, width, align = 'left') {
  const gap = width - dispWidth(s);
  if (gap <= 0) return s;
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') {
    const l = Math.floor(gap / 2);
    return ' '.repeat(l) + s + ' '.repeat(gap - l);
  }
  return s + ' '.repeat(gap);
}

function truncate(s, width) {
  if (dispWidth(s) <= width) return s;
  // Trim bare text (these strings have no ANSI when truncated).
  const bare = stripAnsi(s);
  return bare.slice(0, Math.max(0, width - 1)) + '…';
}

function twoSided(left, right, width) {
  const gap = width - dispWidth(left) - dispWidth(right);
  return gap > 0 ? left + ' '.repeat(gap) + right : left;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ── formatting ────────────────────────────────────────────────────────────
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatAge(seconds) {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 3) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const DIRS_LONG = ['NORTH', 'NORTH-EAST', 'EAST', 'SOUTH-EAST', 'SOUTH', 'SOUTH-WEST', 'WEST', 'NORTH-WEST'];
const dirIndex = (hdg) => Math.round((((hdg % 360) + 360) % 360) / 45) % 8;

export function compass(hdg) {
  return hdg == null ? '—' : DIRS[dirIndex(hdg)];
}
export function compassLong(hdg) {
  return hdg == null ? '—' : DIRS_LONG[dirIndex(hdg)];
}

// ── seven-segment "LCD" digits (3 rows tall) ─────────────────────────────────
const FONT = {
  '0': [' _ ', '| |', '|_|'],
  '1': ['   ', '  |', '  |'],
  '2': [' _ ', ' _|', '|_ '],
  '3': [' _ ', ' _|', ' _|'],
  '4': ['   ', '|_|', '  |'],
  '5': [' _ ', '|_ ', ' _|'],
  '6': [' _ ', '|_ ', '|_|'],
  '7': [' _ ', '  |', '  |'],
  '8': [' _ ', '|_|', '|_|'],
  '9': [' _ ', '|_|', ' _|'],
  ':': [' ', '.', '.'],
  '.': [' ', ' ', '.'],
  '-': ['   ', ' _ ', '   '],
  '%': ['   ', ' /.', './ '],
  ' ': ['   ', '   ', '   '],
};
const isPunct = (ch) => ch === ':' || ch === '.';

/**
 * Render a short numeric string as three rows of seven-segment glyphs.
 * `compact` drops the inter-digit space so the digits touch — used to keep the
 * five-metric strip legible on ~80-column terminals.
 */
export function renderBig(str, compact = false) {
  const rows = ['', '', ''];
  let prev = null;
  for (const ch of String(str)) {
    const g = FONT[ch] || FONT[' '];
    const sep = prev == null || compact || isPunct(ch) || isPunct(prev) ? '' : ' ';
    for (let i = 0; i < 3; i++) rows[i] += sep + g[i];
    prev = ch;
  }
  return rows;
}
export const bigWidth = (str, compact = false) => dispWidth(renderBig(str, compact)[0]);

const num1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : null);
const num0 = (v) => (Number.isFinite(v) ? Math.round(v).toString() : null);

// ── the UI object ───────────────────────────────────────────────────────────
export class Ui {
  constructor({ stream = process.stdout, input = process.stdin } = {}) {
    this.stream = stream;
    this.input = input;
    this.isTty = Boolean(stream.isTTY);
    this._keyCb = null;
    this._started = false;
    this._lastLogKey = '';
    this._onData = this._onData.bind(this);
    this._onResize = () => this._render && this._render();
    this._render = null;
  }

  start() {
    if (this._started) return;
    this._started = true;
    if (this.isTty) {
      this.stream.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
      this.stream.on('resize', this._onResize);
      if (this.input.isTTY) {
        this.input.setRawMode(true);
        this.input.resume();
        this.input.setEncoding('utf8');
        this.input.on('data', this._onData);
      }
    }
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    if (this.isTty) {
      this.stream.removeListener('resize', this._onResize);
      if (this.input.isTTY) {
        this.input.removeListener('data', this._onData);
        try {
          this.input.setRawMode(false);
        } catch {
          /* ignore */
        }
        this.input.pause();
      }
      this.stream.write('\x1b[?25h\x1b[?1049l');
    }
  }

  onKey(cb) {
    this._keyCb = cb;
  }

  _onData(chunk) {
    // Raw keystrokes. Ctrl-C, Ctrl-D and a lone Esc quit; a multi-byte chunk
    // beginning with Esc is an arrow/navigation key, so ignore it.
    for (const ch of chunk) {
      const code = ch.charCodeAt(0);
      let action = null;
      if (code === 3 || code === 4) action = "quit"; // Ctrl-C / Ctrl-D
      else if (code === 27 && chunk.length === 1) action = "quit"; // Esc
      else if (ch === "q" || ch === "Q") action = "quit";
      else if (ch === "c" || ch === "C") action = "cheer";
      if (action && this._keyCb) this._keyCb(action);
    }
  }

  /** Render a snapshot. Full-screen when a TTY, one line otherwise. */
  render(snap) {
    if (this.isTty) {
      this._render = () => this._paint(snap);
      this._paint(snap);
    } else {
      this._line(snap);
    }
  }

  _paint(snap) {
    const cols = this.stream.columns || 80;
    const rows = this.stream.rows || 24;
    const frame = buildFrame(snap, cols, rows);
    let out = '\x1b[H';
    const shown = frame.slice(0, Math.max(0, rows - 1));
    out += shown.map((l) => l + '\x1b[K').join('\r\n');
    out += '\x1b[J';
    this.stream.write(out);
  }

  _line(snap) {
    const key = `${snap.status.label}|${snap.sample ? snap.sample.elapsed : -1}`;
    if (key === this._lastLogKey) return;
    this._lastLogKey = key;
    const s = snap.sample;
    const bits = [
      `[${snap.status.label}]`,
      s ? formatDuration(s.elapsed) : '--:--',
      s ? `${num1(s.distance)}km` : '',
      s ? `${num1(s.speed)}km/h` : '',
      s && Number.isFinite(s.elevation) ? `+${num0(s.elevation)}m` : '',
      snap.riderName ? `(${snap.riderName})` : '',
    ].filter(Boolean);
    this.stream.write(bits.join('  ') + '\n');
  }
}

// ── box helpers ──────────────────────────────────────────────────────────────
function boxed(innerLines, width) {
  const inner = width - 4;
  const top = c.dim('╭' + '─'.repeat(width - 2) + '╮');
  const bottom = c.dim('╰' + '─'.repeat(width - 2) + '╯');
  const body = innerLines.map((l) => c.dim('│') + ' ' + pad(l, inner) + ' ' + c.dim('│'));
  return [top, ...body, bottom];
}

function zipRows(a, b, gap = 2) {
  const n = Math.max(a.length, b.length);
  const blankA = ' '.repeat(dispWidth(a[0] || ''));
  const blankB = ' '.repeat(dispWidth(b[0] || ''));
  const out = [];
  for (let i = 0; i < n; i++) out.push((a[i] ?? blankA) + ' '.repeat(gap) + (b[i] ?? blankB));
  return out;
}

// ── frame builder ────────────────────────────────────────────────────────────
function buildFrame(snap, cols, rows) {
  const margin = 2;
  const W = clamp(cols - margin * 2, 40, 120);
  const M = ' '.repeat(margin);
  const out = [];
  const push = (s = '') => out.push(M + s);

  // Header — flame wordmark (brand) split by a bright "//", and live indicator.
  const wordmark = c.bold(`${c.flame('RIDEFOLLOW')} ${c.hi('//')} ${c.flame('TERMINAL')}`);
  const liveDot = { live: c.flame('●'), warn: c.warn('◍'), idle: c.dim('○') }[snap.live.kind] || c.dim('○');
  const liveLabel = snap.live.kind === 'live' ? c.flame(snap.live.label) : c.dim(snap.live.label);
  push(twoSided(wordmark, `${liveDot} ${liveLabel}`, W));
  push(twoSided(c.dim(truncate(snap.subheader, W - 12)), c.text(wallClock()), W));
  push(c.dim('─'.repeat(W)));
  push('');

  // Metric strip
  for (const l of boxed(metricRows(snap, W), W)) push(l);
  push('');

  // STATUS/HEADING + ROUTE PROGRESS, side by side
  const leftW = clamp(Math.floor(W * 0.32), 22, 32);
  const rightW = W - leftW - 2;
  const left = boxed(statusRows(snap, leftW), leftW);
  const right = boxed(progressRows(snap, rightW), rightW);
  for (const l of zipRows(left, right)) push(l);
  push('');

  // Event log fills the remaining space, always leaving exactly one row for the
  // footer. eventRows returns exactly `inner` lines, so the box is `inner + 2`
  // rows and the whole frame lands on rows-1 (what _paint shows).
  const eventTotal = clamp(rows - 1 - out.length - 1, 3, 40);
  for (const l of boxed(eventRows(snap, W, eventTotal - 2), W)) push(l);

  // Footer: key hints on the left, freshness on the right
  const key = (k, label) => `${c.hi('[' + k + ']')} ${c.dim(label)}`;
  const keys = `${key('q', 'quit')}   ${key('c', 'cheer')}`;
  const fresh = c.dim('last fix · ') + c.text(formatAge(snap.ageSeconds));
  push(twoSided(keys, fresh, W));

  return out;
}

function wallClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const METRICS = [
  { key: 'speed', label: 'SPEED KM/H' },
  { key: 'distance', label: 'DISTANCE KM' },
  { key: 'elapsed', label: 'ELAPSED' },
  { key: 'eta', label: 'ETA' },
  { key: 'top', label: 'TOP KM/H' },
];

function metricValues(snap) {
  const s = snap.sample;
  return {
    speed: s ? num1(s.speed) ?? '--' : '--',
    distance: s ? num1(s.distance) ?? '--' : '--',
    elapsed: s ? formatDuration(s.elapsed) : '--:--',
    eta: snap.etaSeconds != null ? formatDuration(snap.etaSeconds) : '--:--',
    top: s ? num1(s.topSpeed) ?? '--' : '--',
  };
}

function metricRows(snap, W) {
  const inner = W - 4;
  const n = METRICS.length;
  const div = c.dim('│'); // thin divider (1 col) to maximise cell width
  const cellW = Math.floor((inner - (n - 1)) / n);
  const vals = metricValues(snap);

  // Prefer spaced digits; fall back to compact (touching) digits; then to a
  // plain one-line value if even compact digits don't fit the cell.
  const fits = (compact) => METRICS.every((m) => bigWidth(vals[m.key], compact) <= cellW);
  const mode = cellW < 8 ? 'plain' : fits(false) ? 'spaced' : fits(true) ? 'compact' : 'plain';

  const joinCells = (cells) => pad(cells.join(div), inner);
  const labelRow = joinCells(METRICS.map((m) => pad(c.dim(m.label), cellW)));

  if (mode === 'plain') {
    const valueRow = joinCells(METRICS.map((m) => pad(c.bold(c.hi(truncate(vals[m.key], cellW))), cellW)));
    return [labelRow, valueRow];
  }
  const compact = mode === 'compact';
  const bigCells = METRICS.map((m) => renderBig(vals[m.key], compact).map((r) => c.hi(r)));
  const rowN = (i) => joinCells(METRICS.map((_, ci) => pad(bigCells[ci][i], cellW)));
  return [labelRow, rowN(0), rowN(1), rowN(2)];
}

function statusRows(snap, W) {
  const inner = W - 4;
  const stColor = { warn: c.warn, live: c.text, done: c.flame, idle: c.dim }[snap.status.kind] || c.text;
  return [
    c.dim('STATUS'),
    pad(c.bold(stColor(truncate(snap.status.label, inner))), inner),
    '',
    c.dim('HEADING'),
    pad(c.text(truncate(snap.heading, inner)), inner),
  ];
}

function progressRows(snap, W) {
  const inner = W - 4;
  if (snap.progressPct == null) {
    const km = snap.distanceKm != null ? snap.distanceKm.toFixed(1) : '0.0';
    return [
      c.dim('ROUTE PROGRESS · ') + c.text('LIVE'),
      '',
      c.dim('[' + '·'.repeat(Math.max(0, inner - 2)) + ']'),
      '',
      twoSided(c.dim('KM 0 · START'), c.text(`${km} KM COVERED`), inner),
    ];
  }
  const pct = Math.round(snap.progressPct);
  const barLen = Math.max(4, inner - 2); // inside the [ ]
  const filled = clamp(Math.round((pct / 100) * barLen), 0, barLen);
  let bar;
  if (filled >= barLen) bar = c.text('='.repeat(barLen));
  else bar = c.text('='.repeat(filled)) + c.flame('>') + c.dim('-'.repeat(barLen - filled - 1));
  const finish = snap.routeTotalKm != null ? `KM ${Math.round(snap.routeTotalKm)} · FINISH` : 'FINISH';
  return [
    c.dim('ROUTE PROGRESS · ') + c.flame(`${pct}%`),
    '',
    c.dim('[') + bar + c.dim(']'),
    '',
    twoSided(c.dim('KM 0 · START'), c.dim(finish), inner),
  ];
}

// Returns EXACTLY `count` inner lines so the caller's height budget holds.
function eventRows(snap, W, count) {
  const inner = W - 4;
  const n = Math.max(1, count);
  const lines = [c.dim('EVENT LOG')];
  if (n >= 3) lines.push(''); // blank under the title when there's room
  const slots = n - lines.length;
  const events = snap.events || [];
  if (slots > 0) {
    const shown = events.slice(-slots);
    if (shown.length === 0) {
      lines.push(c.dim('awaiting telemetry…'));
    } else {
      for (const e of shown) {
        // warn → light alert; hi (brand moments: cheers, ride complete) → flame; else text.
        const color = e.level === 'warn' ? c.warn : e.level === 'hi' ? c.flame : c.text;
        lines.push(truncate(`${c.dim(`[${e.stamp}]`)} ${color(e.text)}`, inner));
      }
    }
  }
  while (lines.length < n) lines.push('');
  return lines.slice(0, n);
}
