import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { writeAudit } from '../db/repositories/audit-repo.js';
import type { AppliedRestore } from './backup-service.js';
import { openSecret } from './secret-seal.js';
import { getWebBridgeConfig, setWebBridgeConfig } from './web-bridge-config.js';

/**
 * Runs once at boot, right after a staged restore has replaced the database:
 *  - leaves a permanent, hash-chained record of the restore INSIDE the
 *    restored data (who staged it, from which copy, what was archived), so a
 *    restore can never be a silent way to rewind history;
 *  - re-attaches the website connection captured by an onboarding restore,
 *    so a replacement PC comes up already linked to the site.
 */
export function recordAppliedRestore(db: AppDatabase, restore: AppliedRestore): void {
  const info = restore.info;
  writeAudit(db, {
    entityType: 'database',
    entityId: 'restore',
    action: 'restore_applied',
    actorUserId: info?.byUserId ?? null,
    before: { archivedTo: restore.archivedTo },
    after: {
      source: info?.source ?? 'unknown',
      label: info?.label ?? null,
      fromDeviceId: info?.fromDeviceId ?? null,
      stagedAt: info?.stagedAt ?? null,
      appliedAt: new Date().toISOString(),
    },
  });
  log.info('Restore recorded in the audit trail', { source: info?.source, label: info?.label });

  if (info?.connection) {
    const secret = openSecret(info.connection.bridgeSecretSealed);
    if (secret.value) {
      const existing = getWebBridgeConfig(db);
      setWebBridgeConfig(db, {
        enabled: existing.enabled,
        siteUrl: info.connection.siteUrl,
        bridgeSecret: secret.value,
        pollIntervalMs: existing.pollIntervalMs,
        cloudBackupFrequency: existing.cloudBackupFrequency,
      });
      log.info('Website connection re-attached after restore');
    }
  }
}
