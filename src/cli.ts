#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import {
  addMemory,
  searchMemories,
  listMemories,
  getMemory,
  deleteMemory,
  correctMemory,
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
  migrateProjects,
  recallMemories,
  syncAgentsMdCommand,
  promoteMemory,
  joinSpace,
  listSpaces,
  serveSpaceCommand,
  initSpaceIdentity,
  exportSpaceIdentity,
  initEncryptedSpace,
  inviteSpaceMember,
  acceptSpaceInvitation,
  rotateSpaceKey,
  revokeSpaceMember,
  issueMemberToken,
  addHttpPrincipal,
} from './cli-commands.js';
import { deriveProjectKey } from './project-key.js';
import { sweepCodex } from './codex-sweep.js';

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
  .option('--scope <scope>', 'Memory scope: personal | team')
  .option('--space <space>', 'Team space id')
  .option('--space-id <spaceId>', 'Team space id (alias for --space)')
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
  .command('recall')
  .description('Inject project memories as context')
  .requiredOption('--cwd <path>', 'Working directory for deriving the project key')
  .option('--format <format>', 'Output format: context (default: context)')
  .option('--limit <limit>', 'Max memories (default: 10)')
  .option('--budget <budget>', 'Approximate token budget (default: 500)')
  .action(async opts => {
    await recallMemories(opts);
  });

program
  .command('sync-agents-md')
  .description('Sync project memories into AGENTS.md')
  .option('--cwd <path>', 'Working directory for deriving the project key')
  .option('--all', 'Sync all registered projects')
  .option('--redact', 'Skip sensitive memory lines in managed block')
  .action(async opts => {
    await syncAgentsMdCommand(opts);
  });

program
  .command('get <id>')
  .description('Get a specific memory by ID')
  .action(getMemory);

program
  .command('delete <id>')
  .description('Delete a memory by ID')
  .action(deleteMemory);

program
  .command('correct <memory-ref> <content>')
  .description('Correct a recalled memory using its versioned memory_ref')
  .option('--reason <reason>', 'Reason for the correction')
  .action(correctMemory);

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
  .option('--project-key <projectKey>', 'Use a canonical project key for extracted memories')
  .action(extractMemories);

program
  .command('sweep-codex')
  .description('Opportunistically extract memories from Codex CLI rollout sessions')
  .option('--codex-home <dir>', 'Codex home directory (default: ~/.codex)')
  .option('--dry-run', 'List candidate rollout files without extracting')
  .option('--limit <limit>', 'Max sessions to process (default: 20)')
  .action(async opts => {
    await sweepCodex(opts);
  });

program
  .command('migrate-projects')
  .description('Bulk update memory project names to canonical project keys')
  .requiredOption('--map <mapping>', 'Mapping in the form <old>=<project-key>')
  .option('--dry-run', 'Print the number of affected memories without updating')
  .action(migrateProjects);

program
  .command('promote <memory-id>')
  .description('Promote a personal memory to a team space')
  .requiredOption('--space <space_id>', 'Team space id')
  .action(promoteMemory);

const space = program.command('space').description('Manage local team spaces');
space.command('join <space_id>')
  .description('Join a local team space')
  .requiredOption('--name <name>', 'Space name')
  .option('--url <url>', 'Remote space server URL')
  .option('--token <token>', 'Remote space server token')
  .action(joinSpace);
space.command('list')
  .description('List joined team spaces')
  .action(listSpaces);
space.command('identity-init <member_id>')
  .description('Create the local X25519 and Ed25519 space identity')
  .action(initSpaceIdentity);
space.command('identity-export')
  .description('Export only the public space identity')
  .option('--output <file>', 'Write public identity JSON to a file')
  .action(exportSpaceIdentity);
space.command('init-encrypted <space_id>')
  .description('Create an E2EE space and its first data key')
  .option('--name <name>', 'Space name')
  .action(initEncryptedSpace);
space.command('invite <space_id> <public_identity_file>')
  .description('Add a member and create a signed key invitation')
  .option('--output <file>', 'Write invitation JSON to a file')
  .action(inviteSpaceMember);
space.command('accept <invitation_file>')
  .description('Verify and accept a signed space invitation')
  .action(acceptSpaceInvitation);
space.command('rotate <space_id>')
  .description('Rotate the space data key as its owner')
  .action(rotateSpaceKey);
space.command('revoke <space_id> <member_id>')
  .description('Revoke a member and immediately rotate the space data key')
  .action(revokeSpaceMember);
space.command('issue-token <space_id> <member_id>')
  .description('Issue a member-scoped remote access token')
  .option('--role <role>', 'reader | writer | owner', 'writer')
  .action(issueMemberToken);

const httpPrincipal = program.command('http-principal').description('Manage HTTP MCP Agent Principals');
httpPrincipal.command('add')
  .description('Add a hash-only Agent Principal and generate a bearer token')
  .requiredOption('--id <id>', 'Authenticated Agent or human id')
  .requiredOption('--role <role>', 'admin | manager | writer | reviewer | human | observer')
  .requiredOption('--tenant <tenant>', 'Allowed tenant id')
  .requiredOption('--projects <projects>', 'Comma-separated project ids, or *')
  .requiredOption('--spaces <spaces>', 'Comma-separated space ids, or *')
  .option('--file <file>', 'Principal file (default: ~/.memoryvault/http-principals.json)')
  .option('--token-env <name>', 'Hash an existing token from this environment variable instead of generating one')
  .action(opts => { addHttpPrincipal(opts); });

program
  .command('serve-space')
  .description('Run this vault as a team space server')
  .requiredOption('--port <port>', 'Port to listen on')
  .requiredOption('--token <token>', 'Bearer token')
  .option('--space <space_id>', 'Only serve one team space id')
  .action(serveSpaceCommand);

program
  .command('project-key <cwd>', { hidden: true })
  .description('Derive a canonical project key for a working directory')
  .action((cwd: string) => {
    console.log(deriveProjectKey(cwd));
  });

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
