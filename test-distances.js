#!/usr/bin/env node
import { MemoryStore } from './build/memory-store.js';
import { getMemoryDbPath } from './build/path-utils.js';
import { getEmbedding } from './build/embedding.js';
import { getDatabase } from './build/db.js';

const DB_PATH = getMemoryDbPath();
const store = new MemoryStore(DB_PATH);
const db = getDatabase();

console.log('Checking vector distances for TypeScript memories...\n');

// Get the two TypeScript memories
const memories = store.list('preference');
const tsMemories = memories.filter(m => m.content.includes('TypeScript'));

console.log('Found TypeScript memories:');
for (const m of tsMemories) {
  console.log(`  - [${m.id}] ${m.content}`);
  console.log(`    confidence: ${m.confidence}\n`);
}

if (tsMemories.length >= 2) {
  const m1 = tsMemories[0];
  const embedding = await getEmbedding(m1.content);
  const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);

  const sql = `
    SELECT m.*, sub.distance
    FROM (
      SELECT rowid, distance FROM vec_memories
      WHERE embedding MATCH ? AND k = 10
    ) sub
    INNER JOIN memories m ON m.rowid = sub.rowid
    WHERE m.status = 'active'
      AND m.id != ?
  `;
  const similar = db.prepare(sql).all(vecBuffer, m1.id);

  console.log(`\nSimilar memories to "${m1.content.substring(0, 50)}...":\n`);
  for (const s of similar) {
    console.log(`  Distance: ${s.distance.toFixed(4)} - ${s.content.substring(0, 60)}`);
  }
}

console.log('\n\nChecking Rust memories...\n');
const rustMemories = memories.filter(m => m.content.includes('Rust'));

console.log('Found Rust memories:');
for (const m of rustMemories) {
  console.log(`  - [${m.id}] ${m.content}`);
  console.log(`    confidence: ${m.confidence}\n`);
}

if (rustMemories.length >= 1) {
  const m1 = rustMemories[0];
  const embedding = await getEmbedding(m1.content);
  const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);

  const sql = `
    SELECT m.*, sub.distance
    FROM (
      SELECT rowid, distance FROM vec_memories
      WHERE embedding MATCH ? AND k = 10
    ) sub
    INNER JOIN memories m ON m.rowid = sub.rowid
    WHERE m.status = 'active'
      AND m.id != ?
  `;
  const similar = db.prepare(sql).all(vecBuffer, m1.id);

  console.log(`\nSimilar memories to "${m1.content.substring(0, 50)}...":\n`);
  for (const s of similar) {
    console.log(`  Distance: ${s.distance.toFixed(4)} - ${s.content.substring(0, 60)}`);
  }
}
