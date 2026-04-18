#!/usr/bin/env node
import { MemoryStore } from './build/memory-store.js';
import { getMemoryDbPath } from './build/path-utils.js';

const DB_PATH = getMemoryDbPath();
const store = new MemoryStore(DB_PATH);

console.log('Testing findDuplicateClusters with threshold 18.0...\n');

const clusters = await store.findDuplicateClusters('preference', 18.0);

console.log(`Found ${clusters.length} cluster(s)\n`);

for (let i = 0; i < clusters.length; i++) {
  const cluster = clusters[i];
  console.log(`Cluster ${i + 1} (${cluster.length} memories):`);
  for (const m of cluster) {
    console.log(`  - [${m.id}] ${m.content}`);
    console.log(`    confidence: ${m.confidence}`);
  }
  console.log('');
}

// Also test with threshold 20.0
console.log('\n\nTesting with threshold 20.0...\n');
const clusters2 = await store.findDuplicateClusters('preference', 20.0);
console.log(`Found ${clusters2.length} cluster(s)\n`);

for (let i = 0; i < clusters2.length; i++) {
  const cluster = clusters2[i];
  console.log(`Cluster ${i + 1} (${cluster.length} memories):`);
  for (const m of cluster) {
    console.log(`  - [${m.id}] ${m.content}`);
    console.log(`    confidence: ${m.confidence}`);
  }
  console.log('');
}
