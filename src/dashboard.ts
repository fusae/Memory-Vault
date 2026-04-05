#!/usr/bin/env node
import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { MemoryStore } from './memory-store.js';
import { dashboardApi } from './dashboard-api.js';

const DB_PATH = process.env.MEMORY_DB_PATH ?? path.join(os.homedir(), '.memoryvault', 'memory.db');
const PORT = parseInt(process.env.DASHBOARD_PORT ?? '3080', 10);

const store = new MemoryStore(DB_PATH);
const app = new Hono();

// API routes
app.route('/api', dashboardApi(store));

// Static files
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

app.get('/*', serveStatic({ root: publicDir }));
// SPA fallback
app.get('/*', serveStatic({ path: path.join(publicDir, 'index.html') }));

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`MemoryVault Dashboard running at http://localhost:${PORT}`);
});
