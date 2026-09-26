import { useQuery } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { summarizeBackups, type BackupSummary } from './backupStatus';

/**
 * The owner-facing backup status (see backupStatus.ts), from the till's own
 * backup health and the website connection. Null while loading.
 */
export function useBackupSummary(refetchMs = 60_000): {
  summary: BackupSummary | null;
  /** The website address and connection password are set (online copies can run). */
  connected: boolean;
  isError: boolean;
} {
  const healthQ = useQuery({
    queryKey: ['backup', 'health'],
    queryFn: () => ipc.backup.health(),
    refetchInterval: refetchMs,
  });
  const cfgQ = useQuery({
    queryKey: ['webBridge', 'config'],
    queryFn: () => ipc.webBridge.getConfig(),
  });
  const cfg = cfgQ.data;
  const connected = !!cfg && cfg.ready.ok && !cfg.secretUnreadable;
  const summary =
    healthQ.data && cfg
      ? summarizeBackups(healthQ.data, {
          frequency: cfg.cloudBackupFrequency,
          connected,
          secretUnreadable: cfg.secretUnreadable,
        })
      : null;
  return { summary, connected, isError: healthQ.isError || cfgQ.isError };
}
