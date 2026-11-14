import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type BootstrapOptions = {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  launch?: (profilePath: string, environment: NodeJS.ProcessEnv) => void | Promise<void>;
};

function canonicalPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(canonicalPath(parent), path.basename(candidate));
  }
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function parseConfiguration(contents: string, homeDirectory: string) {
  const config: unknown = JSON.parse(contents);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Filesystem policy must be a JSON object');
  }
  const record = config as Record<string, unknown>;
  if (record.version !== 1) throw new Error('Filesystem policy version must be 1');
  if (!Array.isArray(record.writableRoots) || record.writableRoots.length === 0) {
    throw new Error('Filesystem policy writableRoots must be a nonempty array');
  }
  const writableRoots = [...new Set(record.writableRoots.map((entry: unknown) => {
    if (typeof entry !== 'string' || !path.isAbsolute(entry)) {
      throw new Error('Filesystem policy writableRoots must contain absolute existing directories');
    }
    const resolved = fs.realpathSync(entry);
    if (!fs.statSync(resolved).isDirectory() || resolved === path.parse(resolved).root) {
      throw new Error('Filesystem policy writableRoots must be directories below the filesystem root');
    }
    return resolved;
  }))];
  const runtimeValue = record.runtimeDirectory ?? path.join(homeDirectory, '.cloudcli', 'runtime');
  if (typeof runtimeValue !== 'string' || !path.isAbsolute(runtimeValue)) {
    throw new Error('Filesystem policy runtimeDirectory must be an absolute directory');
  }
  const runtimeDirectory = canonicalPath(runtimeValue);
  if (!containsPath(path.join(homeDirectory, '.cloudcli'), runtimeDirectory)
    && !writableRoots.some((root) => containsPath(root, runtimeDirectory))) {
    throw new Error('Filesystem policy runtimeDirectory must be under .cloudcli or a writable root');
  }
  return { writableRoots, runtimeDirectory };
}

function operationalWritePaths(homeDirectory: string, environment: NodeJS.ProcessEnv, writableRoots: string[]) {
  const resolveStatePath = (candidate: string) => {
    const lexical = path.resolve(candidate);
    const resolved = canonicalPath(lexical);
    if (resolved !== lexical && !writableRoots.some((root) => containsPath(root, resolved))) {
      throw new Error('Operational state path resolves through a symlink outside writableRoots');
    }
    return resolved;
  };
  const directories = [
    '.cloudcli/assets', '.cloudcli/browser-use', '.claude-code-ui/plugins',
    '.codex/sessions', '.codex/archived_sessions', '.codex/tmp', '.codex/.tmp',
    '.codex/log', '.codex/logs', '.codex/cache', '.codex/shell_snapshots',
    '.codex/thread-writer-locks', '.codex/project-metadata-locks', '.codex/sqlite',
    '.claude/projects', '.claude/statsig', '.claude/debug', '.claude/todos',
    '.claude/tasks', '.claude/session-env', '.claude/shell-snapshots', '.claude/plans', '.claude/cache',
    '.cursor/projects', '.cursor/chats', '.cursor/logs', '.cursor/cache', '.local/share/opencode',
  ].map((entry) => resolveStatePath(path.join(homeDirectory, entry)));
  const files = [
    '.cloudcli/auth.db', '.cloudcli/local-server.json', '.cloudcli/server.log',
    '.cloudcli/launchd.stdout.log', '.cloudcli/launchd.stderr.log', '.claude-code-ui/plugins.json',
    '.codex/auth.json', '.codex/auth.lock', '.codex/models_cache.json',
    '.codex/history.jsonl', '.codex/session_index.jsonl', '.codex/session_index.jsonl.lock',
    '.codex/version.json', '.codex/.sqlite-maintenance.lock', '.claude.json',
  ].map((entry) => resolveStatePath(path.join(homeDirectory, entry)));
  if (environment.DATABASE_PATH) {
    const database = resolveStatePath(environment.DATABASE_PATH);
    files.push(database, `${database}-wal`, `${database}-shm`, `${database}-journal`);
  }
  const rootParents = [...new Set([...directories, ...files].map((entry) => path.dirname(entry)))];
  return { directories, files, rootParents };
}

