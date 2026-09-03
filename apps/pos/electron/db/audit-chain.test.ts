import { describe, expect, it } from 'vitest';
import {
  AUDIT_CHAIN_GENESIS,
  hashAuditRow,
  verifyAuditChain,
  type AuditChainRow,
} from './audit-chain.js';

function fields(i: number) {
  return {
    id: `row-${i}`,
    entityType: 'orders',
    entityId: `order-${i}`,
    action: i % 2 ? 'update' : 'create',
    actorUserId: 'user-1',
    beforeJson: i % 2 ? JSON.stringify({ status: 'open' }) : null,
    afterJson: JSON.stringify({ status: 'paid', total_cents: 100 * i }),
    ip: null,
    createdAt: new Date(Date.UTC(2026, 8, 3, 12, 0, i)).toISOString(),
  };
}

/** Build a well-formed chain the way audit-repo does, optionally after some legacy rows. */
function chain(n: number, legacy = 0): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev = AUDIT_CHAIN_GENESIS;
  for (let i = 0; i < legacy; i++) {
    rows.push({ rowid: i + 1, ...fields(i), prevHash: null, rowHash: null });
  }
  for (let i = legacy; i < legacy + n; i++) {
    const f = fields(i);
    const rowHash = hashAuditRow(prev, f);
    rows.push({ rowid: i + 1, ...f, prevHash: prev, rowHash });
    prev = rowHash;
  }
  return rows;
}

describe('verifyAuditChain', () => {
  it('accepts an intact chain and reports its head', () => {
    const rows = chain(5);
    const r = verifyAuditChain(rows);
    expect(r.ok).toBe(true);
    expect(r.checkedRows).toBe(5);
    expect(r.legacyRows).toBe(0);
    expect(r.headHash).toBe(rows[4]!.rowHash);
  });

  it('counts unhashed rows written before the chain existed', () => {
    const r = verifyAuditChain(chain(3, 4));
    expect(r.ok).toBe(true);
    expect(r.legacyRows).toBe(4);
    expect(r.checkedRows).toBe(3);
  });

  it('catches an edited row', () => {
    const rows = chain(6);
    rows[2]!.afterJson = JSON.stringify({ status: 'paid', total_cents: 1 });
    const r = verifyAuditChain(rows);
    expect(r.ok).toBe(false);
    expect(r.brokenAt?.rowid).toBe(3);
    expect(r.brokenAt?.reason).toMatch(/content/);
  });

  it('catches a deleted row', () => {
    const rows = chain(6);
    rows.splice(3, 1);
    const r = verifyAuditChain(rows);
    expect(r.ok).toBe(false);
    expect(r.brokenAt?.id).toBe('row-4');
    expect(r.brokenAt?.reason).toMatch(/previous row/);
  });

  it('catches a row inserted around the hashing code', () => {
    const rows = chain(4);
    rows.splice(2, 0, { rowid: 99, ...fields(42), prevHash: null, rowHash: null });
    const r = verifyAuditChain(rows);
    expect(r.ok).toBe(false);
    expect(r.brokenAt?.rowid).toBe(99);
  });

  it('starts from a recorded anchor when the copy was trimmed', () => {
    const rows = chain(8);
    const kept = rows.slice(5); // rows 6..8 survive the trim
    const anchor = rows[4]!.rowHash; // hash of the last deleted row
    expect(verifyAuditChain(kept).ok).toBe(false);
    const r = verifyAuditChain(kept, { anchorPrevHash: anchor });
    expect(r.ok).toBe(true);
    expect(r.checkedRows).toBe(3);
    expect(r.headHash).toBe(rows[7]!.rowHash);
  });

  it('hash depends on every field and on the previous hash', () => {
    const f = fields(1);
    const a = hashAuditRow(AUDIT_CHAIN_GENESIS, f);
    expect(hashAuditRow('other', f)).not.toBe(a);
    expect(hashAuditRow(AUDIT_CHAIN_GENESIS, { ...f, ip: '10.0.0.1' })).not.toBe(a);
    expect(hashAuditRow(AUDIT_CHAIN_GENESIS, { ...f, createdAt: f.createdAt + 'Z' })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
