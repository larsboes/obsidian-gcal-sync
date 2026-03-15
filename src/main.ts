import { Plugin, TFile, Notice } from 'obsidian';
import { GCalSyncSettings } from '@/types';
import { DEFAULT_SETTINGS } from '@/settings/defaults';
import { GCalSyncSettingTab } from '@/settings/SettingsTab';
import { GoogleAccount } from '@/models/Account';
import { SyncEngine } from '@/sync/SyncEngine';

export default class GCalSyncPlugin extends Plugin {
  settings!: GCalSyncSettings;
  syncEngine!: SyncEngine;

  private syncIntervalId: ReturnType<typeof setInterval> | undefined;

  async onload(): Promise<void> {
    await this.loadSettings();

    GoogleAccount.init(this);
    GoogleAccount.loadFromSettings();
    this.refreshCredentials();

    this.syncEngine = new SyncEngine(this);

    this.addSettingTab(new GCalSyncSettingTab(this.app, this));

    this.registerCommands();
    this.registerFileSaveWatcher();
    this.restartSyncInterval();

    // Build index then run initial sync once layout is ready
    this.app.workspace.onLayoutReady(async () => {
      this.syncEngine.buildIndex();
      await this.syncEngine.syncAll();
    });
  }

  onunload(): void {
    if (this.syncIntervalId !== undefined) {
      clearInterval(this.syncIntervalId);
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Ensure nested objects are present after merge
    this.settings.syncTokens = this.settings.syncTokens ?? {};
    this.settings.accounts = this.settings.accounts ?? [];
    this.settings.calendarMapping = this.settings.calendarMapping ?? {};
    this.settings.statusMapping = this.settings.statusMapping ?? {};
    this.settings.propertyMapping = { ...DEFAULT_SETTINGS.propertyMapping, ...this.settings.propertyMapping };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Rebuild the GoogleAccount.credentials object from current settings. */
  refreshCredentials(): void {
    GoogleAccount.credentials = {
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      redirectUri: `http://127.0.0.1:${this.settings.redirectPort}`,
      redirectPort: parseInt(this.settings.redirectPort, 10),
    };
  }

  // ── Sync interval ─────────────────────────────────────────────────────────

  restartSyncInterval(): void {
    if (this.syncIntervalId !== undefined) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = undefined;
    }

    if (!this.settings.syncEnabled || this.settings.syncIntervalMinutes <= 0) return;

    const ms = this.settings.syncIntervalMinutes * 60 * 1000;
    this.syncIntervalId = setInterval(async () => {
      await this.syncEngine.syncAll();
    }, ms);
  }

  // ── File watcher ──────────────────────────────────────────────────────────

  private registerFileSaveWatcher(): void {
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md' && !this.syncEngine.isWriting(file.path)) {
          this.syncEngine.schedulePush(file);
        }
      }),
    );
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private registerCommands(): void {
    this.addCommand({
      id: 'gcal-sync-all',
      name: 'Sync now',
      callback: async () => {
        new Notice('[GCal Sync] Syncing…');
        await this.syncEngine.syncAll();
      },
    });

    this.addCommand({
      id: 'gcal-sync-full',
      name: 'Force full sync (reset sync tokens)',
      callback: async () => {
        this.settings.syncTokens = {};
        await this.saveSettings();
        new Notice('[GCal Sync] Full sync started…');
        await this.syncEngine.syncAll();
      },
    });

    this.addCommand({
      id: 'gcal-push-current-note',
      name: 'Push current note to Google Calendar',
      editorCallback: async (_editor, view) => {
        if (!view.file) return;
        const ok = await this.syncEngine.pushNote(view.file);
        new Notice(ok ? '[GCal Sync] Pushed.' : '[GCal Sync] Nothing to push (no gcal-* frontmatter).');
      },
    });

    this.addCommand({
      id: 'gcal-pull-current-event',
      name: 'Pull current note\'s event from Google Calendar',
      editorCallback: async (_editor, view) => {
        if (!view.file) return;
        const cache = this.app.metadataCache.getFileCache(view.file);
        const pm = this.settings.propertyMapping;
        const eventId: string | undefined = cache?.frontmatter?.[pm.gcalId];
        const categoryVal: string | undefined = cache?.frontmatter?.[pm.category];
        const calendarId: string =
          (categoryVal && this.settings.calendarMapping[categoryVal]) ||
          this.settings.defaultCalendarId;

        if (!eventId) {
          new Notice(`[GCal Sync] No "${pm.gcalId}" field found in frontmatter.`);
          return;
        }

        const account = GoogleAccount.getFirst();
        if (!account?.token) {
          new Notice('[GCal Sync] No authenticated account found.');
          return;
        }

        const { getCalendarService, getEvent } = await import('./api/calendar');
        const service = await getCalendarService({
          credentials: GoogleAccount.credentials,
          token: account.token,
        });
        if (!service) return;

        const event = await getEvent(service, calendarId, eventId, account.accountName);
        if (!event) {
          new Notice('[GCal Sync] Event not found on Google Calendar.');
          return;
        }

        const { buildVaultUpdateFromEvent } = await import('./sync/FrontmatterParser');
        const update = buildVaultUpdateFromEvent(event, this.settings);
        await this.syncEngine.safeProcessFrontMatter(view.file, (fm) => {
          Object.assign(fm, update);
        });

        new Notice('[GCal Sync] Pulled.');
      },
    });
  }
}
