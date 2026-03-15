export type ConflictStrategy = 'vault-wins' | 'gcal-wins';

export type StoredAccount = {
  accountName: string;
  token: string;
};

/**
 * Maps vault frontmatter property names to the GCal API fields they represent.
 * Every value here is a vault property name — the user can rename them freely.
 */
export type VaultPropertyMapping = {
  summary: string;        // event title            → GCal summary
  start: string;          // start date/datetime    → GCal start.dateTime / start.date
  end: string;            // end date/datetime      → GCal end.dateTime / end.date
  location: string;       // location string        → GCal location
  people: string;         // list of people/emails  → GCal attendees[]
  status: string;         // vault status string    → GCal status (via statusMap)
  category: string;       // event category         → GCal calendarId (via calendarMap)

  // The 2 sync fields the plugin writes back:
  gcalId: string;         // where to store the GCal event ID   (default: "gcal-id")
  gcalSynced: string;     // where to store last sync timestamp  (default: "gcal-synced")
};

/**
 * Maps vault status values to GCal event status values.
 * GCal accepts: "confirmed" | "tentative" | "cancelled"
 */
export type StatusMapping = Record<string, 'confirmed' | 'tentative' | 'cancelled'>;

/**
 * Maps vault category values to Google Calendar IDs.
 * e.g. { trip: "Travel", meeting: "Work", hackathon: "Events" }
 */
export type CalendarMapping = Record<string, string>;

export type GCalSyncSettings = {
  // ── OAuth credentials (user provides own GCP project) ──────────────────────
  clientId: string;
  clientSecret: string;
  redirectPort: string;

  // ── Mapping config ──────────────────────────────────────────────────────────
  propertyMapping: VaultPropertyMapping;
  statusMapping: StatusMapping;
  calendarMapping: CalendarMapping;
  defaultCalendarId: string;   // fallback when category has no mapping

  // ── Sync behaviour ──────────────────────────────────────────────────────────
  timezone: string;                    // e.g. "Europe/Berlin"
  conflictStrategy: ConflictStrategy;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  autoCreateNotesFromEvents: boolean;  // GCal → Vault
  autoPushNoteChanges: boolean;        // Vault → GCal

  // ── Note creation ───────────────────────────────────────────────────────────
  eventFolder: string;
  noteTitleFormat: string;             // tokens: {{summary}}, {{date}}, {{category}}

  // ── Auth state (persisted) ─────────────────────────────────────────────────
  accounts: StoredAccount[];
  syncTokens: Record<string, string>;  // accountName::calendarId → syncToken
};
