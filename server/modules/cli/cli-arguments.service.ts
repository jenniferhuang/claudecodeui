type ParsedCliArguments = {
  command: string;
  options: {
    serverPort?: string;
    databasePath?: string;
  };
  remainingArguments: string[];
};

/**
 * Parses top-level CLI arguments for the executable bootstrap and command
 * service. This component deliberately has no runtime imports: database and
 * port flags must be available before environment-dependent modules load.
 * Arguments after `sandbox` belong to that command and remain untouched.
 */
export function parseCliArguments(argumentsList: string[]): ParsedCliArguments {
  const parsedArguments: ParsedCliArguments = {
    command: 'start',
    options: {},
    remainingArguments: [],
  };

  for (let argumentIndex = 0; argumentIndex < argumentsList.length; argumentIndex += 1) {
    const argument = argumentsList[argumentIndex];
    if (argument === '--port' || argument === '-p') {
      parsedArguments.options.serverPort = argumentsList[++argumentIndex];
    } else if (argument.startsWith('--port=')) {
      parsedArguments.options.serverPort = argument.slice('--port='.length);
    } else if (argument === '--database-path') {
      parsedArguments.options.databasePath = argumentsList[++argumentIndex];
    } else if (argument.startsWith('--database-path=')) {
      parsedArguments.options.databasePath = argument.slice('--database-path='.length);
    } else if (argument === '--help' || argument === '-h') {
      parsedArguments.command = 'help';
    } else if (argument === '--version' || argument === '-v') {
      parsedArguments.command = 'version';
    } else if (!argument.startsWith('-')) {
      parsedArguments.command = argument;
      if (argument === 'sandbox') {
        parsedArguments.remainingArguments = argumentsList.slice(argumentIndex + 1);
        break;
      }
    }
  }

  return parsedArguments;
}

