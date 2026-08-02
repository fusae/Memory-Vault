import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { closeDatabase, createDatabase, getDatabase } from '../src/db.js';
import { PolicyStore } from '../src/policy-store.js';

const TEST_DB = './data/test-policy-store.db';

describe('PolicyStore', () => {
  let policies: PolicyStore;

  beforeEach(() => {
    createDatabase(TEST_DB);
    policies = new PolicyStore();
  });

  afterEach(() => {
    closeDatabase();
    for (const suffix of ['', '-shm', '-wal']) {
      if (fs.existsSync(`${TEST_DB}${suffix}`)) fs.unlinkSync(`${TEST_DB}${suffix}`);
    }
  });

  it('keeps policies out of context until an exact revision is approved', () => {
    const draft = policies.create({
      tenant_id: 'agency',
      project: 'hospital-a',
      space_id: 'hospital-a-copy',
      title: 'Medical advertising language',
      content: 'Do not use absolute efficacy claims.',
      tool_boundaries: ['cms.publish', 'cms.publish'],
      source: 'legal-review-2026',
    });

    expect(draft).toMatchObject({ status: 'draft', revision: 1, policy_ref: `${draft.id}@1`, tool_boundaries: ['cms.publish'] });
    expect(policies.approvedContext({ tenant_id: 'agency', project: 'hospital-a', space_id: 'hospital-a-copy' })).toBe('');

    const approved = policies.approve(draft.policy_ref, 'compliance@example.com');
    expect(approved).toMatchObject({ status: 'approved', revision: 2, policy_ref: `${draft.id}@2` });
    expect(policies.approvedContext({ tenant_id: 'agency', project: 'hospital-a', space_id: 'hospital-a-copy' }))
      .toContain(`[policy_ref:${approved.policy_ref}]`);
    expect(policies.approvedForToolBoundary({ tenant_id: 'agency', project: 'hospital-a', space_id: 'hospital-a-copy', tool_name: 'cms.publish' }))
      .toHaveLength(1);
    expect(policies.approvedForToolBoundary({ tenant_id: 'agency', project: 'hospital-a', space_id: 'hospital-a-copy', tool_name: 'email.send' }))
      .toEqual([]);
    expect(() => policies.approve(draft.policy_ref, 'stale-reviewer')).toThrow('Stale policy_ref');
  });

  it('returns an approved policy to draft after modification', () => {
    const draft = policies.create({ project: 'hospital-a', title: 'Naming', content: 'Use Hospital A.' });
    const approved = policies.approve(draft.policy_ref, 'brand-owner');
    const revised = policies.update(approved.policy_ref, {
      content: 'Use the full legal name of Hospital A.',
      tool_boundaries: ['document.export'],
      reason: 'brand correction',
    });

    expect(revised).toMatchObject({ status: 'draft', revision: 3, approved_by: null, approved_at: null, tool_boundaries: ['document.export'] });
    expect(policies.approvedContext({ project: 'hospital-a' })).toBe('');
    const versions = getDatabase().prepare('SELECT revision, status, reason FROM policy_versions WHERE policy_id = ? ORDER BY revision')
      .all(draft.id);
    expect(versions).toEqual([
      { revision: 1, status: 'draft', reason: 'approved' },
      { revision: 2, status: 'approved', reason: 'brand correction' },
    ]);
  });

  it('isolates policies by tenant, project, and team space', () => {
    policies.create({ tenant_id: 'agency', project: 'hospital-a', space_id: 'copy', title: 'A', content: 'A rule' });
    policies.create({ tenant_id: 'agency', project: 'hospital-b', space_id: 'copy', title: 'B', content: 'B rule' });
    policies.create({ tenant_id: 'other', project: 'hospital-a', space_id: 'copy', title: 'Other', content: 'Other rule' });

    const rows = policies.list({ tenant_id: 'agency', project: 'hospital-a', space_id: 'copy' });
    expect(rows.map(policy => policy.title)).toEqual(['A']);
  });
});
