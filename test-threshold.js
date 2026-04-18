#!/usr/bin/env node
import { MemoryStore } from './build/memory-store.js';
import { getMemoryDbPath } from './build/path-utils.js';

const DB_PATH = getMemoryDbPath();
const store = new MemoryStore(DB_PATH);

console.log('Testing different similarity thresholds...\n');

const thresholds = [0.5, 0.4, 0.3, 0.2, 0.1];

for (const threshold of thresholds) {
  console.log(`\n=== Threshold: ${threshold} ===`);
  const clusters = await store.findDuplicateClusters('preference', threshold);
  console.log(`Found ${clusters.length} cluster(s)`);

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    console.log(`\nCluster ${i + 1}:`);
    for (const m of cluster) {
      console.log(`  - ${m.content.substring(0, 60)}...`);
      console.log(`    confidence: ${m.confidence}`);
    }
  }
}
