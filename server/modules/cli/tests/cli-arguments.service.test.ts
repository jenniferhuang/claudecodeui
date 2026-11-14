import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCliArguments } from '../cli-arguments.service.js';

test('the bootstrap parser and command service share database and port flag semantics', () => {
  assert.deepEqual(parseCliArguments(['start', '--database-path', '/data/custom auth.db', '-p', '8080']), {
    command: 'start', options: { databasePath: '/data/custom auth.db', serverPort: '8080' }, remainingArguments: [],
  });
  assert.deepEqual(parseCliArguments(['--database-path=/data/first.db', '--port=8081', '--database-path=/data/final.db', 'status']), {
    command: 'status', options: { databasePath: '/data/final.db', serverPort: '8081' }, remainingArguments: [],
  });
});

test('sandbox arguments never become database or port settings for the CloudCLI bootstrap', () => {
  assert.deepEqual(parseCliArguments(['--database-path=/data/cloudcli.db', 'sandbox', '--database-path=/data/guest.db', '--port=9000', 'project']), {
    command: 'sandbox', options: { databasePath: '/data/cloudcli.db' },
    remainingArguments: ['--database-path=/data/guest.db', '--port=9000', 'project'],
  });
});
