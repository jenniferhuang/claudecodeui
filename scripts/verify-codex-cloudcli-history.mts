import assert from 'node:assert/strict';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Invoked only by the offline handoff fixture, in a separate process so every
// provider reads the throwaway HOME rather than the server user's live history.
const root = process.env.CLOUDCLI_OFFLINE_FIXTURE_ROOT;
assert.ok(root && path.basename(root).startsWith('cloudcli-offline-history-'));
assert.equal(os.homedir(), root);
assert.equal(process.env.CODEX_HOME, path.join(root, '.codex'));
assert.equal(process.env.DATABASE_PATH, path.join(root, 'cloudcli-fixture.db'));
const [threadId, siblingId, phase] = process.argv.slice(2);
assert.ok(threadId && siblingId && ['before-shell', 'after-sdk'].includes(phase));

const { initializeDatabase, closeConnection, sessionsDb } = await import('../server/modules/database/index.js');
const { getProjectsWithSessions } = await import('../server/modules/projects/index.js');
const { sessionsService } = await import('../server/modules/providers/index.js');

try {
  await initializeDatabase();
  const unrelatedId = 'offline-unrelated-claude';
  if (!sessionsDb.getSessionById(unrelatedId)) {
    sessionsDb.createAppSession(unrelatedId, 'claude', root, 'Unrelated provider');
    // Use an existing native-backed session: startup migration backfills null
    // provider IDs on never-run placeholder rows, independently of handoff.
    sessionsDb.assignProviderSessionId(unrelatedId, 'offline-native-claude');
  }
  const unrelatedBefore = sessionsDb.getSessionById(unrelatedId);
  const projects = await getProjectsWithSessions();
  const project = projects.find((entry) => entry.fullPath === root);
  assert.ok(project, 'The project API service must expose the newly created native project');
  for (const id of [threadId, siblingId]) {
    assert.equal(project.sessions.filter((session) => session.id === id).length, 1);
    const row = sessionsDb.getSessionById(id);
    assert.equal(row?.provider, 'codex');
    assert.equal(row?.provider_session_id, id);
    assert.ok(row?.jsonl_path?.startsWith(path.join(root, '.codex', 'sessions') + path.sep));
  }
  const history = await sessionsService.fetchHistory(threadId);
  const sibling = await sessionsService.fetchHistory(siblingId);
  assert.match(JSON.stringify(history.messages), /CloudCLI offline history marker/);
  assert.match(JSON.stringify(sibling.messages), /CloudCLI independent sibling marker/);
  assert.doesNotMatch(JSON.stringify(sibling.messages), /CloudCLI SDK handoff marker/);
  if (phase === 'after-sdk') assert.match(JSON.stringify(history.messages), /CloudCLI SDK handoff marker/);
  assert.deepEqual(sessionsDb.getSessionById(unrelatedId), unrelatedBefore);
  const siblingPath = sessionsDb.getSessionById(siblingId)?.jsonl_path;
  assert.ok(siblingPath);
  const snapshot = {
    siblingSha256: createHash('sha256').update(await readFile(siblingPath)).digest('hex'),
    unrelatedRow: sessionsDb.getSessionById(unrelatedId),
  };
  const baselinePath = path.join(root, 'cloudcli-preservation-baseline.json');
  if (phase === 'before-shell') {
    await writeFile(baselinePath, JSON.stringify(snapshot));
  } else {
    assert.deepEqual(snapshot, JSON.parse(await readFile(baselinePath, 'utf8')),
      'The sibling transcript bytes and unrelated provider row must survive the handoff unchanged');
  }
  console.log('CLOUDCLI_HISTORY_CHECK ' + JSON.stringify({ phase, discovered: true, history_readable: true, sibling_unchanged: true, unrelated_provider_row_preserved: true }));
} finally {
  closeConnection();
}
