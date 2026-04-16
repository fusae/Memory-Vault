#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import {
  addMemory,
  searchMemories,
  listMemories,
  getMemory,
  deleteMemory,
  exportMemories,
  organizeMemories,
  synthesizeMemories,
  extractMemories,
  authLogin,
  authStatus,
  authLogout,
  setupCommand,
  syncCommand,
  initEncryption,
} from './cli-commands.js';

const program = new Command();

program
  .name('memory-vault')
  .description('MemoryVault CLI — manage your AI memories')
  .version('0.1.0');

program
  .command('add <content>')
  .description('Add a new memory')
  .requiredOption('-t, --type <type>', 'Memory type: identity | preference | project | episode | rule')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--project <project>', 'Associated project name')
  .option('--confidence <confidence>', 'Confidence 0-1')
  .action(addMemory);

program
  .command('search <query>')
  .description('Semantic search for memories')
  .option('-t, --type <type>', 'Filter by type')
  .option('--project <project>', 'Filter by project')
  .option('-l, --limit <limit>', 'Max results (default: 10)')
  .action(searchMemories);

program
  .command('list')
  .description('List all active memories')
  .option('-t, --type <type>', 'Filter by type')
  .option('--project <project>', 'Filter by project')
  .action(listMemories);

program
  .command('get <id>')
  .description('Get a specific memory by ID')
  .action(getMemory);

program
  .command('delete <id>')
  .description('Delete a memory by ID')
  .action(deleteMemory);

program
  .command('export')
  .description('Export all memories')
  .option('-f, --format <format>', 'Output format: json | markdown (default: json)')
  .action(exportMemories);

program
  .command('organize')
  .description('Analyze memory store health and suggest organization actions')
  .option('--auto', 'Automatically execute safe cleanup actions')
  .option('--project <project>', 'Only organize memories for this project')
  .action(organizeMemories);

program
  .command('synthesize')
  .description('Synthesize recent memories: find duplicates, contradictions, untagged, and low-value entries')
  .option('--hours <hours>', 'Time range in hours (default: 24)')
  .option('--project <project>', 'Only synthesize memories for this project')
  .option('--dry-run', 'Report only, do not execute auto-cleanup')
  .action(synthesizeMemories);

program
  .command('extract')
  .description('Extract memories from conversation text or Claude Code transcript (.jsonl)')
  .option('-f, --file <path>', 'Read conversation from file (auto-detects .jsonl transcript format)')
  .option('--transcript', 'Force treating input as JSONL transcript format')
  .action(extractMemories);

const auth = program.command('auth').description('Manage authentication');
auth.command('login').description('Log in with email (Magic Link)').action(authLogin);
auth.command('status').description('Show current auth status').action(authStatus);
auth.command('logout').description('Log out').action(authLogout);

program
  .command('setup')
  .description('Configure Supabase connection for cloud sync')
  .action(setupCommand);

program
  .command('sync')
  .description('Sync memories with cloud')
  .option('--push', 'Only push local changes to cloud')
  .option('--pull', 'Only pull cloud changes to local')
  .option('--status', 'Show sync status')
  .action(syncCommand);

program
  .command('init-encryption')
  .description('Set up encryption and encrypt all existing memories')
  .action(initEncryption);

program.parse();
