import os from 'node:os';
import { config } from './config.js';

/**
 * The board can start Claude sessions that run arbitrary commands on this
 * machine, so anything beyond loopback has to prove it belongs. Local use stays
 * frictionless: a request from 127.0.0.1 / ::1 never needs the token.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const isLoopback = (address) => LOOPBACK.has(String(address ?? ''));

/**
 * A request made on this machine, straight to the port: loopback on the
 * socket and none of the headers a local proxy adds. `tailscale serve`
 * connects from loopback too, so the address alone proves nothing.
 */
export const isDirectLoopback = (req) => isLoopback(req.socket?.remoteAddress)
  && !req.get('x-forwarded-for') && !req.get('tailscale-user-login') && !req.get('forwarded');

const token = () => config.access?.token ?? '';

export const COOKIE = 'hfsmon_token';

function cookieToken(header) {
  return String(header ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === COOKIE)?.[1];
}

const trustedUsers = () => config.access?.trustedTailscaleUsers ?? [];

/**
 * DNS rebinding guard.
 *
 * The loopback exemption trusts the socket address, but a page on any site can
 * rebind its own hostname to 127.0.0.1: the browser then connects here, treats
 * the answers as same-origin for the attacker's name and lets the page read
 * them. What the attacker cannot change is the Host header — it stays the
 * attacker's name — so only names this board is really served under pass:
 *
 * - `localhost`, `127.0.0.1`, `[::1]`;
 * - this machine's hostname (`os.hostname()`);
 * - its Tailscale MagicDNS name, exactly `<hostname>.<tailnet>.ts.net` — the
 *   name `where.ps1` prints and the Host that `tailscale serve` forwards
 *   unchanged;
 * - this machine's own interface addresses (the LAN / Tailscale IP links from
 *   `where.ps1`). An IP literal cannot be rebound: a page whose Host is one of
 *   those addresses was loaded from that address, not from somebody's domain;
 * - any extra name in `config.json` → `access.allowedHosts`, e.g.
 *   `"access": { "allowedHosts": ["board.example.lan"] }` (port ignored).
 *
 * Comparisons are case-insensitive and ignore the port. Parsing is strict: a
 * value that is not a plain name or bracketed IPv6 address, optionally followed
 * by `:digits`, names nothing and is refused.
 */
const allowedHostsConfig = () => (Array.isArray(config.access?.allowedHosts) ? config.access.allowedHosts : []);

/**
 * `Host`-style value → bare lower-case name (IPv6 kept in brackets), or '' when
 * the value is malformed: inner whitespace, `@`, a bare IPv6 address, anything
 * after `]` other than `:digits`, a non-numeric port, or characters no host
 * name uses. A trailing dot is not stripped, so `localhost.` is not `localhost`.
 */
export function hostName(value) {
  const h = String(value ?? '').trim().toLowerCase();
  if (!h || /[\s@]/.test(h)) return '';
  let name;
  let rest;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) return '';
    name = h.slice(0, end + 1);
    rest = h.slice(end + 1);
    if (!/^\[[0-9a-f:.]+\]$/.test(name)) return '';
  } else {
    const colon = h.indexOf(':');
    name = colon === -1 ? h : h.slice(0, colon);
    rest = colon === -1 ? '' : h.slice(colon);
    if (!/^[a-z0-9._-]+$/.test(name)) return '';
  }
  if (rest !== '' && !/^:\d+$/.test(rest)) return '';
  return name;
}

function ownAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const { address, family } of list ?? []) {
      const bare = String(address).split('%')[0].toLowerCase();   // drop an IPv6 zone id
      out.add(family === 'IPv6' || family === 6 ? `[${bare}]` : bare);
    }
  }
  return out;
}

/** True when `name` (already passed through `hostName`) is one this board is served under. */
export function isAllowedHostName(name) {
  if (!name) return false;
  if (name === 'localhost' || name === '127.0.0.1' || name === '[::1]') return true;

  const machine = os.hostname().toLowerCase();
  if (name === machine) return true;
  const labels = name.split('.');
  if (labels.length === 4 && labels[0] === machine && labels[1] && labels[2] === 'ts' && labels[3] === 'net') {
    return true;
  }

  if (allowedHostsConfig().some((h) => hostName(h) === name)) return true;
  return ownAddresses().has(name);
}

/**
 * The refusal log. The Host check runs before the token, so anyone who can
 * reach the port can send a fresh name on every request: keys are truncated and
 * the set is capped, after which one line says the reporting stopped.
 */
const MAX_WARNED = 50;
const KEY_LENGTH = 100;
const warned = new Set();
let warnCapped = false;

function warnRefused(what, value) {
  const key = String(value || '(vacío)').slice(0, KEY_LENGTH);
  if (warned.has(key)) return;
  if (warned.size >= MAX_WARNED) {
    if (!warnCapped) {
      warnCapped = true;
      console.warn(`acceso: ya van ${MAX_WARNED} Host/Origin no permitidos distintos; no se avisará de más hasta reiniciar`);
    }
    return;
  }
  warned.add(key);
  console.warn(`acceso: ${what} no permitido ${JSON.stringify(key)}; si es legítimo, añádelo a access.allowedHosts en config.json`);
}

/** Test hook: forget which names were already reported. */
export function resetHostWarnings() {
  warned.clear();
  warnCapped = false;
}

/** How many `Host` headers the request really carried: Node keeps only the first in `headers`. */
function hostHeaderCount(req) {
  const raw = req.rawHeaders;
  if (!Array.isArray(raw)) return req.headers?.host === undefined ? 0 : 1;
  let count = 0;
  for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === 'host') count += 1;
  return count;
}

