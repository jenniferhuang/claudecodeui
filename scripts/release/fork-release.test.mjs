import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { validateContext, validatePackage, validatePackedFiles, validateAssets, assertAbsent, publishRelease } from './fork-release.mjs';

const sha = 'a'.repeat(40);
const pkg = { name: '@cloudcli-ai/cloudcli', version: '1.37.8-jh.1', bin: { cloudcli: 'dist-server/server/modules/cli/cli.js' }, dependencies: { '@openai/codex': '0.169.0', '@openai/codex-sdk': '^0.169.0' } };
const lock = { name: pkg.name, version: pkg.version, packages: { '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies }, 'node_modules/@openai/codex': { version: '0.169.0' }, 'node_modules/@openai/codex-sdk': { version: '0.169.0' } } };
const context = { repository: 'jenniferhuang/claudecodeui', ref: 'refs/heads/main', eventName: 'workflow_dispatch', sha, expectedSha: sha, mainSha: sha };
const files = ['package.json', 'dist/index.html', 'dist/assets/app.js', 'dist/assets/app.css', 'dist-server/server/index.js', 'dist-server/server/modules/cli/cli.js', 'scripts/fix-node-pty.js', 'scripts/promote-dist-server.mjs', 'README.md'];
const checksum = (value) => createHash('sha256').update(value).digest('hex');

// A permissive ref/repo/SHA guard would let an unreviewed commit publish.
test('only the explicitly reviewed current main commit may publish', () => {
  assert.doesNotThrow(() => validateContext(context));
  for (const [field, value] of Object.entries({ repository: 'siteboon/claudecodeui', ref: 'refs/tags/v1.37.8', eventName: 'push', sha: 'b'.repeat(40), expectedSha: 'main; echo bad', mainSha: 'c'.repeat(40) })) {
    assert.throws(() => validateContext({ ...context, [field]: value }), undefined, field);
  }
});

test('fork version and lockfile must describe the unchanged npm package', () => {
  assert.equal(validatePackage(pkg, lock).tag, 'v1.37.8-jh.1');
  for (const version of ['1.37.8', '1.37.8-jh.01', '1.37.8-jh.1\n', '1.37.8;touch x', 'v1.37.8-jh.1']) {
    assert.throws(() => validatePackage({ ...pkg, version }, lock));
  }
  assert.throws(() => validatePackage({ ...pkg, name: '@jennifer/cloudcli' }, lock));
  assert.throws(() => validatePackage(pkg, { ...lock, version: '1.37.8' }));
  assert.throws(() => validatePackage(pkg, { ...lock, packages: { ...lock.packages, '': { ...lock.packages[''], dependencies: {} } } }));
  assert.throws(() => validatePackage(pkg, { ...lock, packages: { ...lock.packages, 'node_modules/@openai/codex-sdk': undefined } }));
});

test('tarball must include compiled CLI, server, frontend assets and install scripts', () => {
  assert.doesNotThrow(() => validatePackedFiles(files, pkg));
  for (const required of files) assert.throws(() => validatePackedFiles(files.filter((file) => file !== required), pkg), undefined, required);
  for (const forbidden of ['.env', 'server/.env', 'server/.env.production', '../secret', '/etc/passwd', 'node_modules/key', '.git/config']) {
    assert.throws(() => validatePackedFiles([...files, forbidden], pkg), undefined, forbidden);
  }
  assert.throws(() => validatePackedFiles(files, { ...pkg, bin: { cloudcli: 'server/source.ts' } }));
});

function assets() {
  const filename = 'cloudcli-ai-cloudcli-1.37.8-jh.1.tgz';
  const tarball = Buffer.from('tarball bytes');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, repository: context.repository, commit: sha, packageName: pkg.name, version: pkg.version, tag: `v${pkg.version}`, filename, sha256: checksum(tarball), dependencies: { '@openai/codex': { requested: '0.169.0', locked: '0.169.0' }, '@openai/codex-sdk': { requested: '^0.169.0', locked: '0.169.0' } } }));
  return { [filename]: tarball, 'release-manifest.json': manifest, 'SHA256SUMS': Buffer.from(`${checksum(tarball)}  ${filename}\n${checksum(manifest)}  release-manifest.json\n`) };
}

test('downloaded assets must match the exact source commit and both checksums', () => {
  const valid = assets();
  assert.equal(validateAssets(valid, pkg, lock, sha).filename, Object.keys(valid)[0]);
  assert.throws(() => validateAssets(valid, pkg, lock, 'd'.repeat(40)));
  assert.throws(() => validateAssets({ ...valid, extra: Buffer.from('unexpected') }, pkg, lock, sha));
  for (const name of Object.keys(valid)) {
    assert.throws(() => validateAssets({ ...valid, [name]: Buffer.from('corrupt') }, pkg, lock, sha), undefined, name);
  }
  const wrong = assets();
  const manifest = JSON.parse(wrong['release-manifest.json']);
  manifest.dependencies['@openai/codex-sdk'].locked = '0.166.0';
  wrong['release-manifest.json'] = Buffer.from(JSON.stringify(manifest));
  wrong.SHA256SUMS = Buffer.from(`${checksum(wrong[manifest.filename])}  ${manifest.filename}\n${checksum(wrong['release-manifest.json'])}  release-manifest.json\n`);
  assert.throws(() => validateAssets(wrong, pkg, lock, sha));
});

