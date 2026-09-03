import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import {
  verifyAuditChain,
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

function* rows(db: AppDatabase): Generator<AuditChainRow> {
  const stmt = db.prepare(
    `SELECT rowid, id, entity_type, entity_id, action, actor_user_id, before_json, after_json,
            ip, created_at, prev_hash, row_hash
       FROM audit_log ORDER BY rowid`,
  );
  for (const r of stmt.iterate() as IterableIterator<DbRow>) {
    yield {
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
}

class AuditChainService {
  private last: AuditChainStatus | null = null;

  status(): AuditChainStatus | null {
    return this.last;
  }

  verify(db: AppDatabase): AuditChainStatus {
    const anchorSetting = getSettingRaw(db, 'audit.chainAnchor') as
      | { prevHash?: string | null }
      | null;
    const report = verifyAuditChain(rows(db), {
      anchorPrevHash: anchorSetting?.prevHash ?? null,
    });

    const lastCloud = getSettingRaw(db, 'webBridge.lastCloudBackupMeta') as
      | { uploadedAt?: string; auditHeadHash?: string | null }
      | null;
    let anchor: AuditChainStatus['anchor'] = null;
    if (lastCloud?.uploadedAt && lastCloud.auditHeadHash) {
      const hit = db
        .prepare(`SELECT 1 AS x FROM audit_log WHERE row_hash = ? LIMIT 1`)
        .get(lastCloud.auditHeadHash);
      anchor = {
        uploadedAt: lastCloud.uploadedAt,
        headHash: lastCloud.auditHeadHash,
        present: hit !== undefined,
      };
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

  /** Verify shortly after boot without holding up the window. */
  verifyInBackground(db: AppDatabase): void {
    setTimeout(() => {
      try {
        this.verify(db);
      } catch (e) {
        log.warn('Audit trail verification failed to run', e);
      }
    }, 3_000);
  }
}

export const auditChainService = new AuditChainService();
