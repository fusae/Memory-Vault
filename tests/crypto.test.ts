import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CryptoService } from '../src/crypto.js';
import { MemoryStore } from '../src/memory-store.js';
import { closeDatabase } from '../src/db.js';
import fs from 'node:fs';

vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(768).fill(0);
    for (let i = 0; i < text.length && i < 768; i++) {
      vec[i] = text.charCodeAt(i) / 255;
    }
    return vec;
  }),
}));

describe('CryptoService', () => {
  const salt = Buffer.from('a'.repeat(64), 'hex');

  it('should encrypt and decrypt text correctly', () => {
    const crypto = new CryptoService('test-passphrase', salt);
    const plaintext = 'Hello, this is a secret memory!';
    const encrypted = crypto.encrypt(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(crypto.decrypt(encrypted)).toBe(plaintext);
  });

  it('should produce different ciphertexts for same input (unique IV)', () => {
    const crypto = new CryptoService('test-passphrase', salt);
    const plaintext = 'same input';
    const enc1 = crypto.encrypt(plaintext);
    const enc2 = crypto.encrypt(plaintext);

    expect(enc1).not.toBe(enc2);
    expect(crypto.decrypt(enc1)).toBe(plaintext);
    expect(crypto.decrypt(enc2)).toBe(plaintext);
  });

  it('should fail decryption with wrong passphrase', () => {
    const crypto1 = new CryptoService('passphrase-1', salt);
    const crypto2 = new CryptoService('passphrase-2', salt);

    const encrypted = crypto1.encrypt('secret');
    expect(() => crypto2.decrypt(encrypted)).toThrow();
  });

  it('should handle unicode and special characters', () => {
    const crypto = new CryptoService('test', salt);
    const text = '中文记忆 🧠 with "quotes" & <special> chars';
    expect(crypto.decrypt(crypto.encrypt(text))).toBe(text);
  });

  it('should handle empty string', () => {
    const crypto = new CryptoService('test', salt);
    expect(crypto.decrypt(crypto.encrypt(''))).toBe('');
  });
});

describe('MemoryStore with encryption', () => {
  const TEST_DB = './data/test-crypto-store.db';
  const salt = Buffer.from('b'.repeat(64), 'hex');
  let store: MemoryStore;

  beforeEach(() => {
    const crypto = new CryptoService('test-passphrase', salt);
    store = new MemoryStore(TEST_DB, crypto);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('should write encrypted content and decrypt on read', async () => {
    const result = await store.write({
      content: 'User prefers dark mode',
      type: 'preference',
      tags: ['ui', 'theme'],
    });

    // Decrypted content should be readable
    const memory = store.get(result.memory.id);
    expect(memory?.content).toBe('User prefers dark mode');
    expect(memory?.tags).toEqual(['ui', 'theme']);
    expect(memory?.is_encrypted).toBe(true);
  });

  it('should store ciphertext in database', async () => {
    const result = await store.write({
      content: 'Secret project info',
      type: 'project',
    });

    // Read raw from DB — should be ciphertext
    const { getDatabase } = await import('../src/db.js');
    const db = getDatabase();
    const raw = db.prepare('SELECT content, is_encrypted FROM memories WHERE id = ?').get(result.memory.id) as { content: string; is_encrypted: number };

    expect(raw.content).not.toBe('Secret project info');
    expect(raw.is_encrypted).toBe(1);
  });

  it('should decrypt in list()', async () => {
    await store.write({ content: 'List test memory', type: 'identity' });
    const list = store.list();
    expect(list[0].content).toBe('List test memory');
  });

  it('should decrypt in export()', async () => {
    await store.write({ content: 'Export test', type: 'rule' });
    const exported = store.export();
    expect(exported[0].content).toBe('Export test');
  });

  it('should decrypt version history', async () => {
    const r = await store.write({ content: 'v1 content', type: 'identity' });
    await store.update({ id: r.memory.id, content: 'v2 content', reason: 'update' });

    const versions = store.getVersions(r.memory.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('v1 content');
  });

  it('should work without encryption (backward compatible)', async () => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

    const plainStore = new MemoryStore(TEST_DB);
    const r = await plainStore.write({ content: 'Plaintext memory', type: 'identity' });
    const memory = plainStore.get(r.memory.id);
    expect(memory?.content).toBe('Plaintext memory');
    expect(memory?.is_encrypted).toBe(false);
  });
});