function regexQuote(value: string): string {
  const metacharacters = new Set(['\\', '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']']);
  return [...value].map((character) => metacharacters.has(character) ? `\\${character}` : character).join('');
}

function seatbeltRegex(pattern: string): string {
  // Seatbelt #"..." regular expressions keep backslashes literally, unlike
  // ordinary string arguments. JSON-stringifying the whole expression would
  // double regex escapes and silently omit the intended runtime exceptions.
  return `#"${pattern.replaceAll('"', '\\"')}"`;
}

function renderProfile(
  homeDirectory: string,
  writableRoots: string[],
  runtimeDirectory: string,
  operational: ReturnType<typeof operationalWritePaths>,
  protectedFiles: string[],
): string {
  const terms = [
    ...new Set([...writableRoots, runtimeDirectory, ...operational.directories]),
  ].map((entry) => `(subpath ${JSON.stringify(entry)})`);
  terms.push(...operational.files.map((entry) => `(literal ${JSON.stringify(entry)})`));
  terms.push('(literal "/dev/null")', '(literal "/dev/tty")', '(literal "/dev/ptmx")', '(regex #"^/dev/ttys[0-9]+$")');
  const homeRegex = regexQuote(homeDirectory);
  terms.push(`(regex ${seatbeltRegex(`^${homeRegex}/[.]codex/[a-z_]+_[0-9]+[.]sqlite(-wal|-shm|-journal)?$`)})`);
  terms.push(`(regex ${seatbeltRegex(`^${homeRegex}/[.]claude[.]json([.].*)?$`)})`);
  terms.push(`(regex ${seatbeltRegex(`^${homeRegex}/[.]cloudcli/claude-shell-theme-[a-z-]+[.]json([.][0-9]+[.]tmp)?$`)})`);
  return [
    '; Generated CloudCLI filesystem policy: project data is writable only under writableRoots.',
    '; Operational exceptions permit databases, transcripts, auth refresh, caches and terminal devices.',
    '(version 1)', '(allow default)',
    '; Ordinary child execution inherits this boundary. Do not delegate work to',
    '; launchd or external applications that may execute outside this process tree.',
    '(deny job-creation)', '(deny lsopen)', '(deny appleevent-send)',
    `(deny file-write* (require-not (require-any\n  ${terms.join('\n  ')}\n)))`,
    `(deny file-write* ${protectedFiles.map((entry) => `(literal ${JSON.stringify(entry)})`).join(' ')})`,
    '',
  ].join('\n');
}

async function launchSandboxedProcess(profilePath: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const args = ['-f', profilePath, process.execPath, ...process.execArgv, ...process.argv.slice(1)];
  if (typeof process.execve === 'function') {
    // execve replaces this process before any later server import can run.
    process.execve('/usr/bin/sandbox-exec', ['/usr/bin/sandbox-exec', ...args], environment);
    throw new Error('Filesystem sandbox process replacement returned unexpectedly');
  }
  const child = spawn('/usr/bin/sandbox-exec', args, { env: environment, stdio: 'inherit' });
  const signals = ['SIGTERM', 'SIGINT'] as const;
  const forwarders = signals.map((signal) => {
    const listener = () => { child.kill(signal); };
    process.on(signal, listener);
    return () => process.off(signal, listener);
  });
  const result = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  }).finally(() => { for (const remove of forwarders) remove(); });
  process.exit(result);
}

/**
 * Used by the environment bootstrap before server imports: loads an optional,
 * persistent administrator-owned policy and replaces the server with a macOS
 * sandboxed copy. No policy leaves existing behavior unchanged. A configured
 * policy fails closed on invalid configuration or unsupported platforms.
 *
 * The optional dependencies isolate bootstrap tests from the developer's home
 * and replace process execution without starting another server. Policy files
 * must live outside all writable data/runtime roots, so the running service
 * cannot weaken its own next-start policy. Other filesystem reads remain
 * governed by macOS ownership/privacy permissions.
 */
