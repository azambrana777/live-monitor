// DNS rebinding guard in access.js: a tiny express app behind `accessGuard`,
// hit over real HTTP from loopback with hand-set Host / Origin headers (fetch
// will not let a caller choose Host, node:http does; a raw socket covers what
// node:http will not send), plus `socketRefusal` / `socketAllowed` against fake
// upgrade requests.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

const TOKEN = 'secreto-de-prueba';
const TRUSTED = 'user@example.com';
const MACHINE = os.hostname();
const TS_HOST = `${MACHINE}.example.ts.net`;

let config;
let access;
let savedAccess;
let server;
let port;
const warnings = [];
let realWarn;

before(async () => {
  ({ config } = await import('../src/config.js'));
  access = await import('../src/access.js');
  savedAccess = config.access;
  config.access = { token: TOKEN, trustedTailscaleUsers: [TRUSTED], allowedHosts: ['Tablero.Casa.Lan'] };

  realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };

  const express = (await import('express')).default;
  const app = express();
  app.use(access.accessGuard);
  app.all('/api/ping', (req, res) => res.json({ ok: true }));
  app.get('/api/tasks', (req, res) => res.json([]));
  app.get('/index.html', (req, res) => res.type('html').send('<p>tablero</p>'));
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  port = server.address().port;
});

after(async () => {
  console.warn = realWarn;
  config.access = savedAccess;
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  warnings.length = 0;
  access.resetHostWarnings();
});

/** One request to the guarded app with exactly these headers. */
function call({ method = 'GET', path = '/api/ping', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Bytes straight onto the socket, for requests node:http refuses to build. Resolves with the status code. */
function rawCall(text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let data = '';
    s.setEncoding('utf8');
    s.on('data', (c) => { data += c; });
    s.on('end', () => resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1])));
    s.on('error', reject);
  });
}

const socket = ({ host, origin, url = '/ws', remoteAddress = '127.0.0.1', extra = {} }) => ({
  url,
  socket: { remoteAddress },
  headers: { ...(host === undefined ? {} : { host }), ...(origin === undefined ? {} : { origin }), ...extra },
});

test('Host localhost:7420 desde loopback pasa sin token', async () => {
  const res = await call({ headers: { host: 'localhost:7420' } });
  assert.equal(res.status, 200);
});

test('Host 127.0.0.1:7420 y [::1]:7420 pasan', async () => {
  assert.equal((await call({ headers: { host: '127.0.0.1:7420' } })).status, 200);
  assert.equal((await call({ headers: { host: '[::1]:7420' } })).status, 200);
});

test('Host ajeno desde loopback recibe 403 aunque traiga un token válido', async () => {
  const res = await call({ path: `/api/ping?token=${TOKEN}`, headers: { host: 'evil.example:7420' } });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Host no permitido' });
  assert.equal(res.headers['set-cookie'], undefined, 'no recuerda el dispositivo');

  const cookie = await call({ headers: { host: 'evil.example:7420', cookie: `${access.COOKIE}=${TOKEN}` } });
  assert.equal(cookie.status, 403, 'la cookie tampoco lo salva');
});

test('los parecidos a un host local o a la máquina reciben 403', async () => {
  const lookalikes = [
    'localhost.evil.com', '127.0.0.1.nip.io', '[::ffff:127.0.0.1]', '2130706433', 'localhost.:7420',
    `${MACHINE}.evil.com`, `${MACHINE}.ts.net`, `x.${TS_HOST}`,
  ];
  for (const host of lookalikes) {
    const res = await call({ headers: { host } });
    assert.equal(res.status, 403, host);
  }
});

test('un Host mal formado no nombra nada: 403', async () => {
  const malformed = [
    'localhost:', 'localhost:7420x', 'localhost:+80', '[::1]x', '[::1]:', '[::1]:80:80', '[::1',
    'user@localhost', 'local host', 'localhost :7420', '::1', '127.0.0.1:7420:1',
  ];
  for (const host of malformed) {
    const res = await call({ headers: { host } });
    assert.equal(res.status, 403, host);
  }
});

test('dos cabeceras Host, en cualquier orden, reciben 403', async () => {
  const good = 'Host: localhost:7420\r\n';
  const bad = 'Host: evil.example\r\n';
  const req = (a, b) => `GET /api/ping HTTP/1.1\r\n${a}${b}Connection: close\r\n\r\n`;
  assert.equal(await rawCall(req(good, bad)), 403);
  assert.equal(await rawCall(req(bad, good)), 403);
  assert.equal(await rawCall(req(good, good)), 403, 'ni repitiendo la buena');
});

