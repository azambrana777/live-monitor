import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRunner } from './src/runner/app.js';
import { setProcessCaps } from './src/exec.js';

/**
 * Entry point on the dev box: `node runner.js`, from
 * ~/.hfs-monitor/runner.json (written by remote/bootstrap.sh):
 *
 *   { "port": 7421, "bind": "<tailscale ip>", "token": "…",
 *     "repoPath": "/home/user/src/hfs", "worktreeRoot": "/home/user/src/hfs-wt" }
 *
 * It refuses to listen on every interface: whoever holds the token can run
 * anything as this user, and on this box this user is root without a password.
 */
const file = process.env.HFSMON_RUNNER_CONFIG ?? path.join(homedir(), '.hfs-monitor', 'runner.json');
const cfg = JSON.parse(readFileSync(file, 'utf8'));

if (!cfg.bind || cfg.bind === '0.0.0.0' || cfg.bind === '::') {
  console.error(`runner: "bind" en ${file} debe ser la IP de Tailscale de esta máquina, no ${cfg.bind ?? '(vacío)'}`);
  process.exit(2);
}

// The 8/4/8 process budgets belong to the board. Here they would queue /info
// (and every other request) behind slow git calls; the board already limits
// what it sends.
setProcessCaps({ gh: Infinity, ghPerRepo: Infinity, git: Infinity });

const runner = createRunner(cfg);
const addr = await runner.listen(cfg.port ?? 7421, cfg.bind);
const info = await runner.machine.info();
console.log(`hfs-monitor runner escuchando en http://${addr.address}:${addr.port} · claude ${info.claude ?? '(no encontrado)'} · node ${info.node}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    // A stuck stop must not outlive the upgrade's 60 s window (systemd would wait 90 s).
    setTimeout(() => process.exit(1), 10_000).unref();
    await runner.close();
    process.exit(0);
  });
}