test('only a definitive 404 means an unused tag or release', async () => {
  await assert.doesNotReject(() => assertAbsent(async () => ({ status: 404 }), '/tag'));
  for (const status of [200, 401, 403, 429, 500]) await assert.rejects(() => assertAbsent(async () => ({ status }), '/tag'));
});

test('publication creates an exact commit tag, stages assets, then publishes once', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.endsWith('/git/ref/heads/main')) return { status: 200, data: { object: { sha } } };
    if (path.includes('/git/ref/tags/')) return { status: calls.some((call) => call.path.endsWith('/git/refs')) ? 200 : 404, data: { object: { sha } } };
    if (path.includes('/releases/tags/')) return { status: 404 };
    if (path.endsWith('/git/refs')) return { status: 201, data: { object: { sha } } };
    if (path.endsWith('/releases')) return { status: 201, data: { id: 7, upload_url: 'https://uploads.github.com/repos/jenniferhuang/claudecodeui/releases/7/assets{?name,label}' } };
    if (path.startsWith('https://uploads.github.com/')) return { status: 201, data: { name: new URL(path).searchParams.get('name'), size: options.body.length } };
    if (path.endsWith('/releases/7')) return { status: 200, data: { html_url: 'https://github.com/jenniferhuang/claudecodeui/releases/tag/v1.37.8-jh.1' } };
    throw Error(`Unexpected request ${path}`);
  };
  await publishRelease({ api, context, pkg, lock, assets: assets() });
  const mutations = calls.filter((call) => call.method);
  assert.deepEqual(mutations[0].body, { ref: 'refs/tags/v1.37.8-jh.1', sha });
  assert.equal(mutations[1].body.draft, true);
  assert.equal(mutations.at(-1).method, 'PATCH');
  assert.equal(mutations.at(-1).body.draft, false);
  assert.equal(mutations.filter((call) => call.method === 'POST' && call.path.startsWith('https://uploads.github.com/')).length, 3);
});

test('a collision, moving main or invalid asset prevents every write', async () => {
  for (const failure of ['collision', 'moved', 'asset']) {
    const writes = [];
    const api = async (path, options = {}) => {
      if (options.method) writes.push(path);
      if (path.endsWith('/git/ref/heads/main')) return { status: 200, data: { object: { sha: failure === 'moved' ? 'b'.repeat(40) : sha } } };
      return { status: failure === 'collision' ? 200 : 404 };
    };
    await assert.rejects(() => publishRelease({ api, context, pkg, lock, assets: failure === 'asset' ? {} : assets() }));
    assert.deepEqual(writes, []);
  }
});

test('even matching package and lock versions reject trailing newlines', () => {
  const version = `${pkg.version}\n`;
  const alteredLock = { ...lock, version, packages: { ...lock.packages, '': { ...lock.packages[''], version } } };
  assert.throws(() => validatePackage({ ...pkg, version }, alteredLock));
});

test('failed asset uploads and main changing during upload never publish a partial release', async () => {
  for (const failure of ['upload', 'main']) {
    let mainReads = 0;
    let tagCreated = false;
    const writes = [];
    const api = async (endpoint, options = {}) => {
      if (options.method) writes.push(options.method);
      if (endpoint.endsWith('/git/ref/heads/main')) return { status: 200, data: { object: { sha: ++mainReads > 1 && failure === 'main' ? 'b'.repeat(40) : sha } } };
      if (endpoint.includes('/git/ref/tags/')) return { status: tagCreated ? 200 : 404, data: { object: { sha } } };
      if (endpoint.includes('/releases/tags/')) return { status: 404 };
      if (endpoint.endsWith('/git/refs')) { tagCreated = true; return { status: 201 }; }
      if (endpoint.endsWith('/releases')) return { status: 201, data: { id: 9, upload_url: 'https://uploads.github.com/repos/jenniferhuang/claudecodeui/releases/9/assets{?name}' } };
      if (endpoint.startsWith('https://uploads.github.com/')) return { status: failure === 'upload' ? 500 : 201, data: { name: new URL(endpoint).searchParams.get('name'), size: options.body.length } };
      throw Error(`Unexpected request ${endpoint}`);
    };
    await assert.rejects(() => publishRelease({ api, context, pkg, lock, assets: assets() }));
    assert.equal(tagCreated, true);
    assert(!writes.includes('PATCH'), 'The draft must remain unpublished');
  }
});
