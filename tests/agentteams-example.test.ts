import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import { loadPrincipalCredentials, resolvePrincipal } from '../src/mcp-principal.js';

const ROOT = path.resolve('examples/agentteams-hospital-a');
const API_VERSION = 'agentteams.io/v1beta1';

const metadata = z.object({ name: z.string().min(1) }).strict();
const mcpServer = z.object({
  name: z.literal('memory-vault'),
  url: z.string().url(),
  transport: z.literal('http'),
}).strict();

const manager = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('Manager'),
  metadata,
  spec: z.object({
    model: z.string().min(1),
    runtime: z.enum(['openclaw', 'copaw']),
    skills: z.array(z.string()).min(1),
    mcpServers: z.array(mcpServer).optional(),
    agents: z.string().min(1),
  }).strict(),
}).strict();

const worker = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('Worker'),
  metadata,
  spec: z.object({
    model: z.string().min(1),
    runtime: z.enum(['openclaw', 'copaw', 'hermes', 'qwenpaw']),
    package: z.string().url(),
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(mcpServer).min(1),
    identity: z.string().min(1),
    agents: z.string().min(1),
  }).strict(),
}).strict();

const team = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('Team'),
  metadata,
  spec: z.object({
    description: z.string().min(1),
    peerMentions: z.boolean(),
    heartbeatEvery: z.string().regex(/^\d+[smhd]$/),
    workerMembers: z.array(z.object({
      name: z.string().min(1),
      role: z.enum(['team_leader', 'worker']),
    }).strict()).min(2).max(128),
  }).strict(),
}).strict();

