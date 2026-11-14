import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { initializeFilesystemPolicy } from '../index.js';

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli.policy-bootstrap-'));
  const homeDirectory = fs.realpathSync(directory);
  const configPath = path.join(homeDirectory, '.config', 'cloudcli', 'filesystem-policy.json');
  const first = path.join(homeDirectory, 'projects', 'first edit');
  const second = path.join(homeDirectory, '.second');
  const review = path.join(homeDirectory, 'review');
  for (const root of [path.dirname(configPath), first, second, review]) fs.mkdirSync(root, { recursive: true });
  return {
    homeDirectory, configPath, first, second, review,
    writeConfig(value: unknown = { version: 1, writableRoots: [first, second] }) {
      fs.writeFileSync(configPath, JSON.stringify(value));
    },
    cleanup() { fs.rmSync(homeDirectory, { recursive: true, force: true }); },
  };
}

test('missing optional default policy leaves the server environment and filesystem unchanged', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const environment = { EXISTING_SETTING: 'unchanged' };
  let launched = false;
  await initializeFilesystemPolicy({
    environment, homeDirectory: fixture.homeDirectory, platform: 'linux',
    launch: () => { launched = true; },
  });
  assert.equal(launched, false);
  assert.deepEqual(environment, { EXISTING_SETTING: 'unchanged' });
  assert.equal(fs.existsSync(path.join(fixture.homeDirectory, '.cloudcli')), false);
});

test('explicitly missing, malformed and unsupported policies fail closed', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const options = { homeDirectory: fixture.homeDirectory, platform: 'darwin' as const, launch: () => { throw new Error('must not launch'); } };
  await assert.rejects(initializeFilesystemPolicy({ ...options, environment: { CLOUDCLI_FILESYSTEM_POLICY: '/missing/cloudcli-policy.json' } }), /Unable to load/);
  await assert.rejects(initializeFilesystemPolicy({ ...options, environment: { CLOUDCLI_FILESYSTEM_POLICY: 'relative.json' } }), /absolute/);
  for (const [config, expected] of [
    [{ version: 2, writableRoots: [fixture.first] }, /version/],
    [{ version: 1, writableRoots: [] }, /nonempty/],
    [{ version: 1, writableRoots: ['relative'] }, /absolute/],
    [{ version: 1, writableRoots: ['/'] }, /below the filesystem root/],
    [{ version: 1, writableRoots: [fixture.first], runtimeDirectory: fixture.review }, /runtimeDirectory/],
  ] as const) {
    fixture.writeConfig(config);
    await assert.rejects(initializeFilesystemPolicy({ ...options, environment: {} }), expected);
  }
  fs.writeFileSync(fixture.configPath, 'not-json');
  await assert.rejects(initializeFilesystemPolicy({ ...options, environment: {} }), SyntaxError);
  fixture.writeConfig();
  await assert.rejects(initializeFilesystemPolicy({ ...options, environment: {}, platform: 'linux' }), /requires macOS/);
  assert.equal(fs.existsSync(path.join(fixture.homeDirectory, '.cloudcli')), false);
});

test('canonical roots and runtime paths are passed to the replacement without changing the parent', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const alias = path.join(fixture.homeDirectory, 'old-first');
  fs.symlinkSync(fixture.first, alias);
  fixture.writeConfig({ version: 1, writableRoots: [alias, fixture.second, fixture.first] });
  const environment = { DATABASE_PATH: path.join(fixture.homeDirectory, 'explicit-auth.db') };
  let capture: { profilePath: string; environment: NodeJS.ProcessEnv } | undefined;
  await initializeFilesystemPolicy({
    environment, homeDirectory: fixture.homeDirectory, platform: 'darwin',
    launch: (profilePath, childEnvironment) => { capture = { profilePath, environment: childEnvironment }; },
  });
  assert.ok(capture);
  assert.deepEqual(JSON.parse(capture.environment.CLOUDCLI_WRITE_ROOTS!), [fixture.first, fixture.second]);
  assert.equal(capture.environment.CLOUDCLI_READ_ROOTS, '["/"]');
  assert.equal(capture.environment.WORKSPACES_ROOT, fixture.first);
  assert.equal(capture.environment.WORKSPACES_ALLOWED_ROOTS, JSON.stringify([fixture.second]));
  assert.equal(capture.environment.CLOUDCLI_PROCESS_SANDBOX, '1');
  assert.equal(capture.environment.TMPDIR, path.join(fixture.homeDirectory, '.cloudcli', 'runtime', 'tmp'));
  assert.equal(capture.environment.XDG_STATE_HOME, path.join(fixture.homeDirectory, '.cloudcli', 'runtime', 'state'));
  assert.equal(capture.environment.HISTFILE, path.join(fixture.homeDirectory, '.cloudcli', 'runtime', 'shell-history'));
  assert.equal(fs.statSync(capture.profilePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(capture.environment.TMPDIR!).isDirectory(), true);
  const profile = fs.readFileSync(capture.profilePath, 'utf8');
  assert.ok(profile.includes('(deny job-creation)'));
  assert.ok(profile.includes('(deny lsopen)'));
  assert.ok(profile.includes('(deny appleevent-send)'));
  assert.ok(profile.includes(`(subpath ${JSON.stringify(fixture.first)})`));
  assert.ok(profile.includes(`(literal ${JSON.stringify(environment.DATABASE_PATH)})`));
  assert.ok(profile.includes(`(literal ${JSON.stringify(`${environment.DATABASE_PATH}-wal`)})`));
  assert.deepEqual(environment, { DATABASE_PATH: path.join(fixture.homeDirectory, 'explicit-auth.db') });
});

