import { v7 as uuidv7 } from 'uuid';
import os from 'node:os';
import type { AppDatabase } from '../connection.js';

export interface DeviceInfo {
  deviceId: string;
  displayName: string;
  registeredAt: string;
  lastSyncAt: string | null;
}

interface DeviceInfoRow {
  device_id: string;
  display_name: string;
  registered_at: string;
  last_sync_at: string | null;
}

export function ensureDeviceInfo(db: AppDatabase): DeviceInfo {
  const existing = db
    .prepare(
      'SELECT device_id, display_name, registered_at, last_sync_at FROM device_info WHERE id = ?',
    )
    .get('singleton') as DeviceInfoRow | undefined;

  if (existing) {
    return {
      deviceId: existing.device_id,
      displayName: existing.display_name,
      registeredAt: existing.registered_at,
      lastSyncAt: existing.last_sync_at,
    };
  }

  const deviceId = uuidv7();
  const displayName = `${os.hostname()} (${os.platform()})`;
  const registeredAt = new Date().toISOString();

  db.prepare(
    'INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES (?, ?, ?, ?)',
  ).run('singleton', deviceId, displayName, registeredAt);

  return { deviceId, displayName, registeredAt, lastSyncAt: null };
}
