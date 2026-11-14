#!/usr/bin/env node

import { parseCliArguments } from './cli-arguments.service.js';

async function runCli(): Promise<number> {
  const argumentsList = process.argv.slice(2);
  const { options } = parseCliArguments(argumentsList);
  if (options.databasePath) process.env.DATABASE_PATH = options.databasePath;
  if (options.serverPort) process.env.SERVER_PORT = options.serverPort;

  // The filesystem policy must grant the selected database, not a default
  // subsequently replaced by CLI flags. Keep all environment-dependent imports
  // behind this pure argument pass, then initialize .env and the OS boundary.
  // eslint-disable-next-line boundaries/no-unknown
  await import('../../load-env.js');
  const { createCliApplication } = await import('./index.js');
  return createCliApplication().run(argumentsList);
}

runCli().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('\n❌ Error:', message);
  process.exitCode = 1;
});
