import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { createWebSocketServer } from '@/modules/websocket/services/websocket-server.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { ProviderRuntimeWriter } from '@/shared/types.js';

function socket() {
  const ws = new EventEmitter() as EventEmitter & {
    readyState: number; frames: Array<Record<string, unknown>>; send: (value: string) => void;
  };
  ws.readyState = 1;
  ws.frames = [];
  ws.send = (value) => ws.frames.push(JSON.parse(value));
  return ws;
}

test('gateway waits for Codex runtime exit after a complete event and protects native-id aliases/background work', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-shell-gateway-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const http = createServer(); // No port or live service is opened.
  const chat = socket();
  const shell = socket();
  let release: () => void = () => {};
  const exit = new Promise<void>((resolve) => { release = resolve; });
  let backgroundWork = false;
  let launches = 0;
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  const gateway = createWebSocketServer(http, {
    verifyClient: { isPlatform: false, authenticateWebSocket: () => ({ id: 1 }) },
    chat: { runtime: {
      hasRuntime: () => true,
      hasBackgroundWork: (id: string) => backgroundWork && id === 'gateway-app',
      run: async (_provider: string, _command: string, _options: unknown, writer: ProviderRuntimeWriter) => {
        writer.send({ kind: 'complete', provider: 'codex', sessionId: 'gateway-app', exitCode: 0 });
        await exit;
      },
    } as never },
    shell: {
      resolveProviderSessionId: () => 'gateway-native',
      spawnPty: () => {
        launches += 1;
        return { onData: () => ({ dispose() {} }), onExit: (listener: typeof onExit) => { onExit = listener; },
          kill() {}, write() {}, resize() {} } as never;
      },
    },
    getPluginPort: () => null,
  });
  try {
    sessionsDb.createAppSession('gateway-app', 'codex', directory);
    sessionsDb.assignProviderSessionId('gateway-app', 'gateway-native');
    gateway.emit('connection', chat, { url: '/ws', user: { id: 1 } });
    gateway.emit('connection', shell, { url: '/shell', user: { id: 1 } });
    chat.emit('message', JSON.stringify({ type: 'chat.send', sessionId: 'gateway-app', content: 'hello' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chatRunRegistry.getRun('gateway-app')?.status, 'completed');
    const init = JSON.stringify({ type: 'init', projectPath: directory, sessionId: 'gateway-native',
      provider: 'codex', hasSession: true, attachOnly: false });
    shell.emit('message', init);
    assert.equal(launches, 0, 'a complete event does not prove the runtime released its writer');
    assert.equal(shell.frames.at(-1)?.code, 'CHAT_SESSION_ACTIVE');
    backgroundWork = true;
    release();
    await new Promise((resolve) => setImmediate(resolve));
    shell.emit('message', init);
    assert.equal(launches, 0, 'native aliases must also respect Chat background work');
    backgroundWork = false;
    shell.emit('message', init);
    assert.equal(launches, 1);
  } finally {
    release();
    await new Promise((resolve) => setImmediate(resolve));
    onExit?.({ exitCode: 0 });
    chat.emit('close');
    shell.emit('close');
    gateway.close();
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});
