#!/usr/bin/env node
import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  loadPrincipalCredentials,
  resolvePrincipal,
  type McpPrincipal,
  type McpPrincipalCredential,
} from './mcp-principal.js';
import { isLoopbackHost } from './network-security.js';

function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function startMemoryVaultHttpServer(opts: {
  port: number;
  host?: string;
  token?: string;
  principals?: McpPrincipalCredential[];
  allowInsecure?: boolean;
}): Promise<Server> {
  process.env.MEMORYVAULT_TRANSPORT = 'http';
  const host = opts.host ?? '127.0.0.1';
  const principalCredentials = opts.principals ?? [];
  if (opts.token && principalCredentials.length > 0) {
    throw new Error('Configure either a legacy HTTP token or Principal credentials, not both');
  }
  if (!opts.token && principalCredentials.length === 0 && !opts.allowInsecure && !isLoopbackHost(host)) {
    throw new Error('Refusing unauthenticated HTTP MCP on a non-loopback host');
  }
  const { createMemoryVaultMcpServer } = await import('./index.js');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, transport: 'streamable-http' }));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    let principal: McpPrincipal | undefined;
    if (principalCredentials.length > 0) {
      principal = resolvePrincipal(req.headers.authorization, principalCredentials) ?? undefined;
    } else if (opts.token && authorized(req.headers.authorization, opts.token)) {
      principal = { id: 'legacy-http-admin', role: 'admin', tenant_id: 'local', projects: ['*'], spaces: ['*'] };
    }
    if ((principalCredentials.length > 0 || opts.token) && !principal) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const mcp = createMemoryVaultMcpServer({ principal });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
    } catch (error) {
      console.error('[MemoryVault HTTP] request failed:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, resolve);
  });
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = parseInt(process.env.MEMORYVAULT_HTTP_PORT ?? '3090', 10);
  const host = process.env.MEMORYVAULT_HTTP_HOST ?? '127.0.0.1';
  const token = process.env.MEMORYVAULT_HTTP_TOKEN?.trim() || undefined;
  const principalFile = process.env.MEMORYVAULT_HTTP_PRINCIPALS_FILE?.trim();
  const principals = principalFile ? loadPrincipalCredentials(principalFile) : undefined;
  const allowInsecure = process.env.MEMORYVAULT_HTTP_ALLOW_INSECURE === '1';
  const httpServer = await startMemoryVaultHttpServer({ port, host, token, principals, allowInsecure });
  console.log(`MemoryVault MCP HTTP server running at http://${host}:${port}/mcp`);
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
