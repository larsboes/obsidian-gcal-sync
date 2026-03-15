import { App, Notice, TFile } from 'obsidian';
import { calendar_v3 } from '@googleapis/calendar';
import {
  getCalendarService,
  listEventsSince,
  createEvent,
  updateEvent,
  listCalendars,
  ConflictError,
} from '@/api/calendar';
import { GoogleAccount } from '@/models/Account';
import { CalendarEvent, GCalSyncSettings } from '@/types';
import {
  buildEventFromNote,
  buildVaultUpdateFromEvent,
  buildNoteFilename,
  buildNoteContent,
  calendarIdToCategory,
  noteIsDirty,
} from './FrontmatterParser';
import type GCalSyncPlugin from '@/main';

type AccountService = {
  account: GoogleAccount;
  service: calendar_v3.Calendar;
  calendarIds: string[];
};

export class SyncEngine {
  private app: App;
  private plugin: GCalSyncPlugin;
  private pushDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // ── Write guard ────────────────────────────────────────────────────────────
  // Tracks files the plugin is currently writing so the modify event handler
  // doesn't schedule a push for our own writes.
  private writingFiles = new Set<string>();

  isWriting(path: string): boolean {
    return this.writingFiles.has(path);
  }

  async safeProcessFrontMatter(
    file: TFile,
    fn: (fm: Record<string, unknown>) => void,
  ): Promise<void> {
    this.writingFiles.add(file.path);
    try {
      await this.safeProcessFrontMatter(file, fn);
    } finally {
      this.writingFiles.delete(file.path);
    }
  }

  // ── Event note index ───────────────────────────────────────────────────────
  // O(1) lookup by gcal-id. O(k) dirty scan over only event notes instead of all vault files.
  private gcalIdIndex = new Map<string, TFile>(); // gcal-id value → TFile
  private eventNoteFiles = new Set<string>();      // paths of notes with start or gcal-id

