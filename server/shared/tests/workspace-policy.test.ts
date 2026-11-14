import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const utilsUrl = new URL('../utils.ts', import.meta.url).href;

function runPolicyProbe(environment: NodeJS.ProcessEnv, candidates: string[]) {
  const env = { ...process.env };
  for (const key of ['CLOUDCLI_WRITE_ROOTS', 'CLOUDCLI_READ_ROOTS', 'WORKSPACES_ALLOWED_ROOTS', 'WORKSPACES_ROOT']) delete env[key];
  Object.assign(env, environment, { TSX_TSCONFIG_PATH: path.resolve('server/tsconfig.json') });
  const script = `
    const { validateWorkspacePath, resolveReadOnlyRootPath, resolvePathUnderRoots } = await import(${JSON.stringify(utilsUrl)});
    const paths = ${JSON.stringify(candidates)};
    console.log(JSON.stringify({
      writable: await Promise.all(paths.map(validateWorkspacePath)),
      readable: await Promise.all(paths.map(resolveReadOnlyRootPath)),
      rootReadable: await resolvePathUnderRoots(paths[0], [${JSON.stringify(path.parse(testDirectory).root)}]),
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env, encoding: 'utf8', stdio: 'pipe' }));
}

test('managed workspace roots permit both selected folders while reads do not grant writes', async () => {
  const fixture = await realpath(await mkdtemp(path.join(testDirectory, 'workspace-policy-fixture-')));
  const primary = path.join(fixture, 'primary');
  const extra = path.join(fixture, '.agent-project');
  const outside = path.join(fixture, 'outside');
  const alias = path.join(fixture, 'legacy-primary');
  try {
    for (const root of [primary, extra, outside]) await mkdir(root);
    await writeFile(path.join(outside, 'review.txt'), 'review only');
    await symlink(primary, alias);
    await symlink(outside, path.join(primary, 'escape'));
    await symlink(path.join(outside, 'future.txt'), path.join(primary, 'dangling-escape'));
    const candidates = [primary, extra, alias, path.join(extra, 'new', 'nested', 'file.txt'), outside, path.join(primary, 'escape', 'new', 'file.txt'), primary + '-sibling', path.join(primary, 'dangling-escape')];
    const result = runPolicyProbe({
      WORKSPACES_ROOT: primary,
      WORKSPACES_ALLOWED_ROOTS: JSON.stringify([outside]),
      CLOUDCLI_WRITE_ROOTS: JSON.stringify([primary, extra]),
      CLOUDCLI_READ_ROOTS: JSON.stringify([path.parse(fixture).root]),
    }, candidates);
    assert.deepEqual(result.writable.map((entry: { valid: boolean }) => entry.valid), [true, true, true, true, false, false, false, false]);
    assert.equal(result.readable[4], outside);
    assert.equal(result.rootReadable, primary);
    assert.equal(result.writable[2].resolvedPath, primary);
    assert.equal(result.writable[3].resolvedPath, path.join(extra, 'new', 'nested', 'file.txt'));

    const legacy = runPolicyProbe({ WORKSPACES_ROOT: primary, WORKSPACES_ALLOWED_ROOTS: JSON.stringify([extra]) }, [primary, extra, outside]);
    assert.deepEqual(legacy.writable.map((entry: { valid: boolean }) => entry.valid), [true, true, false]);
    const single = runPolicyProbe({ WORKSPACES_ROOT: primary }, [primary, extra]);
    assert.deepEqual(single.writable.map((entry: { valid: boolean }) => entry.valid), [true, false]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('malformed and empty managed writable-root settings fail closed', () => {
  for (const configured of ['not JSON', '[]', '["relative/path"]']) {
    assert.throws(() => runPolicyProbe({ CLOUDCLI_WRITE_ROOTS: configured }, [testDirectory]), /CLOUDCLI_WRITE_ROOTS must be a JSON array/);
  }
});
