import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { closeDatabase } from '../src/db.js';
import { startMemoryVaultHttpServer } from '../src/http.js';
import { MemoryStore } from '../src/memory-store.js';
import { PolicyStore } from '../src/policy-store.js';
import { hashBearerToken, type McpPrincipalCredential } from '../src/mcp-principal.js';
import { assertDashboardHost } from '../src/network-security.js';

const TEST_DB = './data/test-http-mcp.db';
let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  closeDatabase();
  for (const suffix of ['', '-shm', '-wal']) {
    if (fs.existsSync(`${TEST_DB}${suffix}`)) fs.unlinkSync(`${TEST_DB}${suffix}`);
  }
  delete process.env.MEMORY_DB_PATH;
});

describe('Streamable HTTP MCP server', () => {
  it('authenticates and exposes MemoryVault tools over HTTP', async () => {
    process.env.MEMORY_DB_PATH = TEST_DB;
    server = await startMemoryVaultHttpServer({ port: 0, token: 'test-token' });
    const port = (server.address() as AddressInfo).port;
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
    expect(unauthorized.status).toBe(401);

    const client = new Client({ name: 'memory-vault-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer test-token' } },
    });
    await client.connect(transport);
    const tools = await client.listTools();

    expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'memory_write',
      'memory_search',
      'memory_correct',
      'policy_write',
      'policy_approve',
    ]));
    await client.close();
  });

  it('binds Manager, Writer, Reviewer, and Human calls to authenticated Principals', async () => {
    process.env.MEMORY_DB_PATH = TEST_DB;
    const memories = new MemoryStore(TEST_DB);
    memories.joinSpace('hospital-a-copy', 'Hospital A Copy');
    await memories.write({
      tenant_id: 'agency',
      content: 'Hospital A prefers factual copy.',
      type: 'preference',
      project: 'hospital-a',
      scope: 'team',
      space_id: 'hospital-a-copy',
    });
    const policies = new PolicyStore();
    const draftPolicy = policies.create({
      tenant_id: 'agency',
      project: 'hospital-a',
      space_id: 'hospital-a-copy',
      title: 'Medical claims',
      content: 'No absolute efficacy claims.',
    });
    const policyRef = policies.approve(draftPolicy.policy_ref, 'compliance-owner').policy_ref;
    const principal = (token: string, id: string, role: McpPrincipalCredential['role']): McpPrincipalCredential => ({
      token_sha256: hashBearerToken(token),
      id,
      role,
      tenant_id: 'agency',
      projects: ['hospital-a'],
      spaces: ['hospital-a-copy'],
    });
    const credentials = [
      principal('manager-token', 'hospital-a-lead', 'manager'),
      principal('writer-token', 'hospital-a-writer', 'writer'),
      principal('reviewer-token', 'hospital-a-reviewer', 'reviewer'),
      principal('human-token', 'hospital-a-owner', 'human'),
    ];
    server = await startMemoryVaultHttpServer({ port: 0, principals: credentials });
    const port = (server.address() as AddressInfo).port;
    const connect = async (token: string) => {
      const client = new Client({ name: `principal-${token}`, version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }));
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
      return { result, text, json: result.isError ? undefined : JSON.parse(text) };
    };

    const manager = await connect('manager-token');
    expect((await manager.listTools()).tools.map(tool => tool.name).sort()).toEqual(['workflow_get', 'workflow_start']);
    expect((await manager.listResources()).resources).toEqual([]);
    expect((await manager.listPrompts()).prompts).toEqual([]);
    expect((await call(manager, 'memory_list', {})).result.isError).toBe(true);
    expect((await call(manager, 'workflow_start', {
      task_id: 'http-principal-task-denied',
      request: 'Denied boundary',
      project: 'hospital-b',
      space_id: 'hospital-b-copy',
      writer_id: 'hospital-a-writer',
    })).result.isError).toBe(true);
    const started = await call(manager, 'workflow_start', {
      task_id: 'http-principal-task',
      request: 'Write a clinic announcement.',
      project: 'hospital-a',
      space_id: 'hospital-a-copy',
      writer_id: 'hospital-a-writer',
    });
    expect(started.json.run).toMatchObject({ tenant_id: 'agency', status: 'writing' });

    const writer = await connect('writer-token');
    expect((await writer.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'workflow_get',
      'workflow_recall',
      'workflow_submit_draft',
    ]);
    expect((await call(writer, 'workflow_submit_draft', {
      task_id: 'http-principal-task',
      actor_id: 'hospital-a-lead',
      reviewer_id: 'hospital-a-reviewer',
      draft: 'Impersonated draft.',
    })).result.isError).toBe(true);
    const drafted = await call(writer, 'workflow_submit_draft', {
      task_id: 'http-principal-task',
      actor_id: 'hospital-a-writer',
      reviewer_id: 'hospital-a-reviewer',
      draft: 'Hospital A will hold a public clinic. Details are pending confirmation.',
    });
    expect(drafted.json.required_policy_refs).toContain(policyRef);

    const reviewer = await connect('reviewer-token');
    expect((await reviewer.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'workflow_get',
      'workflow_recall',
      'workflow_submit_review',
    ]);
    const reviewed = await call(reviewer, 'workflow_submit_review', {
      task_id: 'http-principal-task',
      actor_id: 'hospital-a-reviewer',
      decision: 'approved',
      findings: 'No absolute efficacy claims.',
      policy_refs: drafted.json.required_policy_refs,
    });
    expect(reviewed.json.status).toBe('awaiting_human_approval');

    const human = await connect('human-token');
    expect((await human.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'workflow_get',
      'workflow_human_decide',
    ]);
    const completed = await call(human, 'workflow_human_decide', {
      task_id: 'http-principal-task',
      reviewer: 'hospital-a-owner',
      decision: 'approve',
      reason: 'Owner approved.',
    });
    expect(completed.json.run).toMatchObject({ status: 'completed', human_reviewer: 'hospital-a-owner' });

    await Promise.all([manager.close(), writer.close(), reviewer.close(), human.close()]);
  });

  it('refuses unauthenticated non-loopback HTTP by default', async () => {
    await expect(startMemoryVaultHttpServer({ port: 0, host: '0.0.0.0' })).rejects.toThrow('Refusing unauthenticated');
    expect(() => assertDashboardHost('0.0.0.0')).toThrow('only supports loopback');
    expect(() => assertDashboardHost('127.0.0.1')).not.toThrow();
  });
});
