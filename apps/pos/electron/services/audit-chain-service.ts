import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import {
  AuditChainVerifier,
  type AuditChainReport,
  type AuditChainRow,
} from '../db/audit-chain.js';
import { getSettingRaw } from '../db/repositories/settings-repo.js';

export interface AuditChainStatus extends AuditChainReport {
  verifiedAt: string;
  /**
   * The chain head the last cloud copy carried (recorded by the server at
   * upload) and whether that head still exists in this history. A rewritten
   * history has no row with that hash any more.
   */
  anchor: { uploadedAt: string; headHash: string; present: boolean } | null;
}

interface DbRow {
  rowid: number;
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_user_id: string | null;
  before_json: string | null;
  after_json: string | null;
  ip: string | null;
  created_at: string;
  prev_hash: string | null;
  row_hash: string | null;
}

/**
 * Rows hashed per slice of the walk. Every IPC call waits behind the main
 * process, and hashing runs at roughly 15 µs a row, so a slice this size
 * holds the till up for tens of milliseconds at most. The walk used to be one
 * synchronous pass: a year of trade (~500k rows) froze the till for 8+ s,
 * three seconds after it opened and again each time Settings showed the
 * audit card.
 */
const PAGE_ROWS = 1_000;
/** After boot: out of the way of the first sale and of the day's cloud copy. */
const BOOT_VERIFY_DELAY_MS = 30_000;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function toChainRow(r: DbRow): AuditChainRow {
  return {
    rowid: r.rowid,
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    action: r.action,
    actorUserId: r.actor_user_id,
    beforeJson: r.before_json,
    afterJson: r.after_json,
    ip: r.ip,
    createdAt: r.created_at,
    prevHash: r.prev_hash,
    rowHash: r.row_hash,
  };
}

class AuditChainService {
  private last: AuditChainStatus | null = null;
  private running: Promise<AuditChainStatus> | null = null;

  status(): AuditChainStatus | null {
    return this.last;
  }

  /** Walk the whole trail. Concurrent callers share the walk already running. */
  verify(db: AppDatabase): Promise<AuditChainStatus> {
    if (!this.running) {
      this.running = this.walk(db).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async walk(db: AppDatabase): Promise<AuditChainStatus> {
    const anchorSetting = getSettingRaw(db, 'audit.chainAnchor') as
      | { prevHash?: string | null }
      | null;
    const lastCloud = getSettingRaw(db, 'webBridge.lastCloudBackupMeta') as
      | { uploadedAt?: string; auditHeadHash?: string | null }
      | null;
    const cloudHead =
      lastCloud?.uploadedAt && lastCloud.auditHeadHash ? lastCloud.auditHeadHash : null;

    const verifier = new AuditChainVerifier({ anchorPrevHash: anchorSetting?.prevHash ?? null });
    // Keyset pages in rowid order. Rows appended while the walk runs (sales
    // go on) are picked up by the later pages.
    const page = db.prepare(
      `SELECT rowid, id, entity_type, entity_id, action, actor_user_id, before_json, after_json,
              ip, created_at, prev_hash, row_hash
         FROM audit_log WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE_ROWS}`,
    );
    let after = 0;
    let intact = true;
    // The cloud head is looked for during the same walk: a separate
    // "WHERE row_hash = ?" has no index and read the whole table again.
    let cloudHeadSeen = false;
    for (;;) {
      const rows = page.all(after) as DbRow[];
      for (const r of rows) {
        if (cloudHead !== null && r.row_hash === cloudHead) cloudHeadSeen = true;
        if (!verifier.push(toChainRow(r))) {
          intact = false;
          break;
        }
      }
      if (!intact || rows.length < PAGE_ROWS) break;
      after = rows[rows.length - 1]!.rowid;
      await yieldToEventLoop();
    }
    const report = verifier.report();

    let anchor: AuditChainStatus['anchor'] = null;
    if (lastCloud?.uploadedAt && cloudHead !== null) {
      // A walk that stopped at a break did not see the rows after it.
      const present =
        cloudHeadSeen ||
        (!intact &&
          db.prepare(`SELECT 1 AS x FROM audit_log WHERE row_hash = ? LIMIT 1`).get(cloudHead) !==
            undefined);
      anchor = { uploadedAt: lastCloud.uploadedAt, headHash: cloudHead, present };
    }

    this.last = { ...report, verifiedAt: new Date().toISOString(), anchor };
    if (!report.ok) {
      log.error('AUDIT TRAIL BROKEN', report.brokenAt);
    } else {
      log.info('Audit trail verified', {
        checked: report.checkedRows,
        legacy: report.legacyRows,
        anchored: anchor?.present ?? null,
      });
    }
    return this.last;
  }

  /** Verify after boot without holding up the window or the first sales. */
  verifyInBackground(db: AppDatabase): void {
    setTimeout(() => {
      this.verify(db).catch((e: unknown) => {
        log.warn('Audit trail verification failed to run', e);
      });
    }, BOOT_VERIFY_DELAY_MS);
  }
}

export const auditChainService = new AuditChainService();
