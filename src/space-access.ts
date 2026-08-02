import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDatabase } from './db.js';
import type { SpaceAccessRole } from './types.js';

export interface SpacePrincipal {
  member_id: string;
  role: SpaceAccessRole;
  bootstrap?: boolean;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function issueSpaceAccessToken(input: {
  space_id: string;
  member_id: string;
  role: SpaceAccessRole;
  issuer_id: string;
}): string {
  const db = getDatabase();
  const issuer = db.prepare(`
    SELECT role, status FROM space_members WHERE space_id = ? AND member_id = ?
  `).get(input.space_id, input.issuer_id) as { role: string; status: string } | undefined;
  if (issuer?.role !== 'owner' || issuer.status !== 'active') throw new Error('Only the active space owner can issue access tokens');
  const member = db.prepare(`
    SELECT status FROM space_members WHERE space_id = ? AND member_id = ?
  `).get(input.space_id, input.member_id) as { status: string } | undefined;
  if (member?.status !== 'active') throw new Error(`Active member not found: ${input.member_id}`);
  const token = `mvs_${randomBytes(32).toString('base64url')}`;
  db.prepare(`
    INSERT INTO space_access_tokens (id, space_id, member_id, token_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), input.space_id, input.member_id, tokenHash(token), input.role, new Date().toISOString());
  return token;
}

export function revokeMemberAccess(spaceId: string, memberId: string): number {
  return getDatabase().prepare(`
    UPDATE space_access_tokens SET status = 'revoked', revoked_at = ?
    WHERE space_id = ? AND member_id = ? AND status = 'active'
  `).run(new Date().toISOString(), spaceId, memberId).changes;
}

export function resolveSpacePrincipal(spaceId: string, authorization: string | undefined, bootstrapToken: string): SpacePrincipal | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7);
  if (secureEqual(token, bootstrapToken)) return { member_id: 'bootstrap', role: 'owner', bootstrap: true };
  const row = getDatabase().prepare(`
    SELECT t.member_id, t.role
    FROM space_access_tokens t
    INNER JOIN space_members m ON m.space_id = t.space_id AND m.member_id = t.member_id
    WHERE t.space_id = ? AND t.token_hash = ? AND t.status = 'active' AND m.status = 'active'
  `).get(spaceId, tokenHash(token)) as { member_id: string; role: SpaceAccessRole } | undefined;
  return row ?? null;
}

export function roleAllows(actual: SpaceAccessRole, required: SpaceAccessRole): boolean {
  const rank: Record<SpaceAccessRole, number> = { reader: 1, writer: 2, owner: 3 };
  return rank[actual] >= rank[required];
}
