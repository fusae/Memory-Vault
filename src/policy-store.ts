import { randomUUID } from 'node:crypto';
import { getDatabase } from './db.js';
import type { CreatePolicyInput, PolicyEntry, PolicyStatus } from './types.js';

type PolicyRow = Omit<PolicyEntry, 'policy_ref' | 'tool_boundaries'> & { tool_boundaries: string };

function normalizeBoundaries(boundaries: string[] | undefined): string[] {
  return [...new Set((boundaries ?? []).map(value => value.trim()).filter(Boolean))].sort();
}

function withRef(row: PolicyRow): PolicyEntry {
  return { ...row, tool_boundaries: JSON.parse(row.tool_boundaries) as string[], policy_ref: `${row.id}@${row.revision}` };
}

function parseRef(policyRef: string): { id: string; revision: number } {
  const match = /^(.+)@(\d+)$/.exec(policyRef.trim());
  if (!match) throw new Error('policy_ref must use the format <id>@<revision>');
  return { id: match[1], revision: Number(match[2]) };
}

export class PolicyStore {
  create(input: CreatePolicyInput): PolicyEntry {
    const now = new Date().toISOString();
    const id = randomUUID();
    const tenantId = input.tenant_id?.trim() || 'local';
    const project = input.project.trim();
    const title = input.title.trim();
    const content = input.content.trim();
    if (!project || !title || !content) throw new Error('project, title, and content are required');
    getDatabase().prepare(`
      INSERT INTO policies (id, tenant_id, project, space_id, title, content, tool_boundaries, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, project, input.space_id?.trim() || null, title, content, JSON.stringify(normalizeBoundaries(input.tool_boundaries)), input.source?.trim() || null, now, now);
    return this.get(id)!;
  }

  get(id: string): PolicyEntry | null {
    const row = getDatabase().prepare('SELECT * FROM policies WHERE id = ?').get(id) as PolicyRow | undefined;
    return row ? withRef(row) : null;
  }

  list(input: { tenant_id?: string; project: string; space_id?: string; status?: PolicyStatus }): PolicyEntry[] {
    const params: unknown[] = [input.tenant_id?.trim() || 'local', input.project];
    let sql = 'SELECT * FROM policies WHERE tenant_id = ? AND project = ?';
    if (input.space_id) {
      sql += ' AND (space_id IS NULL OR space_id = ?)';
      params.push(input.space_id);
    } else {
      sql += ' AND space_id IS NULL';
    }
    if (input.status) {
      sql += ' AND status = ?';
      params.push(input.status);
    }
    sql += ' ORDER BY updated_at DESC, id ASC';
    return (getDatabase().prepare(sql).all(...params) as PolicyRow[]).map(withRef);
  }

  approve(policyRef: string, approvedBy: string): PolicyEntry {
    const ref = parseRef(policyRef);
    const existing = this.requireCurrent(ref.id, ref.revision);
    if (existing.status === 'retired') throw new Error('Retired policy cannot be approved');
    this.snapshot(existing, 'approved');
    const now = new Date().toISOString();
    getDatabase().prepare(`
      UPDATE policies
      SET status = 'approved', approved_by = ?, approved_at = ?, revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(approvedBy.trim() || 'unknown', now, now, existing.id);
    return this.get(existing.id)!;
  }

  update(policyRef: string, input: { title?: string; content?: string; tool_boundaries?: string[]; source?: string; reason?: string }): PolicyEntry {
    const ref = parseRef(policyRef);
    const existing = this.requireCurrent(ref.id, ref.revision);
    if (existing.status === 'retired') throw new Error('Retired policy cannot be updated');
    this.snapshot(existing, input.reason ?? 'updated');
    const now = new Date().toISOString();
    getDatabase().prepare(`
      UPDATE policies
      SET title = ?, content = ?, tool_boundaries = ?, source = ?, status = 'draft', approved_by = NULL,
          approved_at = NULL, revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(
      input.title?.trim() || existing.title,
      input.content?.trim() || existing.content,
      JSON.stringify(input.tool_boundaries === undefined ? existing.tool_boundaries : normalizeBoundaries(input.tool_boundaries)),
      input.source?.trim() || (existing.source ?? null),
      now,
      existing.id,
    );
    return this.get(existing.id)!;
  }

  retire(policyRef: string, reason = 'retired'): PolicyEntry {
    const ref = parseRef(policyRef);
    const existing = this.requireCurrent(ref.id, ref.revision);
    this.snapshot(existing, reason);
    const now = new Date().toISOString();
    getDatabase().prepare(`
      UPDATE policies SET status = 'retired', revision = revision + 1, updated_at = ? WHERE id = ?
    `).run(now, existing.id);
    return this.get(existing.id)!;
  }

  approvedContext(input: { tenant_id?: string; project: string; space_id?: string }): string {
    const policies = this.list({ ...input, status: 'approved' });
    if (policies.length === 0) return '';
    return ['## Approved Policies', ...policies.map(policy => `- [policy_ref:${policy.policy_ref}] ${policy.title}: ${policy.content}`)].join('\n');
  }

  approvedForToolBoundary(input: { tenant_id?: string; project: string; space_id?: string; tool_name: string }): PolicyEntry[] {
    const toolName = input.tool_name.trim();
    if (!toolName) return [];
    return this.list({ ...input, status: 'approved' }).filter(policy => policy.tool_boundaries.includes(toolName));
  }

  private requireCurrent(id: string, revision: number): PolicyEntry {
    const policy = this.get(id);
    if (!policy) throw new Error(`Policy not found: ${id}`);
    if (policy.revision !== revision) throw new Error(`Stale policy_ref: expected ${policy.policy_ref}`);
    return policy;
  }

  private snapshot(policy: PolicyEntry, reason: string): void {
    getDatabase().prepare(`
      INSERT INTO policy_versions (id, policy_id, content, tool_boundaries, status, revision, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), policy.id, policy.content, JSON.stringify(policy.tool_boundaries), policy.status, policy.revision, reason, new Date().toISOString());
  }
}
