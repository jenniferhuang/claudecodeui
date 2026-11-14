#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'jenniferhuang/claudecodeui';
const PACKAGE = '@cloudcli-ai/cloudcli';
const CLI = 'dist-server/server/modules/cli/cli.js';
const DEPENDENCIES = ['@openai/codex', '@openai/codex-sdk'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (filename) => JSON.parse(fs.readFileSync(filename, 'utf8'));
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL', ...options });

export function validateContext(context) {
  assert.equal(context.repository, REPOSITORY, 'Only the approved fork can publish');
  assert.equal(context.ref, 'refs/heads/main', 'Select the main branch');
  assert.equal(context.eventName, 'workflow_dispatch', 'Publication must be manually dispatched');
  assert.equal(context.expectedSha?.length, 40, 'Expected SHA must contain exactly 40 characters');
  assert.match(context.expectedSha ?? '', /^[a-f0-9]{40}$/, 'Supply an exact lowercase 40-character expected main SHA');
  assert.equal(context.sha, context.expectedSha, 'Workflow SHA differs from the reviewed commit');
  assert.equal(context.mainSha, context.expectedSha, 'Main moved; review the new commit and dispatch again');
}

export function validatePackage(pkg, lock) {
  assert.equal(pkg.name, PACKAGE, 'Preserve the original package name');
  assert.equal(pkg.version, pkg.version.trim(), 'Version must not contain surrounding whitespace');
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-jh\.(0|[1-9]\d*)$/, 'Commit a canonical fork version such as 1.37.8-jh.1');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version, 'Lockfile version differs');
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  const dependencies = {};
  for (const name of DEPENDENCIES) {
    assert.equal(typeof pkg.dependencies?.[name], 'string', `${name} must be a runtime dependency`);
    assert.equal(lock.packages[''].dependencies?.[name], pkg.dependencies[name], `${name} lockfile declaration differs`);
    const locked = lock.packages[`node_modules/${name}`]?.version;
    assert.match(locked ?? '', /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/, `${name} must have a locked version`);
    dependencies[name] = { requested: pkg.dependencies[name], locked };
  }
  return { tag: `v${pkg.version}`, filename: `cloudcli-ai-cloudcli-${pkg.version}.tgz`, dependencies };
}

export function validatePackedFiles(files, pkg) {
  assert.equal(pkg.bin?.cloudcli, CLI, 'The cloudcli executable must use the compiled CLI');
  for (const file of files) {
    assert(!path.posix.isAbsolute(file) && !file.split('/').some((part) => ['..', '.git', 'node_modules'].includes(part) || part.startsWith('.env')), `Unsafe packed file: ${file}`);
  }
  for (const required of ['package.json', 'dist/index.html', 'dist-server/server/index.js', CLI, 'scripts/fix-node-pty.js', 'scripts/promote-dist-server.mjs', 'README.md']) {
    assert(files.includes(required), `Missing package file: ${required}`);
  }
  for (const extension of ['js', 'css']) assert(files.some((file) => file.startsWith('dist/assets/') && file.endsWith(`.${extension}`)), `Missing frontend ${extension} assets`);
}

export function validateAssets(assets, pkg, lock, sha) {
  const expected = validatePackage(pkg, lock);
  assert.deepEqual(Object.keys(assets).sort(), [expected.filename, 'release-manifest.json', 'SHA256SUMS'].sort(), 'Unexpected or missing release asset');
  const manifest = JSON.parse(assets['release-manifest.json'].toString());
  for (const [key, value] of Object.entries({ schemaVersion: 1, repository: REPOSITORY, commit: sha, packageName: pkg.name, version: pkg.version, tag: expected.tag, filename: expected.filename, sha256: sha256(assets[expected.filename]) })) {
    assert.equal(manifest[key], value, `Artifact provenance mismatch: ${key}`);
  }
  assert.deepEqual(manifest.dependencies, expected.dependencies, 'Artifact SDK versions differ from the tested source');
  const expectedChecksums = `${sha256(assets[expected.filename])}  ${expected.filename}\n${sha256(assets['release-manifest.json'])}  release-manifest.json\n`;
  assert.equal(assets.SHA256SUMS.toString(), expectedChecksums, 'Release checksums differ');
  return manifest;
}

export async function assertAbsent(api, endpoint) {
  const response = await api(endpoint);
  assert.equal(response.status, 404, response.status === 200 ? `Release/tag already exists: ${endpoint}` : `Cannot establish absence (${response.status}): ${endpoint}`);
}

function expectStatus(response, status, action) {
  assert.equal(response.status, status, `${action} failed (HTTP ${response.status}): ${JSON.stringify(response.data)}`);
  return response.data;
}

async function mainSha(api) {
  return expectStatus(await api(`/repos/${REPOSITORY}/git/ref/heads/main`), 200, 'Read main').object.sha;
}

async function preflight(api, context, pkg, lock) {
  validateContext({ ...context, mainSha: await mainSha(api) });
  const { tag } = validatePackage(pkg, lock);
  await assertAbsent(api, `/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`);
  await assertAbsent(api, `/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`);
}

