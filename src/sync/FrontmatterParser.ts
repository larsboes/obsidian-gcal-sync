import { App, CachedMetadata, TFile } from 'obsidian';
import { CalendarEvent, GCalSyncSettings } from '@/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the UTC offset string for a given IANA timezone at a specific UTC moment.
 * Uses the sv (Swedish) locale because it formats dates as ISO-like strings.
 * e.g. tzOffsetString("Europe/Berlin", new Date("2026-09-20T07:00:00Z")) → "+02:00"
 */
function tzOffsetString(tz: string, utcDate: Date): string {
  const localStr = new Intl.DateTimeFormat('sv', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(utcDate).replace(' ', 'T');

  // Reparse wall-clock time as UTC, diff against real UTC → that diff is the offset
  const diffMs = new Date(localStr + 'Z').getTime() - utcDate.getTime();
  const sign = diffMs >= 0 ? '+' : '-';
  const abs = Math.abs(Math.round(diffMs / 60000));
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Add one calendar day to a YYYY-MM-DD date string.
 * Used to produce GCal's exclusive end date for all-day events.
 */
function addOneDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().substring(0, 10);
}

/**
 * Apply timezone to a bare date/datetime string.
 * - YYYY-MM-DD              → all-day event, returned as { date }
 * - YYYY-MM-DDTHH:MM        → appends correct offset for configured tz, returned as { dateTime }
 * - Already has offset or Z → returned as-is
 */
function applyTimezone(value: string, tz: string): { dateTime?: string; date?: string } {
  if (!value) return {};

  // All-day: plain YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { date: value };
  }

  // Already has timezone offset or Z — leave it
  if (/Z$/.test(value) || /[+-]\d{2}:?\d{2}$/.test(value)) {
    return { dateTime: value };
  }

  // Bare local datetime — compute the correct offset for `tz` via Intl
  const dt = value.includes('T') ? value : `${value}T00:00:00`;
  try {
    // Parse as UTC to get the approximate date for DST lookup (accurate except at DST boundaries)
    const utcDate = new Date(dt + 'Z');
    const offset = tzOffsetString(tz, utcDate);
    return { dateTime: `${dt}${offset}` };
  } catch {
    return { dateTime: value };
  }
}

/**
 * Resolve vault `people` values to email addresses.
 * Handles:
 *   - Plain email strings: "lars@example.com"
 *   - Wikilinks: "[[John Smith]]" → look up note, read its `email` property
 */
export async function resolvePeopleToEmails(
  people: unknown,
  app: App,
): Promise<string[]> {
  if (!people) return [];
  const items = Array.isArray(people) ? people : [people];
  const emails: string[] = [];

  for (const item of items) {
    const str = String(item).trim();

    // Plain email
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
      emails.push(str);
      continue;
    }

    // Wikilink [[Note Name]] or [[Note Name|Alias]]
    const wikiMatch = str.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
    if (wikiMatch) {
      const noteName = wikiMatch[1];
      const file = app.metadataCache.getFirstLinkpathDest(noteName, '');
      if (file) {
        const cache = app.metadataCache.getFileCache(file);
        const email = cache?.frontmatter?.['email'];
        if (email) emails.push(String(email));
      }
      continue;
    }

    // Bare display name — skip (can't resolve to email without more context)
  }

  return emails;
}

/**
 * Reverse-map a GCal calendarId back to a vault category string.
 * Returns the first matching key, or undefined.
 */
export function calendarIdToCategory(
  calendarId: string,
  calendarMapping: Record<string, string>,
): string | undefined {
  return Object.entries(calendarMapping).find(([, id]) => id === calendarId)?.[0];
}

/**
 * Reverse-map a GCal status to a vault status string.
 */
export function gcalStatusToVault(
  gcalStatus: string,
  statusMapping: Record<string, string>,
): string {
  const entry = Object.entries(statusMapping).find(([, v]) => v === gcalStatus);
  return entry ? entry[0] : gcalStatus;
}

// ── Vault → GCal ─────────────────────────────────────────────────────────────

/**
 * Read vault note frontmatter + optionally body and build a CalendarEvent.
 * Returns undefined if the note has no recognisable event fields.
 */
export async function buildEventFromNote(
  file: TFile,
  cache: CachedMetadata | null,
  app: App,
  settings: GCalSyncSettings,
): Promise<Partial<CalendarEvent> & { calendarId: string } | undefined> {
  const fm = cache?.frontmatter;
  if (!fm) return undefined;

  const pm = settings.propertyMapping;

  const summary: string | undefined = fm[pm.summary];
  const startRaw: string | undefined = fm[pm.start];
  const endRaw: string | undefined = fm[pm.end];

  // A note must have at least a start date to be pushed as a GCal event
  if (!startRaw) return undefined;

  const startObj = applyTimezone(startRaw, settings.timezone);
  const endObj = endRaw
    ? applyTimezone(endRaw, settings.timezone)
    : startObj.date
      ? { date: addOneDay(startObj.date) }  // all-day: GCal end is exclusive next day
      : startObj;                            // datetime: fallback to same as start

  const allDay = !!startObj.date;

  // Resolve category → calendarId
  const categoryVal: string | undefined = fm[pm.category];
  const calendarId: string =
    (categoryVal && settings.calendarMapping[categoryVal]) ||
    settings.defaultCalendarId;

  // Resolve status
  const statusVal: string | undefined = fm[pm.status];
  const gcalStatus: 'confirmed' | 'tentative' | 'cancelled' =
    (statusVal && (settings.statusMapping[statusVal] as any)) ?? 'confirmed';

  // Resolve people → email addresses
  const peopleRaw = fm[pm.people];
  const attendees = await resolvePeopleToEmails(peopleRaw, app);

  return {
    id: fm[pm.gcalId] ?? '',
    calendarId,
    accountName: '',  // filled in by SyncEngine
    summary: summary ?? file.basename,
    start: startObj.dateTime ?? startObj.date ?? startRaw,
    end: endObj.dateTime ?? endObj.date ?? (endRaw ?? startRaw),
    allDay,
    etag: '',
    updated: fm[pm.gcalSynced] ?? '',
    status: gcalStatus,
    location: fm[pm.location] ?? undefined,
    attendees: attendees.length > 0 ? attendees : undefined,
  };
}

