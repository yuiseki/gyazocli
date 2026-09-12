#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import { normalizeImageId, normalizeCollectionId } from './ids';
import { registerConfigCommand } from './commands/config';
import { registerListCommand } from './commands/list';
import { registerGetCommand } from './commands/get';
import { registerCollectionCommand } from './commands/collection';
import { registerSearchCommand } from './commands/search';
import { registerAppsCommand } from './commands/apps';
import { registerDomainsCommand } from './commands/domains';
import { registerTagsCommand } from './commands/tags';
import { registerLocationsCommand } from './commands/locations';
import { registerSummaryCommand } from './commands/summary';
import { registerStatsCommand } from './commands/stats';
import { registerUploadCommand } from './commands/upload';
import { registerSyncCommand } from './commands/sync';
import { registerImportCommand } from './commands/import';

const program = new Command();

program
  .name('gyazo')
  .description('Gyazo Memory CLI for AI Secretary')
  .option('--mcp-server', 'run as a Model Context Protocol server over stdio')
  .version('0.7.0');

registerConfigCommand(program);
registerListCommand(program);
registerGetCommand(program);
registerCollectionCommand(program);
registerSearchCommand(program);
registerAppsCommand(program);
registerDomainsCommand(program);
registerTagsCommand(program);
registerLocationsCommand(program);
registerSummaryCommand(program);
registerStatsCommand(program);
registerUploadCommand(program);
registerSyncCommand(program);
registerImportCommand(program);

/**
 * Let the first argument stand on its own when it is unambiguous:
 * a Gyazo image ID or URL means `get`, an existing file means `upload`.
 * Anything else is left to commander so unknown commands still report as such.
 */
function expandImplicitCommand(argv: string[]): string[] {
  const args = argv.slice(2);
  const first = args[0];
  if (!first || first.startsWith('-')) {
    return argv;
  }

  const knownNames = new Set<string>(['help']);
  for (const command of program.commands) {
    knownNames.add(command.name());
    for (const alias of command.aliases()) {
      knownNames.add(alias);
    }
  }
  if (knownNames.has(first)) {
    return argv;
  }

  let implicitCommand: string | null = null;
  if (normalizeImageId(first)) {
    // A bare 32-hex ID is ambiguous; treat it as an image.
    implicitCommand = 'get';
  } else if (normalizeCollectionId(first)) {
    // Only the /collections/<id> URL form is unambiguous.
    implicitCommand = 'collection';
  } else if (fs.existsSync(first) && fs.statSync(first).isFile()) {
    implicitCommand = 'upload';
  }
  if (!implicitCommand) {
    return argv;
  }

  return [...argv.slice(0, 2), implicitCommand, ...args];
}

/**
 * The MCP server is not a commander command: it owns stdout for the whole
 * process, so it is dispatched before parsing rather than from an action.
 * The spellings a client is likely to be configured with all work.
 */
const MCP_INVOCATIONS = new Set(['--mcp-server', '--mcp', 'mcp-server', 'mcp']);

function isMcpInvocation(argv: string[]): boolean {
  const first = argv.slice(2)[0];
  return first !== undefined && MCP_INVOCATIONS.has(first);
}

if (isMcpInvocation(process.argv)) {
  // Required lazily: the MCP SDK is a large import that every other command
  // would otherwise pay for at startup.
  const { runMcpServer } = require('./mcp') as typeof import('./mcp');
  runMcpServer().catch((error: any) => {
    console.error('MCP server failed:', error?.message || error);
    process.exit(1);
  });
} else {
  program.parseAsync(expandImplicitCommand(process.argv));
}