test('policy data cannot live inside writable project or operational locations', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const config = path.join(fixture.first, 'policy.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, writableRoots: [fixture.first, fixture.second] }));
  await assert.rejects(initializeFilesystemPolicy({
    environment: { CLOUDCLI_FILESYSTEM_POLICY: config },
    homeDirectory: fixture.homeDirectory, platform: 'darwin', launch: () => undefined,
  }), /outside writable/);
  fixture.writeConfig();
  await assert.rejects(initializeFilesystemPolicy({
    environment: { CLOUDCLI_PROCESS_SANDBOX: '1', CLOUDCLI_SANDBOX_PROFILE: '/different/profile.sb' },
    homeDirectory: fixture.homeDirectory, platform: 'darwin', launch: () => undefined,
  }), /does not match/);
});

test('an editable policy symlink or editable parent alias cannot select the next-start policy', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  fixture.writeConfig();
  const editableLink = path.join(fixture.first, 'policy.json');
  fs.symlinkSync(fixture.configPath, editableLink);
  const parentAlias = path.join(fixture.homeDirectory, 'readonly-looking-parent');
  fs.symlinkSync(fixture.first, parentAlias);
  const lockedDirectoryLink = path.join(fixture.first, 'locked-policy-directory');
  fs.symlinkSync(path.dirname(fixture.configPath), lockedDirectoryLink);
  const hiddenTargetChain = path.join(fixture.homeDirectory, 'readonly-looking-target-chain');
  fs.symlinkSync(lockedDirectoryLink, hiddenTargetChain);
  const relativeTargetChain = path.join(fixture.homeDirectory, 'readonly-looking-relative-chain');
  fs.symlinkSync(path.relative(fixture.homeDirectory, lockedDirectoryLink), relativeTargetChain);
  let launches = 0;
  for (const entry of [
    editableLink,
    path.join(parentAlias, 'policy.json'),
    path.join(parentAlias, 'locked-policy-directory', path.basename(fixture.configPath)),
    path.join(hiddenTargetChain, path.basename(fixture.configPath)),
    path.join(relativeTargetChain, path.basename(fixture.configPath)),
  ]) {
    await assert.rejects(initializeFilesystemPolicy({
      environment: { CLOUDCLI_FILESYSTEM_POLICY: entry }, homeDirectory: fixture.homeDirectory,
      platform: 'darwin', launch: () => { launches += 1; },
    }), /outside writable/);
  }
  assert.equal(launches, 0);

  const safeLink = path.join(fixture.homeDirectory, 'readonly-policy.json');
  fs.symlinkSync(fixture.configPath, safeLink);
  let capture: { profilePath: string; environment: NodeJS.ProcessEnv } | undefined;
  await initializeFilesystemPolicy({
    environment: { CLOUDCLI_FILESYSTEM_POLICY: safeLink }, homeDirectory: fixture.homeDirectory,
    platform: 'darwin', launch: (profilePath, environment) => { capture = { profilePath, environment }; },
  });
  assert.ok(capture);
  assert.equal(capture.environment.CLOUDCLI_FILESYSTEM_POLICY, safeLink);
  assert.ok(fs.readFileSync(capture.profilePath, 'utf8').includes(`(literal ${JSON.stringify(safeLink)})`));
});