test('HTTP/1.0 sin Host recibe 403', async () => {
  assert.equal(await rawCall('GET /api/ping HTTP/1.0\r\n\r\n'), 403);
});

test('el nombre de la máquina pasa, sin distinguir mayúsculas', async () => {
  assert.equal((await call({ headers: { host: MACHINE } })).status, 200);
  assert.equal((await call({ headers: { host: `${MACHINE.toUpperCase()}:7420` } })).status, 200);
});

test('<máquina>.<tailnet>.ts.net pasa; otra máquina o cinco etiquetas no', async () => {
  assert.equal((await call({ headers: { host: TS_HOST.toLowerCase() } })).status, 200);
  assert.equal((await call({ headers: { host: TS_HOST.toUpperCase() } })).status, 200);
  assert.equal((await call({ headers: { host: 'otra-maquina.example.ts.net' } })).status, 403);
  assert.equal((await call({ headers: { host: `x.${MACHINE}.tail.ts.net` } })).status, 403);
  assert.equal((await call({ headers: { host: `${MACHINE}..ts.net` } })).status, 403, 'tailnet vacío');
});

test('un host de access.allowedHosts pasa, con puerto y en otra caja', async () => {
  const res = await call({ headers: { host: 'tablero.casa.lan:7420' } });
  assert.equal(res.status, 200);
});

test('una IP propia de la máquina pasa (los enlaces LAN/Tailscale de where.ps1)', async (t) => {
  const own = Object.values(os.networkInterfaces()).flat()
    .find((a) => a && a.family === 'IPv4' && !a.address.startsWith('127.'));
  if (!own) return t.skip('sin interfaz IPv4 que no sea loopback');
  const res = await call({ headers: { host: `${own.address}:7420` } });
  assert.equal(res.status, 200);
});

test('POST con Origin ajeno y Host bueno recibe 403 «Origin no permitido»', async () => {
  const res = await call({ method: 'POST', headers: { host: 'localhost:7420', origin: 'http://evil.example' } });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'Origin no permitido' });
  assert.match(warnings.at(-1), /Origin no permitido "evil\.example"/);

  for (const origin of ['null', '', 'basura', 'http://', 'http://localhost.evil.com']) {
    const bad = await call({ method: 'DELETE', headers: { host: 'localhost:7420', origin } });
    assert.equal(bad.status, 403, `Origin ${JSON.stringify(origin)}`);
    assert.deepEqual(bad.body, { error: 'Origin no permitido' });
  }
});

test('POST con Origin propio pasa; un GET no mira el Origin', async () => {
  const same = await call({ method: 'POST', headers: { host: 'localhost:7420', origin: 'http://localhost:5173' } });
  assert.equal(same.status, 200);
  const get = await call({ headers: { host: 'localhost:7420', origin: 'http://evil.example' } });
  assert.equal(get.status, 200);
});

test('POST sin Origin (curl) sigue las reglas de siempre', async () => {
  const res = await call({ method: 'POST', headers: { host: 'localhost:7420' } });
  assert.equal(res.status, 200);
});

