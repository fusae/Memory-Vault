import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from './db.js';
import type { SpaceIdentity, SpaceKeyEnvelope, SpaceMember } from './types.js';

const PREFIX = 'mv-space-v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SpaceInvitation {
  version: 1;
  space_id: string;
  space_name: string;
  key_version: number;
  owner: SpaceMember;
  member: SpaceMember;
  envelope: SpaceKeyEnvelope;
}

function publicPem(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function privatePem(key: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function envelopeData(envelope: Omit<SpaceKeyEnvelope, 'signature'>): Buffer {
  return Buffer.from(JSON.stringify([
    envelope.space_id,
    envelope.key_version,
    envelope.member_id,
    envelope.sender_id,
    envelope.ephemeral_public_key,
    envelope.ciphertext,
    envelope.created_at,
  ]), 'utf8');
}

function aad(spaceId: string, keyVersion: number, memberId?: string): Buffer {
  return Buffer.from(`${spaceId}:${keyVersion}${memberId ? `:${memberId}` : ''}`, 'utf8');
}

function encryptAes(key: Buffer, plaintext: Buffer, additionalData: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additionalData);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64');
}

function decryptAes(key: Buffer, ciphertext: string, additionalData: Buffer): Buffer {
  const data = Buffer.from(ciphertext, 'base64');
  if (data.length < IV_BYTES + TAG_BYTES) throw new Error('Invalid encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_BYTES));
  decipher.setAAD(additionalData);
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  return Buffer.concat([decipher.update(data.subarray(IV_BYTES, data.length - TAG_BYTES)), decipher.final()]);
}

export class SpaceKeyService {
  constructor(readonly identity: SpaceIdentity) {}

  static generateIdentity(memberId: string): SpaceIdentity {
    if (!memberId.trim()) throw new Error('member_id is required');
    const encryption = generateKeyPairSync('x25519');
    const signing = generateKeyPairSync('ed25519');
    return {
      member_id: memberId.trim(),
      encryption_public_key: publicPem(encryption.publicKey),
      encryption_private_key: privatePem(encryption.privateKey),
      signing_public_key: publicPem(signing.publicKey),
      signing_private_key: privatePem(signing.privateKey),
    };
  }

  static identityPath(): string {
    return path.join(os.homedir(), '.memoryvault', 'space-identity.json');
  }

  static saveIdentity(identity: SpaceIdentity, destination = SpaceKeyService.identityPath()): void {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(identity, null, 2), { mode: 0o600 });
    fs.chmodSync(destination, 0o600);
  }

  static loadIdentity(source = SpaceKeyService.identityPath()): SpaceIdentity | null {
    if (!fs.existsSync(source)) return null;
    return JSON.parse(fs.readFileSync(source, 'utf8')) as SpaceIdentity;
  }

  createSpace(spaceId: string, name?: string): number {
    const id = spaceId.trim();
    if (!id) throw new Error('space_id is required');
    const now = new Date().toISOString();
    const owner = this.memberRecord(id, 'owner', now);
    const keyVersion = 1;
    const dataKey = randomBytes(KEY_BYTES);
    const envelope = this.wrapKey(id, keyVersion, owner, dataKey, now);
    getDatabase().transaction(() => {
      getDatabase().prepare(`
        INSERT INTO spaces (space_id, name, joined_at, encryption_required, local_member_id, key_version)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(space_id) DO UPDATE SET
          name = excluded.name, encryption_required = 1,
          local_member_id = excluded.local_member_id, key_version = excluded.key_version
      `).run(id, name?.trim() || id, now, this.identity.member_id, keyVersion);
      this.upsertMember(owner);
      this.upsertEnvelope(envelope);
    })();
    return keyVersion;
  }

  addMember(spaceId: string, input: { member_id: string; encryption_public_key: string; signing_public_key: string }): SpaceInvitation {
    const owner = this.requireOwner(spaceId);
    const now = new Date().toISOString();
    const member: SpaceMember = {
      space_id: spaceId,
      member_id: input.member_id.trim(),
      encryption_public_key: input.encryption_public_key,
      signing_public_key: input.signing_public_key,
      role: 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    if (!member.member_id) throw new Error('member_id is required');
    const keyVersion = this.currentVersion(spaceId);
    const envelope = this.wrapKey(spaceId, keyVersion, member, this.unwrapCurrentKey(spaceId), now);
    getDatabase().transaction(() => {
      this.upsertMember(member);
      this.upsertEnvelope(envelope);
    })();
    const space = getDatabase().prepare('SELECT name FROM spaces WHERE space_id = ?').get(spaceId) as { name: string };
    return { version: 1, space_id: spaceId, space_name: space.name, key_version: keyVersion, owner, member, envelope };
  }

  acceptInvitation(invitation: SpaceInvitation): void {
    if (invitation.version !== 1) throw new Error('Unsupported invitation version');
    if (invitation.member.member_id !== this.identity.member_id) throw new Error('Invitation is for another member');
    if (invitation.member.encryption_public_key !== this.identity.encryption_public_key
      || invitation.member.signing_public_key !== this.identity.signing_public_key) {
      throw new Error('Invitation public keys do not match local identity');
    }
    this.verifyEnvelope(invitation.envelope, invitation.owner.signing_public_key);
    this.unwrapEnvelope(invitation.envelope);
    const now = new Date().toISOString();
    getDatabase().transaction(() => {
      getDatabase().prepare(`
        INSERT INTO spaces (space_id, name, joined_at, encryption_required, local_member_id, key_version)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(space_id) DO UPDATE SET
          name = excluded.name, encryption_required = 1,
          local_member_id = excluded.local_member_id, key_version = MAX(spaces.key_version, excluded.key_version)
      `).run(invitation.space_id, invitation.space_name, now, this.identity.member_id, invitation.key_version);
      this.upsertMember(invitation.owner);
      this.upsertMember(invitation.member);
      this.upsertEnvelope(invitation.envelope);
    })();
  }

  rotate(spaceId: string): number {
    this.requireOwner(spaceId);
    const nextVersion = this.currentVersion(spaceId) + 1;
    const dataKey = randomBytes(KEY_BYTES);
    const now = new Date().toISOString();
    const members = getDatabase().prepare("SELECT * FROM space_members WHERE space_id = ? AND status = 'active'").all(spaceId) as SpaceMember[];
    const envelopes = members.map(member => this.wrapKey(spaceId, nextVersion, member, dataKey, now));
    const memories = getDatabase().prepare(`
      SELECT id, content, tags, source_excerpt FROM memories
      WHERE scope = 'team' AND space_id = ? AND encryption_scheme = 'space'
    `).all(spaceId) as { id: string; content: string; tags: string; source_excerpt: string | null }[];
    const reencrypted = memories.map(memory => ({
      id: memory.id,
      content: this.encryptWithKey(spaceId, nextVersion, dataKey, this.decrypt(spaceId, memory.content)),
      tags: this.encryptWithKey(spaceId, nextVersion, dataKey, this.decrypt(spaceId, memory.tags)),
      source_excerpt: memory.source_excerpt
        ? this.encryptWithKey(spaceId, nextVersion, dataKey, this.decrypt(spaceId, memory.source_excerpt))
        : null,
    }));
    getDatabase().transaction(() => {
      for (const envelope of envelopes) this.upsertEnvelope(envelope);
      const update = getDatabase().prepare(`
        UPDATE memories SET content = ?, tags = ?, source_excerpt = ?, key_version = ?,
          sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END,
          updated_at = ? WHERE id = ?
      `);
      for (const memory of reencrypted) {
        update.run(memory.content, memory.tags, memory.source_excerpt, nextVersion, now, memory.id);
      }
      getDatabase().prepare('UPDATE spaces SET key_version = ? WHERE space_id = ?').run(nextVersion, spaceId);
    })();
    return nextVersion;
  }

  revokeMember(spaceId: string, memberId: string): number {
    this.requireOwner(spaceId);
    if (memberId === this.identity.member_id) throw new Error('Owner cannot revoke itself');
    const result = getDatabase().prepare(`
      UPDATE space_members SET status = 'revoked', updated_at = ?
      WHERE space_id = ? AND member_id = ? AND status = 'active'
    `).run(new Date().toISOString(), spaceId, memberId);
    if (result.changes !== 1) throw new Error(`Active member not found: ${memberId}`);
    return this.rotate(spaceId);
  }

  encrypt(spaceId: string, plaintext: string): { ciphertext: string; key_version: number } {
    const keyVersion = this.currentVersion(spaceId);
    const key = this.unwrapKey(spaceId, keyVersion);
    return {
      ciphertext: this.encryptWithKey(spaceId, keyVersion, key, plaintext),
      key_version: keyVersion,
    };
  }

  decrypt(spaceId: string, value: string): string {
    const match = /^mv-space-v1:(\d+):(.+)$/.exec(value);
    if (!match) throw new Error('Invalid space ciphertext');
    const keyVersion = Number(match[1]);
    return decryptAes(this.unwrapKey(spaceId, keyVersion), match[2], aad(spaceId, keyVersion)).toString('utf8');
  }

  hasKey(spaceId: string, keyVersion?: number): boolean {
    try {
      this.unwrapKey(spaceId, keyVersion ?? this.currentVersion(spaceId));
      return true;
    } catch {
      return false;
    }
  }

  currentVersion(spaceId: string): number {
    const row = getDatabase().prepare('SELECT key_version FROM spaces WHERE space_id = ? AND encryption_required = 1').get(spaceId) as { key_version: number } | undefined;
    if (!row?.key_version) throw new Error(`Encrypted space not found: ${spaceId}`);
    return row.key_version;
  }

  private memberRecord(spaceId: string, role: SpaceMember['role'], now: string): SpaceMember {
    return {
      space_id: spaceId,
      member_id: this.identity.member_id,
      encryption_public_key: this.identity.encryption_public_key,
      signing_public_key: this.identity.signing_public_key,
      role,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
  }

  private encryptWithKey(spaceId: string, keyVersion: number, key: Buffer, plaintext: string): string {
    return `${PREFIX}:${keyVersion}:${encryptAes(key, Buffer.from(plaintext, 'utf8'), aad(spaceId, keyVersion))}`;
  }

  private requireOwner(spaceId: string): SpaceMember {
    const row = getDatabase().prepare(`
      SELECT * FROM space_members WHERE space_id = ? AND member_id = ? AND role = 'owner' AND status = 'active'
    `).get(spaceId, this.identity.member_id) as SpaceMember | undefined;
    if (!row) throw new Error('Only the active space owner can manage members or rotate keys');
    return row;
  }

  private wrapKey(spaceId: string, keyVersion: number, member: SpaceMember, dataKey: Buffer, createdAt: string): SpaceKeyEnvelope {
    const ephemeral = generateKeyPairSync('x25519');
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey(member.encryption_public_key) });
    const wrappingKey = Buffer.from(hkdfSync('sha256', shared, Buffer.from(spaceId), Buffer.from('memory-vault-space-envelope-v1'), KEY_BYTES));
    const unsigned: Omit<SpaceKeyEnvelope, 'signature'> = {
      space_id: spaceId,
      key_version: keyVersion,
      member_id: member.member_id,
      sender_id: this.identity.member_id,
      ephemeral_public_key: publicPem(ephemeral.publicKey),
      ciphertext: encryptAes(wrappingKey, dataKey, aad(spaceId, keyVersion, member.member_id)),
      created_at: createdAt,
    };
    return {
      ...unsigned,
      signature: sign(null, envelopeData(unsigned), createPrivateKey(this.identity.signing_private_key)).toString('base64'),
    };
  }

  private unwrapKey(spaceId: string, keyVersion: number): Buffer {
    const envelope = getDatabase().prepare(`
      SELECT * FROM space_key_envelopes WHERE space_id = ? AND key_version = ? AND member_id = ?
    `).get(spaceId, keyVersion, this.identity.member_id) as SpaceKeyEnvelope | undefined;
    if (!envelope) throw new Error(`No key envelope for ${spaceId}@${keyVersion}`);
    const sender = getDatabase().prepare(`
      SELECT * FROM space_members WHERE space_id = ? AND member_id = ? AND status = 'active'
    `).get(spaceId, envelope.sender_id) as SpaceMember | undefined;
    if (!sender) throw new Error(`Untrusted envelope sender: ${envelope.sender_id}`);
    this.verifyEnvelope(envelope, sender.signing_public_key);
    return this.unwrapEnvelope(envelope);
  }

  private unwrapCurrentKey(spaceId: string): Buffer {
    return this.unwrapKey(spaceId, this.currentVersion(spaceId));
  }

  private verifyEnvelope(envelope: SpaceKeyEnvelope, signingPublicKey: string): void {
    const { signature, ...unsigned } = envelope;
    if (!verify(null, envelopeData(unsigned), createPublicKey(signingPublicKey), Buffer.from(signature, 'base64'))) {
      throw new Error('Invalid space key envelope signature');
    }
  }

  private unwrapEnvelope(envelope: SpaceKeyEnvelope): Buffer {
    const shared = diffieHellman({
      privateKey: createPrivateKey(this.identity.encryption_private_key),
      publicKey: createPublicKey(envelope.ephemeral_public_key),
    });
    const wrappingKey = Buffer.from(hkdfSync('sha256', shared, Buffer.from(envelope.space_id), Buffer.from('memory-vault-space-envelope-v1'), KEY_BYTES));
    return decryptAes(wrappingKey, envelope.ciphertext, aad(envelope.space_id, envelope.key_version, envelope.member_id));
  }

  private upsertMember(member: SpaceMember): void {
    getDatabase().prepare(`
      INSERT INTO space_members (
        space_id, member_id, encryption_public_key, signing_public_key, role, status, created_at, updated_at
      ) VALUES (@space_id, @member_id, @encryption_public_key, @signing_public_key, @role, @status, @created_at, @updated_at)
      ON CONFLICT(space_id, member_id) DO UPDATE SET
        encryption_public_key = excluded.encryption_public_key,
        signing_public_key = excluded.signing_public_key,
        role = excluded.role, status = excluded.status, updated_at = excluded.updated_at
    `).run(member);
  }

  private upsertEnvelope(envelope: SpaceKeyEnvelope): void {
    getDatabase().prepare(`
      INSERT OR REPLACE INTO space_key_envelopes (
        space_id, key_version, member_id, sender_id, ephemeral_public_key, ciphertext, signature, created_at
      ) VALUES (@space_id, @key_version, @member_id, @sender_id, @ephemeral_public_key, @ciphertext, @signature, @created_at)
    `).run(envelope);
  }
}
