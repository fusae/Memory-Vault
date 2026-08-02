#!/usr/bin/env node
import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { MemoryStore } from './memory-store.js';
import { CryptoService } from './crypto.js';
import { dashboardApi } from './dashboard-api.js';
import { getMemoryDbPath } from './path-utils.js';
import { SpaceKeyService } from './space-crypto.js';
import { assertDashboardHost } from './network-security.js';

const DB_PATH = getMemoryDbPath();
const PORT = parseInt(process.env.DASHBOARD_PORT ?? '3080', 10);
const HOST = process.env.DASHBOARD_HOST?.trim() || '127.0.0.1';
assertDashboardHost(HOST);

// Initialize E2EE if passphrase is configured
const passphrase = process.env.MEMORYVAULT_PASSPHRASE;
const crypto = passphrase ? new CryptoService(passphrase) : undefined;
if (crypto) {
  console.log('[MemoryVault Dashboard] E2EE encryption enabled');
}
const spaceIdentity = SpaceKeyService.loadIdentity();
const store = new MemoryStore(DB_PATH, crypto, spaceIdentity ? new SpaceKeyService(spaceIdentity) : undefined);
const app = new Hono();

// API routes
app.route('/api', dashboardApi(store));

// Static files
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

app.get('/*', serveStatic({ root: publicDir }));
// SPA fallback
app.get('/*', serveStatic({ path: path.join(publicDir, 'index.html') }));

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`MemoryVault Dashboard running at http://${HOST}:${PORT}`);
});