export async function initializeFilesystemPolicy(options: BootstrapOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  const homeDirectory = canonicalPath(options.homeDirectory ?? os.homedir());
  const configuredPath = environment.CLOUDCLI_FILESYSTEM_POLICY;
  if (configuredPath !== undefined && (!configuredPath || !path.isAbsolute(configuredPath))) {
    throw new Error('CLOUDCLI_FILESYSTEM_POLICY must be an absolute policy file path');
  }
  const requestedPath = configuredPath ?? path.join(homeDirectory, '.config', 'cloudcli', 'filesystem-policy.json');
  let configPath: string;
  let contents: string;
  try {
    configPath = fs.realpathSync(requestedPath);
    contents = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (configuredPath === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Unable to load CloudCLI filesystem policy: ${(error as Error).message}`);
  }
  const { writableRoots, runtimeDirectory } = parseConfiguration(contents, homeDirectory);
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('Configured CloudCLI filesystem policy requires macOS sandbox-exec; refusing an unprotected start');
  }
  const operational = operationalWritePaths(homeDirectory, environment, writableRoots);
  const digest = createHash('sha256').update(JSON.stringify({ configPath, writableRoots, runtimeDirectory })).digest('hex').slice(0, 16);
  const profilePath = path.join(path.dirname(configPath), `filesystem-policy-${digest}.sb`);
  for (const protectedPath of [configPath, profilePath]) {
    if ([...writableRoots, runtimeDirectory, ...operational.directories].some((root) => containsPath(root, protectedPath))
      || operational.files.includes(protectedPath)) {
      throw new Error('Filesystem policy and generated profile must be outside writable project and runtime locations');
    }
  }
  const profile = renderProfile(homeDirectory, writableRoots, runtimeDirectory, operational, [configPath, profilePath]);
  const childEnvironment = {
    ...environment,
    CLOUDCLI_FILESYSTEM_POLICY: configPath,
    CLOUDCLI_PROCESS_SANDBOX: '1',
    CLOUDCLI_SANDBOX_ACTIVE: '1',
    CLOUDCLI_SANDBOX_PROFILE: profilePath,
    CLOUDCLI_WRITE_ROOTS: JSON.stringify(writableRoots),
    CLOUDCLI_READ_ROOTS: '["/"]',
    WORKSPACES_ROOT: writableRoots[0],
    WORKSPACES_ALLOWED_ROOTS: JSON.stringify(writableRoots.slice(1)),
    TMPDIR: path.join(runtimeDirectory, 'tmp'),
    XDG_CACHE_HOME: path.join(runtimeDirectory, 'cache'),
    npm_config_cache: path.join(runtimeDirectory, 'cache', 'npm'),
    XDG_STATE_HOME: path.join(runtimeDirectory, 'state'),
    HISTFILE: path.join(runtimeDirectory, 'shell-history'),
    GIT_OPTIONAL_LOCKS: '0',
  };
  if (environment.CLOUDCLI_PROCESS_SANDBOX === '1') {
    if (environment.CLOUDCLI_SANDBOX_PROFILE !== profilePath || fs.readFileSync(profilePath, 'utf8') !== profile) {
      throw new Error('Inherited CloudCLI sandbox does not match the configured filesystem policy; relaunch without the old wrapper');
    }
    // macOS does not permit applying another Seatbelt profile in a sandboxed
    // process. This rejects an accidentally forged active flag on a normal start.
    const nested = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8' });
    if (nested.status === 0 || !nested.stderr?.includes('sandbox_apply')) {
      throw new Error('CloudCLI sandbox marker is set but an inherited macOS sandbox could not be verified');
    }
    Object.assign(environment, childEnvironment);
    return;
  }
  fs.mkdirSync(childEnvironment.TMPDIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(childEnvironment.XDG_CACHE_HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(childEnvironment.XDG_STATE_HOME, { recursive: true, mode: 0o700 });
  // Existing parent directories need no write grant. Pre-create only these
  // application/provider state parents before entering Seatbelt; the profile
  // does not grant their unrelated worktrees, backups or other descendants.
  for (const parent of operational.rootParents) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const pendingPath = `${profilePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(pendingPath, profile, { mode: 0o600, flag: 'wx' });
    fs.renameSync(pendingPath, profilePath);
  } finally {
    fs.rmSync(pendingPath, { force: true });
  }
  await (options.launch ?? launchSandboxedProcess)(profilePath, childEnvironment);
}