describe('AgentTeams Hospital A example', () => {
  it('matches the AgentTeams v1beta1 resource contract and dependency order', () => {
    const source = fs.readFileSync(path.join(ROOT, 'agentteams.yaml'), 'utf8');
    const documents = parseAllDocuments(source).map(document => {
      expect(document.errors).toEqual([]);
      return document.toJS();
    });

    expect(documents.map(document => `${document.kind}/${document.metadata.name}`)).toEqual([
      'Manager/default',
      'Worker/hospital-a-lead',
      'Worker/hospital-a-writer',
      'Worker/hospital-a-reviewer',
      'Team/hospital-a-team',
    ]);

    manager.parse(documents[0]);
    documents.slice(1, 4).forEach(document => worker.parse(document));
    team.parse(documents[4]);

    expect(documents[4].spec.workerMembers).toEqual([
      { name: 'hospital-a-lead', role: 'team_leader' },
      { name: 'hospital-a-writer', role: 'worker' },
      { name: 'hospital-a-reviewer', role: 'worker' },
    ]);
    expect(documents[0].spec.mcpServers).toBeUndefined();
    documents.slice(1, 4).forEach(document => {
      expect(document.spec.mcpServers).toEqual([{
        name: 'memory-vault',
        url: 'http://host.docker.internal:3090/mcp',
        transport: 'http',
      }]);
    });
  });

  it('provides a hash-only mapping script for AgentTeams per-Worker consumer keys', () => {
    const content = fs.readFileSync(path.join(ROOT, 'configure-principals.sh'), 'utf8');
    for (const marker of [
      'agentteams-creds-hospital-a-lead',
      'agentteams-creds-hospital-a-writer',
      'agentteams-creds-hospital-a-reviewer',
      '--token-env',
      'MEMORYVAULT_HTTP_PRINCIPALS_FILE',
    ]) {
      expect(content).toContain(marker);
    }
  });

  it('maps mocked AgentTeams Secrets through the real CLI without persisting plaintext tokens', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-vault-agentteams-'));
    const bin = path.join(temp, 'bin');
    const principalFile = path.join(temp, 'principals.json');
    fs.mkdirSync(bin);
    const kubectl = path.join(bin, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
case "$*" in
  *hospital-a-lead*) printf 'bGVhZC1zZWNyZXQ=' ;;
  *hospital-a-writer*) printf 'd3JpdGVyLXNlY3JldA==' ;;
  *hospital-a-reviewer*) printf 'cmV2aWV3ZXItc2VjcmV0' ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
    const cli = path.join(bin, 'memory-vault-cli');
    fs.writeFileSync(cli, `#!/usr/bin/env bash
exec "${path.resolve('node_modules/.bin/tsx')}" "${path.resolve('src/cli.ts')}" "$@"
`, { mode: 0o700 });

    const result = spawnSync('bash', [path.join(ROOT, 'configure-principals.sh')], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MEMORYVAULT_HTTP_PRINCIPALS_FILE: principalFile,
        MEMORYVAULT_CLI: cli,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const content = fs.readFileSync(principalFile, 'utf8');
    expect(content).not.toMatch(/lead-secret|writer-secret|reviewer-secret/);
    const credentials = loadPrincipalCredentials(principalFile);
    expect(resolvePrincipal('Bearer lead-secret', credentials)).toMatchObject({ id: 'hospital-a-lead', role: 'manager' });
    expect(resolvePrincipal('Bearer writer-secret', credentials)).toMatchObject({ id: 'hospital-a-writer', role: 'writer' });
    expect(resolvePrincipal('Bearer reviewer-secret', credentials)).toMatchObject({ id: 'hospital-a-reviewer', role: 'reviewer' });
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('maps embedded AgentTeams worker credentials without persisting plaintext tokens', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-vault-agentteams-embedded-'));
    const bin = path.join(temp, 'bin');
    const principalFile = path.join(temp, 'principals.json');
    fs.mkdirSync(bin);
    const docker = path.join(bin, 'docker');
    fs.writeFileSync(docker, `#!/usr/bin/env bash
[[ "$*" == *'. "/data/worker-creds/$1.env"'* ]] || exit 1
case "$*" in
  *hospital-a-lead*) printf 'embedded-lead-secret' ;;
  *hospital-a-writer*) printf 'embedded-writer-secret' ;;
  *hospital-a-reviewer*) printf 'embedded-reviewer-secret' ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
    const cli = path.join(bin, 'memory-vault-cli');
    fs.writeFileSync(cli, `#!/usr/bin/env bash
exec "${path.resolve('node_modules/.bin/tsx')}" "${path.resolve('src/cli.ts')}" "$@"
`, { mode: 0o700 });

    const result = spawnSync('bash', [path.join(ROOT, 'configure-principals.sh')], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AGENTTEAMS_CREDENTIAL_BACKEND: 'embedded',
        AGENTTEAMS_CONTAINER_CMD: docker,
        MEMORYVAULT_HTTP_PRINCIPALS_FILE: principalFile,
        MEMORYVAULT_CLI: cli,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const content = fs.readFileSync(principalFile, 'utf8');
    expect(content).not.toContain('embedded-lead-secret');
    expect(content).not.toContain('embedded-writer-secret');
    expect(content).not.toContain('embedded-reviewer-secret');
    const credentials = loadPrincipalCredentials(principalFile);
    expect(resolvePrincipal('Bearer embedded-lead-secret', credentials)).toMatchObject({ id: 'hospital-a-lead', role: 'manager' });
    expect(resolvePrincipal('Bearer embedded-writer-secret', credentials)).toMatchObject({ id: 'hospital-a-writer', role: 'writer' });
    expect(resolvePrincipal('Bearer embedded-reviewer-secret', credentials)).toMatchObject({ id: 'hospital-a-reviewer', role: 'reviewer' });
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('packages the four required workflow Skills with enforced tool contracts', () => {
    const requirements = new Map([
      ['memory-recall', ['workflow_start', 'workflow_recall', 'failure_retry', 'tool_boundary', 'memory_ref']],
      ['hospital-copy-execution', ['workflow_submit_draft', 'hospital-a-writer', 'policy_ref']],
      ['hospital-policy-validation', ['workflow_submit_review', 'required_policy_refs', 'rejected']],
      ['memory-postmortem', ['workflow_human_decide', 'Outbox', 'memory_correct']],
    ]);

    for (const [skill, markers] of requirements) {
      const file = path.join(ROOT, 'package', 'skills', skill, 'SKILL.md');
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toContain(`name: ${skill}`);
      markers.forEach(marker => expect(content).toContain(marker));
    }
  });
});