test('relative policy links resolve parent segments physically and cyclic links fail closed', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  fixture.writeConfig();
  const safeDirectory = path.join(fixture.homeDirectory, 'readonly-links');
  fs.mkdirSync(safeDirectory);
  const safeAlias = path.join(safeDirectory, 'policy.json');
  fs.symlinkSync(path.relative(safeDirectory, fixture.configPath), safeAlias);
  let launches = 0;
  await assert.doesNotReject(initializeFilesystemPolicy({
    environment: { CLOUDCLI_FILESYSTEM_POLICY: safeAlias }, homeDirectory: fixture.homeDirectory,
    platform: 'darwin', launch: () => { launches += 1; },
  }));
  const loopA = path.join(safeDirectory, 'loop-a');
  const loopB = path.join(safeDirectory, 'loop-b');
  fs.symlinkSync('loop-b', loopA);
  fs.symlinkSync('loop-a', loopB);
  await assert.rejects(initializeFilesystemPolicy({
    environment: { CLOUDCLI_FILESYSTEM_POLICY: loopA }, homeDirectory: fixture.homeDirectory,
    platform: 'darwin', launch: () => { launches += 1; },
  }), /Too many symbolic links/);
  assert.equal(launches, 1);
});

test('runtime filename exceptions cannot serve as mutable policy selectors', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  fixture.writeConfig();
  let launches = 0;
  for (const relative of ['.cloudcli/claude-shell-theme-light.json', '.codex/state_5.sqlite']) {
    const alias = path.join(fixture.homeDirectory, relative);
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(fixture.configPath, alias);
    await assert.rejects(initializeFilesystemPolicy({
      environment: { CLOUDCLI_FILESYSTEM_POLICY: alias }, homeDirectory: fixture.homeDirectory,
      platform: 'darwin', launch: () => { launches += 1; },
    }), /outside writable/);
  }
  assert.equal(launches, 0);
});

test('services sharing a JSON policy keep distinct profiles for distinct database grants', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  fixture.writeConfig();
  const captures: Array<{ profilePath: string; environment: NodeJS.ProcessEnv }> = [];
  const launch = (profilePath: string, environment: NodeJS.ProcessEnv) => { captures.push({ profilePath, environment }); };
  await initializeFilesystemPolicy({
    environment: { DATABASE_PATH: path.join(fixture.homeDirectory, 'first-auth.db') },
    homeDirectory: fixture.homeDirectory, platform: 'darwin', launch,
  });
  const firstProfile = fs.readFileSync(captures[0].profilePath, 'utf8');
  await initializeFilesystemPolicy({
    environment: { DATABASE_PATH: path.join(fixture.homeDirectory, 'second-auth.db') },
    homeDirectory: fixture.homeDirectory, platform: 'darwin', launch,
  });
  assert.notEqual(captures[0].profilePath, captures[1].profilePath);
  assert.equal(fs.readFileSync(captures[0].profilePath, 'utf8'), firstProfile);
  await assert.rejects(initializeFilesystemPolicy({
    environment: captures[0].environment, homeDirectory: fixture.homeDirectory, platform: 'darwin',
  }), /marker is set/); // Content attestation succeeds; this test parent is intentionally not sandboxed.
});

test('state symlinks cannot grant writes to an otherwise review-only location on restart', async (t) => {
  for (const stateDirectory of ['.codex/sessions', '.cloudcli/assets']) {
    const fixture = createFixture();
    t.after(() => fixture.cleanup());
    fixture.writeConfig();
    const statePath = path.join(fixture.homeDirectory, stateDirectory);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.symlinkSync(fixture.review, statePath);
    await assert.rejects(initializeFilesystemPolicy({
      environment: {}, homeDirectory: fixture.homeDirectory, platform: 'darwin', launch: () => undefined,
    }), /state path resolves through a symlink/);
    fs.unlinkSync(statePath);
    fs.symlinkSync(fixture.first, statePath);
    await assert.doesNotReject(initializeFilesystemPolicy({
      environment: {}, homeDirectory: fixture.homeDirectory, platform: 'darwin', launch: () => undefined,
    }));
  }
});

test('auth and database symlinks cannot turn an unrelated document into writable runtime state', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  fixture.writeConfig();
  const document = path.join(fixture.review, 'invoice.txt');
  fs.writeFileSync(document, 'review only');
  for (const stateFile of ['.cloudcli/auth.db', '.codex/auth.json']) {
    const statePath = path.join(fixture.homeDirectory, stateFile);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.symlinkSync(document, statePath);
    await assert.rejects(initializeFilesystemPolicy({
      environment: {}, homeDirectory: fixture.homeDirectory, platform: 'darwin', launch: () => undefined,
    }), /state path resolves through a symlink/);
    fs.unlinkSync(statePath);
  }
  const databaseAlias = path.join(fixture.homeDirectory, 'configured-db');
  fs.symlinkSync(document, databaseAlias);
  await assert.rejects(initializeFilesystemPolicy({
    environment: { DATABASE_PATH: databaseAlias }, homeDirectory: fixture.homeDirectory,
    platform: 'darwin', launch: () => undefined,
  }), /state path resolves through a symlink/);
  assert.equal(fs.readFileSync(document, 'utf8'), 'review only');
});

