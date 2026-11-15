import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as database from '@/modules/database/index.js';
import type { CodexDesktopSubmission } from '@/shared/types.js';

// A new server instance must recover an uncertain delivery rather than enqueue it again.
test('desktop submission intent survives reconnect and duplicate request ids never overwrite it', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-submission-db-'));
  database.closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'state.db');
  await writeFile(process.env.DATABASE_PATH, '');
  try {
    await database.initializeDatabase();
    const repository = database.codexDesktopSubmissionsDb;
    assert.ok(repository, 'desktop submissions repository must persist intent before delivery');
    const intent: CodexDesktopSubmission = {
      requestId: 'request-1', appSessionId: 'app-1', nativeThreadId: 'native-1',
      text: 'hello', transcriptPath: '/tmp/native.jsonl', clientMessageId: 'client-1',
      state: 'uncertain', queueItemId: null, turnId: null, createdAt: 100, updatedAt: 100,
      transcriptOffset: 50, error: null,
    };
    assert.equal(repository.createIntent(intent), true);
    assert.equal(repository.createIntent({ ...intent, text: 'different', clientMessageId: 'duplicate' }), false);
    assert.equal(repository.getByRequestId('request-1')?.text, 'hello');
    repository.update('request-1', { state: 'queued', queueItemId: 'queue-1', updatedAt: 101 });
    database.closeConnection();
    assert.equal(repository.getActiveForSession('app-1')?.queueItemId, 'queue-1');
    assert.equal(repository.getActiveForSession('other-app'), null);
    assert.equal(repository.listActive().length, 1);
    repository.update('request-1', { state: 'completed', turnId: 'turn-1', updatedAt: 102 });
    assert.equal(repository.getActiveForSession('app-1'), null);
    assert.equal(repository.getByRequestId('request-1')?.turnId, 'turn-1');
  } finally {
    database.closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