test('tailscale serve: el Host ts.net reenviado pasa y el usuario de confianza no necesita token', async () => {
  const proxied = { host: TS_HOST, 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': TRUSTED };

  const trusted = await call({ method: 'POST', headers: { ...proxied, origin: `https://${TS_HOST}:443` } });
  assert.equal(trusted.status, 200, 'Origin https con :443 explícito');

  const stranger = await call({ headers: { ...proxied, 'tailscale-user-login': 'otro@example.com' } });
  assert.equal(stranger.status, 401, 'el Host bueno no exime del token');

  const withToken = await call({ headers: { ...proxied, 'tailscale-user-login': 'otro@example.com', 'x-hfsmon-token': TOKEN } });
  assert.equal(withToken.status, 200);

  const rebound = await call({ headers: { ...proxied, host: 'evil.example' } });
  assert.equal(rebound.status, 403, 'por el proxy también se mira el Host');
});

test('GET /api con Sec-Fetch-Site cross-site recibe 403; same-origin, same-site, none o sin cabecera pasan', async () => {
  const host = 'localhost:7420';
  const cross = await call({ path: '/api/tasks', headers: { host, 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  assert.deepEqual(cross.body, { error: 'cross-site request' });

  for (const site of ['same-origin', 'same-site', 'none']) {
    const res = await call({ path: '/api/tasks', headers: { host, 'sec-fetch-site': site } });
    assert.equal(res.status, 200, site);
  }
  assert.equal((await call({ path: '/api/tasks', headers: { host } })).status, 200, 'sin cabecera');

  const page = await call({ path: '/index.html', headers: { host, 'sec-fetch-site': 'cross-site' } });
  assert.equal(page.status, 200, 'llegar a la UI desde un enlace de otro sitio sigue funcionando');
});

test('un Host no permitido se avisa una sola vez por nombre', async () => {
  await call({ headers: { host: 'evil.example:7420' } });
  await call({ headers: { host: 'EVIL.example:9999' } });
  await call({ headers: { host: 'otro.example' } });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /evil\.example/);
  assert.match(warnings[0], /access\.allowedHosts/);
  assert.match(warnings[1], /otro\.example/);
});

test('los avisos tienen tope: 60 Host distintos dejan como mucho 51 líneas', async () => {
  for (let i = 0; i < 60; i += 1) await call({ headers: { host: `h${i}.example` } });
  assert.ok(warnings.length <= 51, `${warnings.length} avisos`);
  assert.equal(warnings.length, 51);
  assert.match(warnings.at(-1), /no se avisará de más/);

  await call({ headers: { host: 'uno-mas.example' } });
  assert.equal(warnings.length, 51, 'después del tope, silencio');
});

test('un Origin enorme se registra recortado', async () => {
  const origin = `http://${'a'.repeat(500)}.example`;
  await call({ method: 'POST', headers: { host: 'localhost:7420', origin } });
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('a'.repeat(101)), 'no más de 100 caracteres del valor');
});

test('socketAllowed / socketRefusal: Host ajeno, Origin ajeno o null, y sin token', () => {
  assert.equal(access.socketAllowed(socket({ host: 'evil.example:7420' })), false);
  assert.equal(access.socketRefusal(socket({ host: 'evil.example:7420', url: `/ws?token=${TOKEN}` })), 'host');

  assert.equal(access.socketAllowed(socket({ host: 'localhost:7420', origin: 'http://evil.example' })), false);
  assert.equal(access.socketRefusal(socket({ host: 'localhost:7420', origin: 'http://evil.example' })), 'origin');
  assert.equal(access.socketRefusal(socket({ host: 'localhost:7420', origin: 'null' })), 'origin');

  const proxied = { 'x-forwarded-for': '100.64.0.7' };
  assert.equal(access.socketRefusal(socket({ host: TS_HOST, origin: `https://${TS_HOST}`, extra: proxied })), 'token');

  assert.equal(access.socketRefusal(socket({ host: 'localhost:7420', origin: 'http://localhost:7420' })), null);
  assert.equal(access.socketAllowed(socket({ host: 'localhost:7420' })), true);
});

// --- No token configured: the board must not be open to the network -----------

const LAN = '192.168.1.50';

/** Runs `fn` with `config.access` replaced, then puts the suite's access config back. */
async function withAccess(next, fn) {
  const prev = config.access;
  config.access = next;
  try {
    return await fn();
  } finally {
    config.access = prev;
  }
}

const NO_TOKEN = { token: '', trustedTailscaleUsers: [TRUSTED] };
const base = { remoteAddress: '127.0.0.1', headerToken: undefined, queryToken: undefined, cookieHeader: undefined, forwardedFor: undefined, tailscaleUser: undefined };

test('sin token: isAllowed acepta loopback directo', async () => {
  await withAccess(NO_TOKEN, () => {
    assert.equal(access.isAllowed(base), true);
    assert.equal(access.isAllowed({ ...base, remoteAddress: '::1' }), true);
    assert.equal(access.isAllowed({ ...base, remoteAddress: '::ffff:127.0.0.1' }), true);
  });
});

test('sin token: isAllowed rechaza una dirección que no es loopback', async () => {
  await withAccess(NO_TOKEN, () => {
    assert.equal(access.isAllowed({ ...base, remoteAddress: LAN }), false);
  });
});

test('sin token: una cabecera de token vacía no abre la puerta', async () => {
  await withAccess(NO_TOKEN, () => {
    assert.equal(access.isAllowed({ ...base, remoteAddress: LAN, headerToken: '' }), false);
    assert.equal(access.isAllowed({ ...base, remoteAddress: LAN, queryToken: '' }), false);
    assert.equal(access.isAllowed({ ...base, remoteAddress: LAN, cookieHeader: `${access.COOKIE}=` }), false);
    assert.equal(access.isAllowed({ ...base, headerToken: '', forwardedFor: '100.64.0.7' }), false);
  });
});

test('sin token: loopback reenviado por un proxy se trata como remoto', async () => {
  await withAccess(NO_TOKEN, () => {
    assert.equal(access.isAllowed({ ...base, forwardedFor: '100.64.0.7' }), false);
    assert.equal(access.isAllowed({ ...base, tailscaleUser: 'otro@example.com' }), false);
  });
});

test('sin token: el usuario Tailscale de confianza sigue entrando', async () => {
  await withAccess(NO_TOKEN, () => {
    assert.equal(access.isAllowed({ ...base, forwardedFor: '100.64.0.7', tailscaleUser: TRUSTED }), true);
  });
});

test('sin access en la configuración equivale a sin token', async () => {
  await withAccess(undefined, () => {
    assert.equal(access.isAllowed(base), true);
    assert.equal(access.isAllowed({ ...base, remoteAddress: LAN }), false);
  });
});

test('con token: igual que siempre', async () => {
  await withAccess({ token: TOKEN, trustedTailscaleUsers: [TRUSTED] }, () => {
    assert.equal(access.isAllowed(base), true, 'localhost exento');
    assert.equal(access.isAllowed({ ...base, remoteAddress: LAN }), false);
    assert.equal(access.isAllowed({ ...base, remoteAddress: LAN, headerToken: TOKEN }), true);
    assert.equal(access.isAllowed({ ...base, remoteAddress: LAN, queryToken: TOKEN }), true);
    assert.equal(access.isAllowed({ ...base, remoteAddress: LAN, cookieHeader: `${access.COOKIE}=${TOKEN}` }), true);
    assert.equal(access.isAllowed({ ...base, remoteAddress: LAN, headerToken: 'otro' }), false);
    assert.equal(access.isAllowed({ ...base, forwardedFor: '100.64.0.7' }), false, 'proxied sin credencial');
    assert.equal(access.isAllowed({ ...base, forwardedFor: '100.64.0.7', tailscaleUser: TRUSTED }), true);
  });
});

test('sin token: accessGuard responde 401 a una petición reenviada y 200 a la directa', async () => {
  await withAccess(NO_TOKEN, async () => {
    const host = 'localhost:7420';
    const proxied = await call({ headers: { host, 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(proxied.status, 401);
    const empty = await call({ headers: { host, 'x-forwarded-for': '203.0.113.9', 'x-hfsmon-token': '' } });
    assert.equal(empty.status, 401, 'token vacío tampoco');
    const direct = await call({ headers: { host } });
    assert.equal(direct.status, 200);
  });
});

test('sin token: socketRefusal pide token a una dirección que no es loopback', async () => {
  await withAccess(NO_TOKEN, () => {
    const lan = { host: `${LAN}:7420`, remoteAddress: LAN };
    assert.equal(access.socketRefusal(socket({ ...lan, host: 'localhost:7420' })), 'token');
    assert.equal(access.socketAllowed(socket({ ...lan, host: 'localhost:7420' })), false);
    assert.equal(access.socketRefusal(socket({ host: 'localhost:7420', remoteAddress: LAN, url: '/ws?token=' })), 'token');
    assert.equal(access.socketRefusal(socket({ host: 'localhost:7420', extra: { 'x-forwarded-for': '100.64.0.7' } })), 'token');
    assert.equal(access.socketRefusal(socket({ host: 'localhost:7420' })), null, 'loopback directo');
  });
});

test('con token: socketRefusal deja pasar a una dirección remota con el token', async () => {
  await withAccess({ token: TOKEN }, () => {
    const remote = { host: 'localhost:7420', remoteAddress: LAN };
    assert.equal(access.socketRefusal(socket(remote)), 'token');
    assert.equal(access.socketRefusal(socket({ ...remote, url: `/ws?token=${TOKEN}` })), null);
    assert.equal(access.socketRefusal(socket({ ...remote, extra: { 'x-hfsmon-token': TOKEN } })), null);
  });
});

test('listenHost: loopback sin token, todas las interfaces con token', async () => {
  assert.equal(typeof access.listenHost, 'function', 'access.js exporta listenHost()');
  await withAccess(NO_TOKEN, () => assert.equal(access.listenHost(), '127.0.0.1'));
  await withAccess(undefined, () => assert.equal(access.listenHost(), '127.0.0.1'));
  await withAccess({ token: TOKEN }, () => assert.equal(access.listenHost(), undefined));
});

test('describeAccess cuenta la situación real y cómo poner el token', async () => {
  await withAccess(NO_TOKEN, () => {
    const msg = access.describeAccess();
    assert.match(msg, /SIN TOKEN/);
    assert.match(msg, /127\.0\.0\.1/);
    assert.match(msg, /access\.token/);
    assert.match(msg, /config\.local\.json/);
  });
  await withAccess({ token: TOKEN }, () => {
    const msg = access.describeAccess();
    assert.doesNotMatch(msg, /SIN TOKEN/);
    assert.match(msg, /token/);
    assert.match(msg, /localhost exento/);
  });
});
