import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { handleShellConnection, hasActiveCodexShellSession } from '@/modules/websocket/services/shell-websocket.service.js';

const nativeProbeAvailable = (process.platform === 'darwin' || process.platform === 'linux')
  && spawnSync(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-v'], { stdio: 'ignore', timeout: 1000 }).status === 0;
const nativeProbeTest = { skip: nativeProbeAvailable ? false : 'Requires POSIX process-group inspection and lsof' };

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    frames: [] as Array<Record<string, unknown>>,
    send(value: string) { this.frames.push(JSON.parse(value)); },
  });
}

// A real retained child opens the same native lock descriptor Codex 0.169 uses.
// No model, daemon, user home, or external service is involved.
async function freshShell(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-fresh-ownership-'));
  const codexHome = path.join(directory, 'codex-home');
  await mkdir(path.join(codexHome, 'thread-writer-locks'), { recursive: true });
  const nativeId = '01a1d85a-26f6-7131-930a-a5c3ecd144b8';
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const child = spawn(process.execPath, ['-e', `
    require('node:fs').openSync(process.argv[1], 'w');
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `, path.join(codexHome, 'thread-writer-locks', nativeId + '.lock')], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await once(child.stdout!, 'data');
  const exitListeners: Array<() => void> = [];
  const terminal = {
    pid: child.pid!,
    onData() { return { dispose() {} }; },
    onExit(listener: (event: { exitCode: number }) => void) { exitListeners.push(() => listener({ exitCode: 0 })); return { dispose() {} }; },
    kill() {}, write() {}, resize() {},
  };
  const fresh = socket();
  let launches = 0;
  const dependencies = {
    resolveProviderSessionId: (id: string) => id === 'indexed-fresh-app' ? nativeId : id,
    spawnPty: () => { launches += 1; return terminal as never; },
  };
  t.after(async () => {
    exitListeners.forEach((listener) => listener());
    const exited = once(child, 'exit'); child.kill(); await exited;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(directory, { recursive: true, force: true });
  });
  handleShellConnection(fresh as never, dependencies);
  fresh.emit('message', JSON.stringify({ type: 'init', provider: 'codex', projectPath: directory, attachOnly: false }));
  return { directory, nativeId, dependencies, launches: () => launches };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 1000));

test('a fresh Codex Shell blocks its imported native thread without starting another writer', nativeProbeTest, async (t) => {
  const f = await freshShell(t);
  const imported = socket();
  handleShellConnection(imported as never, f.dependencies);
  imported.emit('message', JSON.stringify({ type: 'init', provider: 'codex', projectPath: f.directory,
    sessionId: 'indexed-fresh-app', hasSession: true, attachOnly: false }));
  await settle();
  assert.equal(f.launches(), 1, 'the imported history must retain the original Shell writer');
  assert.equal(hasActiveCodexShellSession('indexed-fresh-app', f.nativeId), true);
  assert.ok(imported.frames.some((frame) => frame.code === 'SHELL_SESSION_ACTIVE'));
});

test('fresh native discovery does not associate an unrelated history in the same directory', nativeProbeTest, async (t) => {
  const f = await freshShell(t);
  const unrelated = socket();
  handleShellConnection(unrelated as never, f.dependencies);
  unrelated.emit('message', JSON.stringify({ type: 'init', provider: 'codex', projectPath: f.directory,
    sessionId: 'unrelated-native-thread', hasSession: true, attachOnly: false }));
  await settle();
  assert.equal(f.launches(), 2, 'directory equality is not evidence that the native thread matches');
  assert.equal(hasActiveCodexShellSession('indexed-fresh-app', f.nativeId), true);
});


test('two sockets connecting a fresh null-ID destination retain one terminal', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-fresh-race-'));
  const exits: Array<() => void> = [];
  let launches = 0;
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => {
      launches += 1;
      return { onData() {}, onExit(listener: (event: { exitCode: number }) => void) { exits.push(() => listener({ exitCode: 0 })); },
        write() {}, resize() {}, kill() {} } as never;
    },
  };
  t.after(async () => { exits.forEach((exit) => exit()); await rm(directory, { recursive: true, force: true }); });
  const first = socket(); const second = socket();
  handleShellConnection(first as never, dependencies); handleShellConnection(second as never, dependencies);
  const init = JSON.stringify({ type: 'init', provider: 'codex', projectPath: directory, attachOnly: false });
  first.emit('message', init); second.emit('message', init);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches, 1, 'concurrent fresh Connect must not overwrite a live retained process');
});

test('a socket closed during native discovery never spawns a terminal later', nativeProbeTest, async (t) => {
  const f = await freshShell(t);
  const imported = socket();
  handleShellConnection(imported as never, f.dependencies);
  imported.emit('message', JSON.stringify({ type: 'init', provider: 'codex', projectPath: f.directory,
    sessionId: 'unrelated-native-thread', hasSession: true, attachOnly: false }));
  imported.emit('close');
  await settle();
  assert.equal(f.launches(), 1);
});


test('a residual native writer FD blocks only its thread until the child closes it', nativeProbeTest, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-residual-fd-'));
  const codexHome = path.join(directory, 'home');
  await mkdir(path.join(codexHome, 'thread-writer-locks'), { recursive: true });
  const nativeId = '01a1d85a-26f6-7131-930a-a5c3ecd144b9';
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const fd = fs.openSync(process.argv[1], 'w');
    process.stdout.write('ready');
    process.stdin.once('data', () => { fs.closeSync(fd); process.stdout.write('closed'); });
    setInterval(() => {}, 1000);
  `, path.join(codexHome, 'thread-writer-locks', nativeId + '.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exits: Array<() => void> = [];
  let launches = 0;
  t.after(async () => {
    exits.forEach((exit) => exit());
    const exited = once(child, 'exit'); child.kill(); await exited;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(directory, { recursive: true, force: true });
  });
  await once(child.stdout!, 'data');
  const dependencies = {
    resolveProviderSessionId: (id: string) => id,
    spawnPty: () => {
      launches += 1;
      return { onData() {}, onExit(listener: (event: { exitCode: number }) => void) { exits.push(() => listener({ exitCode: 0 })); },
        write() {}, resize() {}, kill() {} } as never;
    },
  };
  const target = socket(); const unrelated = socket();
  handleShellConnection(target as never, dependencies); handleShellConnection(unrelated as never, dependencies);
  const init = (id: string) => JSON.stringify({ type: 'init', provider: 'codex', projectPath: directory,
    sessionId: id, hasSession: true, attachOnly: false });
  target.emit('message', init(nativeId));
  await settle();
  assert.equal(launches, 0, 'Chat completion or abort does not prove its native writer descriptor closed');
  assert.ok(target.frames.some((frame) => frame.code === 'CHAT_SESSION_ACTIVE' && frame.retryable === true));
  unrelated.emit('message', init('other-native-history'));
  assert.equal(launches, 1, 'an open target descriptor must not reserve unrelated histories');
  const closed = once(child.stdout!, 'data'); child.stdin!.write('close'); await closed;
  target.emit('message', init(nativeId));
  await settle();
  assert.equal(launches, 2, 'the same live child process stops blocking once its exact descriptor closes');
});
