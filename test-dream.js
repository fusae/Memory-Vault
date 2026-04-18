#!/usr/bin/env node
import { MemoryStore } from './build/memory-store.js';
import { getMemoryDbPath } from './build/path-utils.js';

const DB_PATH = getMemoryDbPath();
const store = new MemoryStore(DB_PATH);

console.log('Testing AutoDream duplicate detection...\n');

// Find duplicate clusters
const clusters = await store.findDuplicateClusters(undefined, 18.0);

console.log(`Found ${clusters.length} duplicate cluster(s):\n`);

for (let i = 0; i < clusters.length; i++) {
  const cluster = clusters[i];
  console.log(`Cluster ${i + 1} (${cluster.length} memories):`);
  for (const m of cluster) {
    console.log(`  - [${m.id}] ${m.content}`);
    console.log(`    confidence: ${m.confidence}, type: ${m.type}`);
  }

  const allHighConfidence = cluster.every(m => m.confidence >= 0.8);
  if (allHighConfidence) {
    console.log(`  ✓ All memories have confidence >= 0.8, safe to merge`);
  } else {
    const lowConf = cluster.filter(m => m.confidence < 0.8);
    console.log(`  ⚠ ${lowConf.length} memory(ies) have confidence < 0.8`);
  }
  console.log('');
}

// Test auto-merge with low confidence (should fail)
if (clusters.length > 0) {
  const testCluster = clusters.find(c => c.some(m => m.confidence < 0.8));
  if (testCluster) {
    console.log('\nTesting merge with low confidence memories (should fail)...');
    const ids = testCluster.map(m => m.id);
    const mergedContent = testCluster.map(m => m.content).join('; ');

    try {
      await store.consolidate(ids, mergedContent);
      console.log('✗ Merge succeeded (unexpected!)');
    } catch (err) {
      console.log(`✓ Merge blocked: ${err.message}`);
    }
  }

  // Test auto-merge with high confidence (should succeed)
  const highConfCluster = clusters.find(c => c.every(m => m.confidence >= 0.8));
  if (highConfCluster) {
    console.log('\nTesting merge with high confidence memories (should succeed)...');
    const ids = highConfCluster.map(m => m.id);
    const mergedContent = highConfCluster.map(m => m.content).join('; ');

    try {
      const result = await store.consolidate(ids, mergedContent);
      console.log(`✓ Merge succeeded: ${result.id}`);
      console.log(`  Content: ${result.content}`);
    } catch (err) {
      console.log(`✗ Merge failed: ${err.message}`);
    }
  }
}

console.log('\nCheck logs at:', DB_PATH.replace('memory.db', 'logs/consolidate.log'));
