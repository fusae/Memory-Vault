import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, createDatabase, getDatabase } from '../src/db.js';
import { SpaceKeyService, type SpaceInvitation } from '../src/space-crypto.js';
import { MemoryStore } from '../src/memory-store.js';
import { upsertTeamMemoryFromRemote } from '../src/space-sync.js';

vi.mock('../src/embedding.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
}));

const OWNER_DB = './data/test-space-crypto-owner.db';
const MEMBER_DB = './data/test-space-crypto-member.db';

function removeDb(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    if (fs.existsSync(`${path}${suffix}`)) fs.unlinkSync(`${path}${suffix}`);
  }
}

describe('SpaceKeyService', () => {
  afterEach(() => {
    closeDatabase();
    removeDb(OWNER_DB);
    removeDb(MEMBER_DB);
  });

  it('distributes a signed space key envelope across devices without exposing the DEK', () => {
    const ownerIdentity = SpaceKeyService.generateIdentity('alice');
    const memberIdentity = SpaceKeyService.generateIdentity('bob');
    createDatabase(OWNER_DB);
    const owner = new SpaceKeyService(ownerIdentity);
    expect(owner.createSpace('hospital-a-copy', 'Hospital A Copy')).toBe(1);
    const invitation = owner.addMember('hospital-a-copy', memberIdentity);
    const encrypted = owner.encrypt('hospital-a-copy', 'Hospital A prefers restrained copy.');

    expect(invitation.envelope.ciphertext).not.toContain('Hospital A');
    expect(encrypted.ciphertext).not.toContain('Hospital A');
    closeDatabase();

    createDatabase(MEMBER_DB);
    const member = new SpaceKeyService(memberIdentity);
    member.acceptInvitation(invitation);
    expect(member.decrypt('hospital-a-copy', encrypted.ciphertext)).toBe('Hospital A prefers restrained copy.');
    expect(() => member.rotate('hospital-a-copy')).toThrow('Only the active space owner');
  });

  it('rejects a tampered key envelope before storing it', () => {
    const ownerIdentity = SpaceKeyService.generateIdentity('alice');
    const memberIdentity = SpaceKeyService.generateIdentity('bob');
    createDatabase(OWNER_DB);
    const owner = new SpaceKeyService(ownerIdentity);
    owner.createSpace('hospital-a-copy');
    const invitation = owner.addMember('hospital-a-copy', memberIdentity);
    closeDatabase();

    createDatabase(MEMBER_DB);
    const member = new SpaceKeyService(memberIdentity);
    const tampered: SpaceInvitation = {
      ...invitation,
      envelope: { ...invitation.envelope, ciphertext: `${invitation.envelope.ciphertext.slice(0, -2)}AA` },
    };
    expect(() => member.acceptInvitation(tampered)).toThrow('Invalid space key envelope signature');
  });

  it('rotates after revocation so a removed member cannot decrypt new ciphertext', () => {
    const ownerIdentity = SpaceKeyService.generateIdentity('alice');
    const memberIdentity = SpaceKeyService.generateIdentity('bob');
    createDatabase(OWNER_DB);
    const owner = new SpaceKeyService(ownerIdentity);
    owner.createSpace('hospital-a-copy');
    const invitation = owner.addMember('hospital-a-copy', memberIdentity);
    const oldCiphertext = owner.encrypt('hospital-a-copy', 'old shared memory').ciphertext;
    closeDatabase();

    createDatabase(MEMBER_DB);
    const member = new SpaceKeyService(memberIdentity);
    member.acceptInvitation(invitation);
    expect(member.decrypt('hospital-a-copy', oldCiphertext)).toBe('old shared memory');
    closeDatabase();

    createDatabase(OWNER_DB);
    const restoredOwner = new SpaceKeyService(ownerIdentity);
    expect(restoredOwner.revokeMember('hospital-a-copy', 'bob')).toBe(2);
    const newCiphertext = restoredOwner.encrypt('hospital-a-copy', 'new owner memory').ciphertext;
    closeDatabase();

    createDatabase(MEMBER_DB);
    const removedMember = new SpaceKeyService(memberIdentity);
    expect(() => removedMember.decrypt('hospital-a-copy', newCiphertext)).toThrow('No key envelope');
  });

  it('stores and syncs team memories as space ciphertext while preserving local search vectors', async () => {
    const ownerIdentity = SpaceKeyService.generateIdentity('alice');
    const memberIdentity = SpaceKeyService.generateIdentity('bob');
    const ownerKeys = new SpaceKeyService(ownerIdentity);
    const ownerStore = new MemoryStore(OWNER_DB, undefined, ownerKeys);
    ownerKeys.createSpace('hospital-a-copy', 'Hospital A Copy');
    ownerKeys.addMember('hospital-a-copy', memberIdentity);
    const created = await ownerStore.write({
      content: 'Hospital A prefers restrained copy.',
      type: 'preference',
      project: 'hospital-a',
      scope: 'team',
      space_id: 'hospital-a-copy',
    });
    expect(created.memory).toMatchObject({
      content: 'Hospital A prefers restrained copy.',
      encryption_scheme: 'space',
      key_version: 1,
    });
    ownerKeys.rotate('hospital-a-copy');
    await ownerStore.update({ id: created.memory.id, content: 'Hospital A prefers concise, restrained copy.', reason: 'client correction' });
    const invitationV2 = ownerKeys.addMember('hospital-a-copy', memberIdentity);
    const raw = getDatabase().prepare('SELECT * FROM memories WHERE id = ?').get(created.memory.id) as Record<string, unknown>;
    expect(raw.content).not.toContain('Hospital A');
    expect(raw).toMatchObject({ encryption_scheme: 'space', key_version: 2, is_encrypted: 1 });
    expect(ownerStore.getVersions(created.memory.id)[0].content).toBe('Hospital A prefers restrained copy.');
    closeDatabase();

    const memberKeys = new SpaceKeyService(memberIdentity);
    const memberStore = new MemoryStore(MEMBER_DB, undefined, memberKeys);
    memberKeys.acceptInvitation(invitationV2);
    expect(await upsertTeamMemoryFromRemote('hospital-a-copy', raw)).toBe(true);
    expect(memberStore.get(created.memory.id)).toMatchObject({
      content: 'Hospital A prefers concise, restrained copy.',
      encryption_scheme: 'space',
      key_version: 2,
    });
    expect((getDatabase().prepare('SELECT COUNT(*) AS count FROM vec_memories').get() as { count: number }).count).toBe(1);
  });
});
