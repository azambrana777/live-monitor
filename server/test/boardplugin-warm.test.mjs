import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findBoardPlugin } from '../src/boardplugin.js';

// A runner is a Linux box: its paths use `/`, whatever the board's own OS uses.
const runner = (files) => ({
  name: 'runner-1',
  kind: 'runner',
  path: path.posix,
  fs: { exists: async (p) => files.includes(p) },
});

test('a runner plugin is found by its POSIX manifest path, even from a Windows board', async () => {
  const m = runner(['/home/x/hfs-monitor/plugins/hfs-ux/.claude-plugin/plugin.json']);
  assert.equal(await findBoardPlugin(m, '/home/x/hfs-monitor', 'hfs-ux'), '/home/x/hfs-monitor/plugins/hfs-ux');
});

test('a runner without the manifest has no plugin path', async () => {
  assert.equal(await findBoardPlugin(runner([]), '/home/x/hfs-monitor', 'hfs-ux'), null);
});