export async function publishRelease({ api, context, pkg, lock, assets }) {
  const manifest = validateAssets(assets, pkg, lock, context.expectedSha);
  await preflight(api, context, pkg, lock);
  const base = `/repos/${REPOSITORY}`;
  // Atomic ref creation refuses a race with another tag creator. Never update refs.
  expectStatus(await api(`${base}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${manifest.tag}`, sha: context.expectedSha } }), 201, 'Create immutable source tag');
  const release = expectStatus(await api(`${base}/releases`, { method: 'POST', body: {
    tag_name: manifest.tag, target_commitish: context.expectedSha,
    name: `CloudCLI fork ${manifest.tag}`, draft: true, prerelease: true, make_latest: 'false',
    body: `Tested fork tarball from ${context.expectedSha}.\n\nInstall:\n\n\`\`\`sh\nnpm install -g https://github.com/${REPOSITORY}/releases/download/${manifest.tag}/${manifest.filename}\n\`\`\`\n\nDownload all three assets and run \`sha256sum -c SHA256SUMS\` to verify the package and provenance manifest; install the verified local file with \`npm install -g ./${manifest.filename}\`. This package intentionally keeps the original npm package name. For isolated installation or updates, use \`npm install --prefix \"$HOME/.local/cloudcli-fork\" https://github.com/${REPOSITORY}/releases/download/${manifest.tag}/${manifest.filename}\`. Use the matching future fork tarball URL for updates; do not use \`cloudcli update\` or the UI official npm Update button, which target the official npm package and can replace the fork. Publishing this release does not deploy or restart any service.`,
  } }), 201, 'Create draft release');
  const uploadUrl = new URL(release.upload_url.split('{')[0]);
  assert.equal(uploadUrl.origin, 'https://uploads.github.com');
  assert(uploadUrl.pathname.startsWith(`/repos/${REPOSITORY}/releases/`));
  for (const [name, bytes] of Object.entries(assets)) {
    uploadUrl.search = new URLSearchParams({ name }).toString();
    const uploaded = expectStatus(await api(uploadUrl.href, { method: 'POST', body: bytes }), 201, `Upload ${name}`);
    assert.equal(uploaded.name, name);
    assert.equal(uploaded.size, bytes.length);
    if (uploaded.digest) assert.equal(uploaded.digest, `sha256:${sha256(bytes)}`);
  }
  // Checks can take minutes. Do not publish a stale main or a changed tag.
  validateContext({ ...context, mainSha: await mainSha(api) });
  const tag = expectStatus(await api(`${base}/git/ref/tags/${encodeURIComponent(manifest.tag)}`), 200, 'Recheck source tag');
  assert.equal(tag.object.sha, context.expectedSha, 'Tag moved during publication');
  const published = expectStatus(await api(`${base}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'false' } }), 200, 'Publish complete release');
  console.log(published.html_url);
  return published;
}

function apiClient() {
  assert(process.env.GH_TOKEN, 'GH_TOKEN is required');
  return async (endpoint, options = {}) => {
    const raw = Buffer.isBuffer(options.body);
    const response = await fetch(endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint}`, {
      method: options.method ?? 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28', ...(options.body ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}) },
      body: options.body ? (raw ? options.body : JSON.stringify(options.body)) : undefined,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 1000) }; }
    return { status: response.status, data };
  };
}

function contextFromEnvironment() {
  return { repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF, eventName: process.env.GITHUB_EVENT_NAME, sha: process.env.GITHUB_SHA, expectedSha: process.env.EXPECTED_SHA };
}

function pack(pkg, lock, directory) {
  const metadata = validatePackage(pkg, lock);
  // TypeScript preserves the shebang but emits mode 0644; ship an executable bin.
  fs.chmodSync(CLI, 0o755);
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  if (process.env.GITHUB_SHA) assert.equal(commit, process.env.GITHUB_SHA);
  fs.mkdirSync(directory, { recursive: true });
  assert.equal(fs.readdirSync(directory).length, 0, 'Pack destination must be empty');
  // Some npm versions still run prepare and mix its stdout into --json output.
  // Inspect the archive itself instead of trusting npm's console metadata.
  run('npm', ['pack', '--ignore-scripts', '--loglevel=error', '--pack-destination', directory], { env: { ...process.env, HUSKY: '0' }, timeout: 120_000 });
  assert.deepEqual(fs.readdirSync(directory), [metadata.filename], 'npm pack produced unexpected files');
  const archivePath = path.join(directory, metadata.filename);
  const archiveFiles = run('tar', ['-tzf', archivePath]).trim().split('\n');
  assert(archiveFiles.every((file) => file.startsWith('package/')), 'Archive entries must stay under package/');
  const archivePaths = archiveFiles.filter((file) => !file.endsWith('/')).map((file) => file.slice('package/'.length));
  validatePackedFiles(archivePaths, pkg);
  assert.equal(new Set(archivePaths).size, archivePaths.length, 'Archive contains duplicate entries');
  const embeddedPackage = JSON.parse(run('tar', ['-xOzf', archivePath, 'package/package.json']));
  assert.deepEqual(embeddedPackage, pkg, 'Embedded package metadata differs from the tested source');
  const inspection = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-pack-inspection-'));
  try {
    run('tar', ['-xzf', archivePath, '-C', inspection, `package/${CLI}`]);
    const executable = path.join(inspection, 'package', CLI);
    const stats = fs.lstatSync(executable);
    assert(stats.isFile() && (stats.mode & 0o111), 'Packed CLI must be a regular executable file');
    assert(fs.readFileSync(executable, 'utf8').startsWith('#!/usr/bin/env node\n'), 'Packed CLI must preserve its node shebang');
  } finally { fs.rmSync(inspection, { recursive: true, force: true }); }
  const bytes = fs.readFileSync(path.join(directory, metadata.filename));
  const manifest = { schemaVersion: 1, repository: REPOSITORY, commit, packageName: pkg.name, version: pkg.version, tag: metadata.tag, filename: metadata.filename, sha256: sha256(bytes), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, dependencies: metadata.dependencies, node: process.version, npm: run('npm', ['--version']).trim(), workflowRun: process.env.GITHUB_RUN_ID ? `https://github.com/${REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}` : null };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, 'release-manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${sha256(bytes)}  ${metadata.filename}\n${sha256(manifestBytes)}  release-manifest.json\n`);
  console.log(`Validated ${archivePaths.length} files: ${metadata.filename}`);
}