// ── GCal → Vault ─────────────────────────────────────────────────────────────

/**
 * Build the frontmatter fields to write back to a vault note after a pull.
 * Only touches the 2 sync fields + the mapped vault properties.
 */
export function buildVaultUpdateFromEvent(
  event: CalendarEvent,
  settings: GCalSyncSettings,
): Record<string, unknown> {
  const pm = settings.propertyMapping;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = {
    // Sync fields (always written)
    [pm.gcalId]: event.id,
    [pm.gcalSynced]: now,

    // Mapped vault properties
    [pm.summary]: event.summary,
    [pm.start]: event.allDay ? event.start : stripTimezone(event.start),
    [pm.end]: event.allDay ? event.end : stripTimezone(event.end),
    [pm.status]: gcalStatusToVault(event.status, settings.statusMapping),
  };

  if (event.location) update[pm.location] = event.location;

  // Reverse-map calendarId → category (only if mapping exists)
  const category = calendarIdToCategory(event.calendarId, settings.calendarMapping);
  if (category) update[pm.category] = category;

  // Attendees → people (email strings; user can manually convert to links)
  if (event.attendees?.length) {
    update[pm.people] = event.attendees;
  }

  return update;
}

/**
 * Strip timezone offset from an ISO string so vault dates stay readable:
 * "2026-03-15T10:00:00+01:00" → "2026-03-15T10:00"
 */
function stripTimezone(iso: string): string {
  // Remove offset (+HH:MM, -HH:MM, or Z)
  return iso.replace(/([T\d])([Z+\-]\d{2}:?\d{2})?$/, (_m, dt) => dt).replace(/:\d{2}$/, (s) =>
    s === ':00' ? '' : s,
  ).replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}).*$/, '$1');
}

// ── Note creation (new note from GCal event) ─────────────────────────────────

/**
 * Build the filename for a new event note.
 * Tokens: {{summary}}, {{date}} (YYYY-MM-DD), {{category}}
 */
export function buildNoteFilename(
  event: CalendarEvent,
  format: string,
  category: string | undefined,
): string {
  const date = event.allDay
    ? event.start.substring(0, 10)
    : event.start.substring(0, 10);

  return (
    format
      .replace('{{summary}}', event.summary)
      .replace('{{date}}', date)
      .replace('{{category}}', category ?? '')
      .replace(/[\\/:*?"<>|]/g, '-')
      .trim() + '.md'
  );
}

/**
 * Build the full Markdown content for a new event note pulled from GCal.
 */
export function buildNoteContent(
  event: CalendarEvent,
  settings: GCalSyncSettings,
): string {
  const pm = settings.propertyMapping;
  const category = calendarIdToCategory(event.calendarId, settings.calendarMapping);
  const vaultStatus = gcalStatusToVault(event.status, settings.statusMapping);
  const now = new Date().toISOString();

  const lines: string[] = ['---'];

  // Clean vault props
  lines.push(`${pm.summary}: "${event.summary.replace(/"/g, '\\"')}"`);
  lines.push(
    `${pm.start}: "${event.allDay ? event.start : stripTimezone(event.start)}"`,
  );
  lines.push(
    `${pm.end}: "${event.allDay ? event.end : stripTimezone(event.end)}"`,
  );
  if (event.location) lines.push(`${pm.location}: "${event.location}"`);
  lines.push(`${pm.status}: ${vaultStatus}`);
  if (category) lines.push(`${pm.category}: ${category}`);

  if (event.attendees?.length) {
    lines.push(`${pm.people}:`);
    event.attendees.forEach((e) => lines.push(`  - ${e}`));
  }

  // 2 sync fields
  lines.push(`${pm.gcalId}: "${event.id}"`);
  lines.push(`${pm.gcalSynced}: "${now}"`);

  lines.push('---', '');

  return lines.join('\n');
}

// ── Conflict detection ────────────────────────────────────────────────────────

/**
 * True when the note was modified (file mtime) after the last sync timestamp.
 * This means the user edited the note and it needs to be pushed.
 */
export function noteIsDirty(
  file: TFile,
  cache: CachedMetadata | null,
  settings: GCalSyncSettings,
): boolean {
  const syncedVal = cache?.frontmatter?.[settings.propertyMapping.gcalSynced];
  if (!syncedVal) return true; // never synced = dirty

  const lastSynced = new Date(syncedVal).getTime();
  return file.stat.mtime > lastSynced + 2000; // 2s grace period for the write itself
}
