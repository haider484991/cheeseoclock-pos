import { createHash } from 'node:crypto';

/**
 * Hash chain over audit_log. Pure functions only — no Electron, no database —
 * so the same code runs in the main process and in vitest under plain Node.
 *
 * Why a chain and not a signature: a signature needs a key, and any key kept
 * on the till is readable by whoever can read the till. A chain needs no
 * secret; instead, the chain's head is recorded somewhere the till cannot
 * rewrite (the cloud backup manifest, stamped by the server), and the two are
 * compared. Rewriting history then means producing a chain whose head no
 * longer matches what the server recorded.
 */

export const AUDIT_CHAIN_GENESIS = 'genesis';

export interface AuditChainFields {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actorUserId: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  ip: string | null;
  createdAt: string;
}

/** Fixed field order, JSON-encoded: the hash never depends on object key order. */
export function canonicalAuditRecord(f: AuditChainFields): string {
  return JSON.stringify([
    f.id,
    f.entityType,
    f.entityId,
    f.action,
    f.actorUserId,
    f.beforeJson,
    f.afterJson,
    f.ip,
    f.createdAt,
  ]);
}

export function hashAuditRow(prevHash: string, f: AuditChainFields): string {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(canonicalAuditRecord(f))
    .digest('hex');
}

export interface AuditChainRow extends AuditChainFields {
  rowid: number;
  prevHash: string | null;
  rowHash: string | null;
}

export interface AuditChainBreak {
  rowid: number;
  id: string;
  createdAt: string;
  reason: string;
}

export interface AuditChainReport {
  ok: boolean;
  totalRows: number;
  /** Rows whose hash was recomputed and matched. */
  checkedRows: number;
  /** Rows written before hashing existed (NULL hashes); not covered. */
  legacyRows: number;
  /** row_hash of the last verified row; null when nothing was hashed yet. */
  headHash: string | null;
  brokenAt: AuditChainBreak | null;
}

export interface VerifyOptions {
  /**
   * When a copy was trimmed for size, the rows before the cut are gone and the
   * first remaining row's prev_hash points at a row that no longer exists.
   * The trimmer records that hash so verification can start from it.
   */
  anchorPrevHash?: string | null;
}

/**
 * The chain walk one row at a time, so a caller can feed rows in pages and
 * hand the event loop back in between: a year of trade is hundreds of
 * thousands of rows, several seconds of hashing, and on the till's main
 * process that is several seconds of a frozen screen.
 *
 * Legacy rows (no hash) are only allowed before the chain starts; one
 * appearing later means a row was inserted around the hashing code and is
 * reported as a break.
 */
export class AuditChainVerifier {
  private totalRows = 0;
  private checkedRows = 0;
  private legacyRows = 0;
  private expectedPrev: string | null = null; // null until the first hashed row
  private headHash: string | null = null;
  private broken: AuditChainReport | null = null;

  constructor(private readonly opts: VerifyOptions = {}) {}

  /** Check the next row in rowid order. False once the chain is broken: stop feeding it. */
  push(r: AuditChainRow): boolean {
    if (this.broken) return false;
    this.totalRows += 1;
    if (r.rowHash === null) {
      if (this.expectedPrev !== null) {
        return this.fail(r, 'a row without a hash appears after the chain started');
      }
      this.legacyRows += 1;
      return true;
    }
    const prev = this.expectedPrev ?? this.opts.anchorPrevHash ?? AUDIT_CHAIN_GENESIS;
    if ((r.prevHash ?? '') !== prev) {
      return this.fail(r, 'the link to the previous row does not match');
    }
    if (hashAuditRow(prev, r) !== r.rowHash) {
      return this.fail(r, 'the row content does not match its hash');
    }
    this.checkedRows += 1;
    this.expectedPrev = r.rowHash;
    this.headHash = r.rowHash;
    return true;
  }

  report(): AuditChainReport {
    if (this.broken) return this.broken;
    return {
      ok: true,
      totalRows: this.totalRows,
      checkedRows: this.checkedRows,
      legacyRows: this.legacyRows,
      headHash: this.headHash,
      brokenAt: null,
    };
  }

  private fail(r: AuditChainRow, reason: string): false {
    this.broken = {
      ok: false,
      totalRows: this.totalRows,
      checkedRows: this.checkedRows,
      legacyRows: this.legacyRows,
      headHash: this.headHash,
      brokenAt: { rowid: r.rowid, id: r.id, createdAt: r.createdAt, reason },
    };
    return false;
  }
}

/** Walk rows in rowid order and check every link (see AuditChainVerifier). */
export function verifyAuditChain(
  rows: Iterable<AuditChainRow>,
  opts: VerifyOptions = {},
): AuditChainReport {
  const verifier = new AuditChainVerifier(opts);
  for (const r of rows) {
    if (!verifier.push(r)) break;
  }
  return verifier.report();
}
