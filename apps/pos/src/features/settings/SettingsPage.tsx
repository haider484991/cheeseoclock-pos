import { PrinterSettings } from './PrinterSettings';
import { BrandingSettings } from './BrandingSettings';
import { FbrSettings } from './FbrSettings';
import { SyncSettings } from './SyncSettings';
import { BackupSettings } from './BackupSettings';
import { AboutCard } from './AboutCard';

export function SettingsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          Printer, branding, FBR Digital Invoicing, cloud sync, and local backup.
        </p>
      </header>
      <PrinterSettings />
      <BrandingSettings />
      <FbrSettings />
      <SyncSettings />
      <BackupSettings />
      <AboutCard />
    </div>
  );
}
