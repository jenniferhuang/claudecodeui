// Load environment variables from .env before other imports execute.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { initializeFilesystemPolicy } from './modules/filesystem-policy/index.js';

// This bootstrap cannot import shared/utils.ts: that module reads environment
// defaults during evaluation, before this file has loaded `.env`.
function getBootstrapApplicationRoot(importMetaUrl: string) {
  const moduleDirectory = path.dirname(fileURLToPath(importMetaUrl));
  let serverRoot = moduleDirectory;
  while (path.basename(serverRoot) !== 'server') {
    const parent = path.dirname(serverRoot);
    if (parent === serverRoot) throw new Error('Could not resolve server root');
    serverRoot = parent;
  }
  const parent = path.dirname(serverRoot);
  return path.basename(parent) === 'dist-server' ? path.dirname(parent) : parent;
}

// Resolve the repo/app root via the nearest /server folder so this file keeps finding the
// same top-level .env file from both /server/load-env.ts and /dist-server/server/load-env.js.
const APP_ROOT = getBootstrapApplicationRoot(import.meta.url);

// Only bootstrap's sandboxed replacement may set these fields. In particular,
// a package .env cannot claim that a normal process already has an OS sandbox.
const RESERVED_FILESYSTEM_POLICY_KEYS = new Set([
  'CLOUDCLI_PROCESS_SANDBOX', 'CLOUDCLI_SANDBOX_ACTIVE', 'CLOUDCLI_SANDBOX_PROFILE',
  'CLOUDCLI_WRITE_ROOTS', 'CLOUDCLI_READ_ROOTS',
]);

try {
  const envPath = path.join(APP_ROOT, '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && !RESERVED_FILESYSTEM_POLICY_KEYS.has(key) && valueParts.length > 0 && !process.env[key]) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  });
} catch (e: any) {
  console.error('No .env file found or error reading it:', e.message);
}

// Keep the default database in a stable user-level location so rebuilding dist-server
// never changes where the backend stores auth.db when DATABASE_PATH is not set explicitly.
const DEFAULT_DATABASE_PATH = path.join(os.homedir(), '.cloudcli', 'auth.db');

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = DEFAULT_DATABASE_PATH;
}

// Normal deployment .env settings (including policy location and database
// path) are now available. Awaiting the policy replacement here still prevents
// later server imports from running outside the configured process boundary.
await initializeFilesystemPolicy();