  buildIndex(): void {
    this.gcalIdIndex.clear();
    this.eventNoteFiles.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      this.indexFile(file);
    }
  }

  private indexFile(file: TFile): void {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) return;
    const pm = this.settings.propertyMapping;

    const gcalId: string | undefined = fm[pm.gcalId];
    if (gcalId) {
      this.gcalIdIndex.set(gcalId, file);
      this.eventNoteFiles.add(file.path);
    } else if (fm[pm.start]) {
      this.eventNoteFiles.add(file.path);
    }
  }

  private deindexFile(file: TFile): void {
    this.eventNoteFiles.delete(file.path);
    for (const [id, f] of this.gcalIdIndex) {
      if (f.path === file.path) {
        this.gcalIdIndex.delete(id);
        break;
      }
    }
  }

  constructor(plugin: GCalSyncPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;

    // Keep index in sync with vault changes
    plugin.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        this.deindexFile(file);
        this.indexFile(file);
      }),
    );
    plugin.registerEvent(
      this.app.vault.on('delete', (abstractFile) => {
        if (abstractFile instanceof TFile) this.deindexFile(abstractFile);
      }),
    );
    plugin.registerEvent(
      this.app.vault.on('rename', (abstractFile, _oldPath) => {
        if (abstractFile instanceof TFile) {
          this.deindexFile(abstractFile);
          this.indexFile(abstractFile);
        }
      }),
    );
  }

  private get settings(): GCalSyncSettings {
    return this.plugin.settings;
  }

  // ── Full sync ─────────────────────────────────────────────────────────────

  async syncAll(): Promise<void> {
    if (!this.settings.syncEnabled) return;

    const services = await this.buildServices();
    if (services.length === 0) {
      new Notice('[GCal Sync] No authenticated accounts. Go to Settings → Add Google Account.');
      return;
    }

    let pulled = 0;
    let pushed = 0;

    for (const { account, service, calendarIds } of services) {
      for (const calendarId of calendarIds) {
        pulled += await this.pullCalendar(account, service, calendarId);
      }
    }

    if (this.settings.autoPushNoteChanges) {
      pushed = await this.pushAllDirtyNotes(services);
    }

    if (pulled + pushed > 0) {
      new Notice(`[GCal Sync] ↓ ${pulled} pulled  ↑ ${pushed} pushed`);
    }
  }

  // ── Pull ──────────────────────────────────────────────────────────────────

  async pullCalendar(
    account: GoogleAccount,
    service: calendar_v3.Calendar,
    calendarId: string,
  ): Promise<number> {
    const tokenKey = `${account.accountName}::${calendarId}`;
    const existingSyncToken = this.settings.syncTokens[tokenKey];

    let result;
    try {
      result = await listEventsSince(service, calendarId, account.accountName, existingSyncToken);
    } catch (err: any) {
      if (err?.code === 410) {
        // syncToken expired — full re-sync
        delete this.settings.syncTokens[tokenKey];
        await this.plugin.saveSettings();
        result = await listEventsSince(service, calendarId, account.accountName);
      } else {
        console.error('[gcal-sync] pullCalendar error:', err);
        return 0;
      }
    }

    const { events, nextSyncToken } = result;
    this.settings.syncTokens[tokenKey] = nextSyncToken;
    await this.plugin.saveSettings();

    let count = 0;
    for (const event of events) {
      if (await this.applyEventToVault(event)) count++;
    }
    return count;
  }

  private async applyEventToVault(event: CalendarEvent): Promise<boolean> {
    if (event.status === 'cancelled') {
      return this.handleCancelledEvent(event);
    }

    const existing = this.findNoteForEvent(event.id);
    return existing
      ? this.updateNoteFromEvent(existing, event)
      : this.createNoteForEvent(event);
  }

  private async createNoteForEvent(event: CalendarEvent): Promise<boolean> {
    if (!this.settings.autoCreateNotesFromEvents) return false;

    const category = calendarIdToCategory(event.calendarId, this.settings.calendarMapping);
    const filename = buildNoteFilename(event, this.settings.noteTitleFormat, category);
    const folder = this.settings.eventFolder;
    const path = folder ? `${folder}/${filename}` : filename;

    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }

    const content = buildNoteContent(event, this.settings);
    await this.app.vault.create(path, content);
    return true;
  }

  private async updateNoteFromEvent(file: TFile, event: CalendarEvent): Promise<boolean> {
    const cache = this.app.metadataCache.getFileCache(file);
    const pm = this.settings.propertyMapping;

    const lastSynced: string = cache?.frontmatter?.[pm.gcalSynced] ?? '';
    const serverUpdated = event.updated;

    // Nothing new from server
    if (lastSynced && new Date(serverUpdated) <= new Date(lastSynced)) return false;

    // Conflict: note was also modified locally after last sync
    if (noteIsDirty(file, cache, this.settings)) {
      if (this.settings.conflictStrategy === 'vault-wins') {
        // Skip pull — push phase will handle it
        return false;
      }
      console.warn(`[gcal-sync] Conflict on ${file.path} — gcal-wins applied`);
    }

    const update = buildVaultUpdateFromEvent(event, this.settings);
    await this.safeProcessFrontMatter(file, (fm) => {
      Object.assign(fm, update);
    });

    return true;
  }

  private async handleCancelledEvent(event: CalendarEvent): Promise<boolean> {
    const file = this.findNoteForEvent(event.id);
    if (!file) return false;

    const pm = this.settings.propertyMapping;
    await this.safeProcessFrontMatter(file, (fm) => {
      fm[pm.status] = 'cancelled';
      fm[pm.gcalSynced] = new Date().toISOString();
    });
    return true;
  }

  // ── Push ──────────────────────────────────────────────────────────────────

  schedulePush(file: TFile): void {
    if (!this.settings.autoPushNoteChanges) return;

    const key = file.path;
    const existing = this.pushDebounceTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.pushDebounceTimers.delete(key);
      await this.pushNote(file);
    }, 2000);

    this.pushDebounceTimers.set(key, timer);
  }

  async pushNote(file: TFile): Promise<boolean> {
    const cache = this.app.metadataCache.getFileCache(file);
    const pm = this.settings.propertyMapping;

    // Only push notes with a start date or an existing gcal-id
    const hasStart = cache?.frontmatter?.[pm.start];
    const hasId = cache?.frontmatter?.[pm.gcalId];
    if (!hasStart && !hasId) return false;

    const eventData = await buildEventFromNote(file, cache, this.app, this.settings);
    if (!eventData) return false;

    // Resolve account — try to match from the event's calendarId, fallback to first
    const account = GoogleAccount.getFirst();
    if (!account?.token) return false;

    const service = await getCalendarService({
      credentials: GoogleAccount.credentials,
      token: account.token,
    });
    if (!service) return false;

    const eventId = eventData.id;
    const calendarId = eventData.calendarId;

    try {
      if (eventId) {
        // Update existing event
        const updated = await updateEvent(service, calendarId, eventId, {
          summary: eventData.summary,
          description: eventData.description,
          start: eventData.start,
          end: eventData.end,
          allDay: eventData.allDay,
          status: eventData.status,
          location: eventData.location,
          attendees: eventData.attendees,
        });

        if (!updated) return false;

        // Write back only gcal-synced (id is already there)
        await this.safeProcessFrontMatter(file, (fm) => {
          fm[pm.gcalSynced] = new Date().toISOString();
        });
      } else {
        // Create new event
        const created = await createEvent(service, calendarId, {
          summary: eventData.summary ?? file.basename,
          description: eventData.description,
          start: eventData.start ?? new Date().toISOString(),
          end: eventData.end ?? new Date().toISOString(),
          allDay: eventData.allDay ?? false,
          status: eventData.status ?? 'confirmed',
          location: eventData.location,
          attendees: eventData.attendees,
        });

        if (!created) return false;

        // Write back the 2 sync fields
        await this.safeProcessFrontMatter(file, (fm) => {
          fm[pm.gcalId] = created.id;
          fm[pm.gcalSynced] = new Date().toISOString();
        });
      }

      return true;
    } catch (err) {
      if (err instanceof ConflictError) {
        new Notice(`[GCal Sync] Conflict: "${file.basename}" — remote changed since last sync.`);
      } else {
        console.error('[gcal-sync] pushNote error:', err);
      }
      return false;
    }
  }

  async pushAllDirtyNotes(services: AccountService[]): Promise<number> {
    let count = 0;

    for (const path of this.eventNoteFiles) {
      const file = this.app.vault.getFileByPath(path);
      if (!file) continue;

      const cache = this.app.metadataCache.getFileCache(file);
      if (noteIsDirty(file, cache, this.settings)) {
        if (await this.pushNote(file)) count++;
      }
    }

    return count;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  findNoteForEvent(eventId: string): TFile | undefined {
    return this.gcalIdIndex.get(eventId);
  }

  private async buildServices(): Promise<AccountService[]> {
    const result: AccountService[] = [];

    for (const account of GoogleAccount.getAll()) {
      if (!account.token) continue;

      const service = await getCalendarService({
        credentials: GoogleAccount.credentials,
        token: account.token,
      });
      if (!service) continue;

      // Collect calendar IDs from calendarMapping values + defaultCalendarId
      const mappedIds = Object.values(this.settings.calendarMapping).filter(Boolean);
      const calendarIds = [...new Set([...mappedIds, this.settings.defaultCalendarId])];

      // Validate against what the account actually has write access to
      const available = await listCalendars(service);
      const availableIds = new Set(available.map((c) => c.id!));
      const filtered = calendarIds.filter((id) => availableIds.has(id));

      if (filtered.length === 0) {
        // Fallback: sync all writable calendars
        filtered.push(...available.map((c) => c.id!).filter(Boolean));
      }

      result.push({ account, service, calendarIds: filtered });
    }

    return result;
  }
}
