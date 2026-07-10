// Turn whatever the user pasted — a full share link, a bare host+query, or just
// the token — into { token, apiBase }. The share link the app hands out looks
// like `https://ridefollow.live/?ride=<token>`; the control-plane API that
// resolves the token lives at `https://api.ridefollow.live:8443`. The token is
// the only capability, so everything else (rider id, broker creds, host) comes
// back from the API — we only need to reach it.

const TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const DEFAULT_HOST = 'ridefollow.live';
const API_PORT = 8443;

/** Derive the control-plane API base from the share link's host. */
export function deriveApiBase(host) {
  const h = (host || DEFAULT_HOST).toLowerCase();
  // Local/dev backends run plain HTTP on the same host.
  if (h === 'localhost' || h === '127.0.0.1' || IP_RE.test(h)) {
    return `http://${h}:${API_PORT}`;
  }
  // Production: the site is `ridefollow.live`, the API is `api.ridefollow.live`.
  const apiHost = h.startsWith('api.') ? h : `api.${h}`;
  return `https://${apiHost}:${API_PORT}`;
}

/**
 * @param {string} input  a share URL, `host/?ride=…`, or a bare token
 * @param {{ apiOverride?: string }} [opts]
 * @returns {{ token: string, apiBase: string, shareHost: string }}
 */
export function parseTarget(input, opts = {}) {
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('No ride link or token given. Try: ridefollow-cli <share-link>');

  const apiOverride = normalizeApiOverride(opts.apiOverride);

  // Anything that looks like a URL/host — parse it. Otherwise treat as a token.
  const looksLikeUrl = /^https?:\/\//i.test(raw) || raw.includes('/') || raw.includes('?');
  if (!looksLikeUrl) {
    if (!TOKEN_RE.test(raw)) {
      throw new Error(`That doesn't look like a ride link or token: "${truncate(raw)}"`);
    }
    return {
      token: raw,
      apiBase: apiOverride || deriveApiBase(DEFAULT_HOST),
      shareHost: DEFAULT_HOST,
    };
  }

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Could not read that ride link: "${truncate(raw)}"`);
  }

  let token = url.searchParams.get('ride');
  // Some share links carry the query inside the hash (`#/?ride=…`).
  if (!token && url.hash.includes('ride=')) {
    const hp = new URLSearchParams(url.hash.replace(/^#\/?\??/, ''));
    token = hp.get('ride');
  }
  // Last resort: a `.../<token>` path.
  if (!token) {
    const seg = url.pathname.split('/').filter(Boolean).pop();
    if (seg && TOKEN_RE.test(seg)) token = seg;
  }

  if (!token) {
    throw new Error('No ?ride=<token> found in that link. Copy the full share link from the RideFollow app.');
  }
  if (!TOKEN_RE.test(token)) {
    throw new Error(`The ride token in that link looks malformed: "${truncate(token)}"`);
  }

  return {
    token,
    apiBase: apiOverride || deriveApiBase(url.hostname),
    shareHost: url.hostname,
  };
}

function normalizeApiOverride(v) {
  if (!v) return '';
  let s = String(v).trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}

function truncate(s, n = 40) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
