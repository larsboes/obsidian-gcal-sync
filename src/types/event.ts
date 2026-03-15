/**
 * The 2 fields the plugin writes into every synced vault note.
 * Everything else lives in clean vault properties.
 */
export type SyncFrontmatter = {
  'gcal-id': string;      // GCal event ID — used for matching on next sync
  'gcal-synced': string;  // ISO timestamp of last successful sync
};

/** Internal representation used by the sync engine. */
export type CalendarEvent = {
  id: string;
  calendarId: string;
  accountName: string;
  summary: string;
  description?: string;
  start: string;          // ISO datetime or YYYY-MM-DD for all-day
  end: string;
  allDay: boolean;
  etag: string;
  updated: string;        // server-side last-modified ISO string
  status: string;         // confirmed | tentative | cancelled
  location?: string;
  attendees?: string[];   // email addresses
};