/** The request's `Host` names this board. Two `Host` headers name nothing. */
export function allowedHost(req) {
  const raw = req.headers?.host;
  if (hostHeaderCount(req) > 1) {
    warnRefused('Host', '(Host duplicado)');
    return false;
  }
  const name = hostName(raw);
  if (isAllowedHostName(name)) return true;
  warnRefused('Host', name || raw);
  return false;
}

/** An `Origin`, when present, must also name this board. `null`, empty or garbage does not. */
function allowedOrigin(origin) {
  if (origin === undefined) return true;             // curl and other non-browser clients
  let name = '';
  try {
    name = hostName(new URL(String(origin)).host);
  } catch {
    name = '';
  }
  if (isAllowedHostName(name)) return true;
  warnRefused('Origin', name || String(origin));
  return false;
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isApi = (p) => p === '/api' || String(p).startsWith('/api/');

/**
 * True when the caller may be served.
 *
 * The loopback exemption cannot be granted on the socket address alone: with
 * `tailscale serve` in front, every remote request arrives from 127.0.0.1 and
 * would sail straight through. A forwarded request is recognised by the headers
 * the proxy adds, and only then can `tailscale-user-login` be believed — that
 * header is trustworthy exactly because the local proxy is the only thing that
 * can present it from loopback. Anyone reaching port 7420 directly comes from
 * their own address, so a forged header buys them nothing.
 */
export function isAllowed({ remoteAddress, headerToken, queryToken, cookieHeader, forwardedFor, tailscaleUser }) {
  const expected = token();

  const local = isLoopback(remoteAddress);
  const proxied = Boolean(forwardedFor || tailscaleUser);

  if (local && !proxied) return true;               // a browser on this machine
  if (local && tailscaleUser && trustedUsers().includes(tailscaleUser)) return true;

  // No token configured: nobody else gets in. Without this guard an empty
  // credential would equal the empty expected token.
  if (!expected) return false;

  return headerToken === expected
    || queryToken === expected
    || cookieToken(cookieHeader) === expected;
}

/** Express middleware guarding the API and the static UI. */
export function accessGuard(req, res, next) {
  // Before every exemption, the token included: a rebinding page may already
  // hold the device cookie, so a valid credential proves nothing about the name.
  if (!allowedHost(req)) return res.status(403).json({ error: 'Host no permitido' });
  if (STATE_CHANGING.has(req.method) && !allowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'Origin no permitido' });
  }
  // A plain GET carries no Origin, yet another site can still fire it blind
  // (starting gh/probe work) or pull `/api/files/content` into a <script> or
  // <img>. Browsers mark those; the board's own page is same-origin, and a
  // missing header (curl, old clients) or a navigation from elsewhere to the
  // UI itself stays allowed.
  if ((req.method === 'GET' || req.method === 'HEAD') && isApi(req.path)
    && String(req.get('sec-fetch-site') ?? '').trim().toLowerCase() === 'cross-site') {
    return res.status(403).json({ error: 'cross-site request' });
  }

  const queryToken = req.query?.token;
  const allowed = isAllowed({
    remoteAddress: req.socket.remoteAddress,
    headerToken: req.get('x-hfsmon-token'),
    queryToken,
    cookieHeader: req.headers.cookie,
    forwardedFor: req.get('x-forwarded-for'),
    tailscaleUser: req.get('tailscale-user-login'),
  });
  if (!allowed) {
    return res.status(401).json({
      error: 'An access token is required. Open the app once with ?token=… and this device will remember it.',
    });
  }
  // The page arrives with ?token=… but the assets it then loads carry nothing,
  // so remember the device here — otherwise the app would 401 on its own JS.
  if (queryToken && queryToken === token()) {
    res.cookie(COOKIE, queryToken, {
      httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }
  return next();
}

/**
 * Why a WebSocket upgrade is refused: 'host', 'origin' or 'token', or null when
 * it may connect. Browsers always send Origin on a WebSocket and never apply
 * CORS to it, so the Origin check is what keeps a foreign page from reading the
 * snapshot.
 */
export function socketRefusal(request) {
  if (!allowedHost(request)) return 'host';
  if (!allowedOrigin(request.headers.origin)) return 'origin';
  const url = new URL(request.url, 'http://localhost');
  const ok = isAllowed({
    remoteAddress: request.socket.remoteAddress,
    headerToken: request.headers['x-hfsmon-token'],
    queryToken: url.searchParams.get('token'),
    cookieHeader: request.headers.cookie,
    forwardedFor: request.headers['x-forwarded-for'],
    tailscaleUser: request.headers['tailscale-user-login'],
  });
  return ok ? null : 'token';
}

/** Same check for the WebSocket upgrade, which carries no custom headers. */
export const socketAllowed = (request) => socketRefusal(request) === null;

/**
 * Where the board listens: loopback only while no token is configured, every
 * interface (`undefined`, Node's default) once there is one.
 */
export const listenHost = () => (token() ? undefined : '127.0.0.1');

/** Boot message: the real bind and, without a token, how to open the board. */
export function describeAccess() {
  return token()
    ? 'escucha en todas las interfaces; acceso remoto protegido por token (localhost exento)'
    : 'SIN TOKEN: solo se escucha en 127.0.0.1 (esta máquina). Para abrir el tablero a la red, '
      + 'pon access.token en config.local.json y reinicia';
}
