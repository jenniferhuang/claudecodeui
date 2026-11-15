import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';

test('native queue helper opts into experimental RPC and never resumes or starts the target', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-queue-rpc-'));
  const log = path.join(directory, 'requests.jsonl');
  const launcher = path.join(directory, 'fake.cjs');
  await writeFile(launcher, `
const fs = require('node:fs');
const readline = require('node:readline');
setTimeout(() => process.exit(1), 5000).unref();
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, line+'\\n');
  if (!request.id) return;
  let result = {};
  if (request.method === 'thread/queue/add') result = {queuedSubmission:{id:'queue-1',clientUserMessageId:request.params.clientUserMessageId}};
  if (request.method === 'thread/queue/list') result = {data:[{id:'queue-1',clientUserMessageId:'client-1'}],nextCursor:null};
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});`);
  const original = codexAppServer.resolveLauncher;
  codexAppServer.resolveLauncher = () => launcher;
  try {
    assert.equal(typeof codexAppServer.queueAdd, 'function', 'queue RPC must be supported without starting the thread');
    const added = await codexAppServer.queueAdd({ threadId: 'native-1', clientMessageId: 'client-1', text: 'hello' });
    assert.deepEqual(added, { id: 'queue-1', clientMessageId: 'client-1' });
    assert.deepEqual(await codexAppServer.queueList('native-1'), [{ id: 'queue-1', clientMessageId: 'client-1' }]);
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(requests.filter(request => request.method === 'initialize').every(request => request.params.capabilities.experimentalApi === true));
    assert.deepEqual(requests.filter(request => request.method.startsWith('thread/')).map(request => request.method), ['thread/queue/add', 'thread/queue/list']);
  } finally {
    codexAppServer.resolveLauncher = original;
    await rm(directory, { recursive: true, force: true });
  }
});