function readAssets(directory) {
  return Object.fromEntries(fs.readdirSync(directory).map((name) => {
    assert(fs.lstatSync(path.join(directory, name)).isFile(), `Asset is not a regular file: ${name}`);
    return [name, fs.readFileSync(path.join(directory, name))];
  }));
}

function smoke(pkg, lock, directory) {
  const manifest = validateAssets(readAssets(directory), pkg, lock, run('git', ['rev-parse', 'HEAD']).trim());
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-fork-smoke-'));
  try {
    const home = path.join(temporary, 'home');
    const prefix = path.join(temporary, 'install');
    fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CI: 'true', npm_config_cache: run('npm', ['config', 'get', 'cache']).trim() };
    // Install in isolation with production dependencies and normal install hooks.
    console.log('Installing the tarball with production dependencies in an isolated prefix (10-minute limit)...');
    run('npm', ['install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', path.resolve(directory, manifest.filename)], { env, stdio: 'inherit', timeout: 600_000 });
    const installed = path.join(prefix, 'node_modules', '@cloudcli-ai', 'cloudcli');
    const installedPackage = json(path.join(installed, 'package.json'));
    assert.deepEqual(installedPackage.dependencies, pkg.dependencies);
    const version = run(process.execPath, [path.join(installed, CLI), '--version'], { cwd: home, env });
    assert(version.includes(pkg.version), 'Installed CLI does not report the fork version');
    assert.match(run(process.execPath, [path.join(installed, CLI), '--help'], { cwd: home, env }), /Usage:/i);
    for (const name of DEPENDENCIES) {
      const installedDependency = json(path.join(prefix, 'node_modules', name, 'package.json'));
      assert.equal(installedDependency.version, manifest.dependencies[name].locked, `Installed ${name} drifted from the tested lockfile`);
    }
    const sdkSmoke = `
      import { execFileSync } from 'node:child_process';
      const { Codex } = await import('@openai/codex-sdk');
      const executable = new Codex().exec?.executablePath;
      if (!executable) throw Error('Installed SDK did not resolve its Codex executable');
      const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' }).trim();
      if (version !== 'codex-cli ' + process.env.CLOUDCLI_EXPECTED_CODEX_VERSION) throw Error('Installed SDK executable version differs: ' + version);
      console.log('Installed SDK executable: ' + version);
    `;
    console.log(run(process.execPath, ['--input-type=module', '-e', sdkSmoke], { cwd: prefix, env: { ...env, CLOUDCLI_EXPECTED_CODEX_VERSION: manifest.dependencies['@openai/codex'].locked } }).trim());
    assert(fs.existsSync(path.join(installed, 'dist/index.html')));
    assert(fs.existsSync(path.join(installed, 'dist-server/server/index.js')));
    console.log(`Isolated production installation and CLI/SDK smoke passed: ${pkg.version}`);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

async function main() {
  const [command, destination = 'release/fork'] = process.argv.slice(2);
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  if (command === 'preflight' || command === 'publish') {
    assert.equal(run('git', ['rev-parse', 'HEAD']).trim(), process.env.GITHUB_SHA, 'Checkout differs from the workflow commit');
  }
  if (command === 'preflight') return preflight(apiClient(), contextFromEnvironment(), pkg, lock);
  if (command === 'pack') return pack(pkg, lock, destination);
  if (command === 'smoke') return smoke(pkg, lock, destination);
  if (command === 'publish') return publishRelease({ api: apiClient(), context: contextFromEnvironment(), pkg, lock, assets: readAssets(destination) });
  throw Error('Usage: node scripts/release/fork-release.mjs preflight|pack|smoke|publish [asset-directory]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
