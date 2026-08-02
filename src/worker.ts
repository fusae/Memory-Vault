#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CryptoService } from './crypto.js';
import { AgentEventStore } from './event-store.js';
import { MemoryStore } from './memory-store.js';
import { MemoryWorker } from './memory-worker.js';
import { getMemoryDbPath } from './path-utils.js';
import { SpaceKeyService } from './space-crypto.js';

type BatchResult = Awaited<ReturnType<MemoryWorker['processBatch']>>;

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function waitForNextPoll(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runMemoryWorkerLoop(
  worker: Pick<MemoryWorker, 'processBatch'>,
  options: {
    signal: AbortSignal;
    batchSize?: number;
    pollMs?: number;
    onBatch?: (result: BatchResult) => void;
    onError?: (error: unknown) => void;
  },
): Promise<void> {
  const batchSize = Math.max(1, Math.min(Math.floor(options.batchSize ?? 100), 100));
  const pollMs = Math.max(100, Math.floor(options.pollMs ?? 1000));

  while (!options.signal.aborted) {
    try {
      const result = await worker.processBatch(batchSize);
      options.onBatch?.(result);
    } catch (error) {
      options.onError?.(error);
    }
    await waitForNextPoll(pollMs, options.signal);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const passphrase = process.env.MEMORYVAULT_PASSPHRASE;
  const crypto = passphrase ? new CryptoService(passphrase) : undefined;
  const identity = SpaceKeyService.loadIdentity();
  const spaceKeys = identity ? new SpaceKeyService(identity) : undefined;
  const store = new MemoryStore(getMemoryDbPath(), crypto, spaceKeys);
  const worker = new MemoryWorker(new AgentEventStore(), store);
  const controller = new AbortController();
  const batchSize = boundedInteger(process.env.MEMORYVAULT_WORKER_BATCH_SIZE, 100, 1, 100);
  const pollMs = boundedInteger(process.env.MEMORYVAULT_WORKER_POLL_MS, 1000, 100, 60_000);

  const shutdown = () => controller.abort();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(`MemoryVault Worker running (batch=${batchSize}, poll=${pollMs}ms)`);
  await runMemoryWorkerLoop(worker, {
    signal: controller.signal,
    batchSize,
    pollMs,
    onBatch: result => {
      if (result.processed || result.failed || result.deadLettered) {
        console.log(JSON.stringify(result));
      }
    },
    onError: error => console.error('[MemoryVault Worker] batch failed:', error),
  });
}
