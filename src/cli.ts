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

program.parse();