test('native macOS policy and inherited bootstrap permit edits only in project and runtime paths', { skip: process.platform !== 'darwin' }, async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  fixture.writeConfig();
  fs.mkdirSync(path.join(fixture.homeDirectory, '.codex'));
  const reviewFile = path.join(fixture.review, 'review.txt');
  fs.writeFileSync(reviewFile, 'unchanged');
  fs.symlinkSync(fixture.review, path.join(fixture.first, 'escape'));
  const safePolicyAlias = path.join(fixture.homeDirectory, 'readonly-policy.json');
  fs.symlinkSync(fixture.configPath, safePolicyAlias);
  let capture: { profilePath: string; environment: NodeJS.ProcessEnv } | undefined;
  await initializeFilesystemPolicy({
    environment: { ...process.env, CLOUDCLI_FILESYSTEM_POLICY: safePolicyAlias }, homeDirectory: fixture.homeDirectory,
    launch: (profilePath, environment) => { capture = { profilePath, environment }; },
  });
  assert.ok(capture);
  const script = `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
    const [first, second, review, home, config] = process.argv.slice(1);
    assert.equal(fs.readFileSync(path.join(review, 'review.txt'), 'utf8'), 'unchanged');
    for (const root of [first, second]) {
      fs.writeFileSync(path.join(root, 'edit.txt'), 'editable');
      fs.unlinkSync(path.join(root, 'edit.txt'));
    }
    fs.writeFileSync(path.join(home, '.codex', 'state_5.sqlite'), 'runtime');
    fs.writeFileSync(path.join(home, '.claude.json.tmp'), 'runtime');
    for (const action of [
      () => fs.writeFileSync(path.join(review, 'review.txt'), 'changed'),
      () => fs.writeFileSync(path.join(review, 'new.txt'), 'changed'),
      () => fs.unlinkSync(path.join(review, 'review.txt')),
      () => fs.renameSync(path.join(review, 'review.txt'), path.join(first, 'moved.txt')),
      () => fs.chmodSync(path.join(review, 'review.txt'), 0o777),
      () => fs.writeFileSync(path.join(first, 'escape', 'review.txt'), 'changed'),
      () => fs.linkSync(path.join(review, 'review.txt'), path.join(first, 'linked.txt')),
      () => fs.writeFileSync(config, 'changed'),
      () => fs.writeFileSync(path.join(home, '.cloudcli', 'unrelated-worktree.txt'), 'changed'),
    ]) assert.throws(action, /EPERM|EACCES/);
    console.log('native filesystem policy passed');
  `;
  const native = spawnSync('/usr/bin/sandbox-exec', [
    '-f', capture.profilePath, process.execPath, '-e', script,
    fixture.first, fixture.second, fixture.review, fixture.homeDirectory, fixture.configPath,
  ], { encoding: 'utf8', env: capture.environment, timeout: 15_000 });
  assert.equal(native.status, 0, native.stderr || native.stdout);
  assert.equal(fs.readFileSync(reviewFile, 'utf8'), 'unchanged');

  const moduleUrl = pathToFileURL(path.resolve('server/modules/filesystem-policy/index.ts')).href;
  const inherited = spawnSync('/usr/bin/sandbox-exec', [
    '-f', capture.profilePath, process.execPath,
    '--import', path.resolve('node_modules/tsx/dist/esm/index.mjs'),
    '--input-type=module', '-e',
    `import { initializeFilesystemPolicy } from ${JSON.stringify(moduleUrl)}; await initializeFilesystemPolicy({ homeDirectory: ${JSON.stringify(fixture.homeDirectory)} }); console.log('inherited bootstrap passed');`,
  ], { encoding: 'utf8', env: capture.environment, timeout: 15_000 });
  assert.equal(inherited.status, 0, inherited.stderr || inherited.stdout);
  assert.match(inherited.stdout, /inherited bootstrap passed/);

  await assert.rejects(initializeFilesystemPolicy({
    environment: capture.environment, homeDirectory: fixture.homeDirectory,
  }), /marker is set/);
});
