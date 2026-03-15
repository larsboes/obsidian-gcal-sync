# obsidian-gcal-sync

Two-way Google Calendar sync for Obsidian. Notes stay clean — only 2 sync fields per note. Everything else (timezone, calendar routing, email resolution, conflict strategy) lives in plugin config.

> Desktop only (Electron/Node.js required for OAuth callback server and Google API client).

---

## Design philosophy

Most calendar plugins dump raw API fields into every note (`gcal-etag`, `gcal-calendar`, `gcal-account`, `gcal-all-day`, ...). This one doesn't.

The plugin has a **mapping layer** in its settings. Your vault uses clean, readable property names. The plugin translates them to GCal fields on the way out, and back to vault properties on the way in.

```yaml
# What your note looks like:
---
summary: "Hack the North 2026"
start: "2026-09-20T09:00"
end: "2026-09-22T18:00"
location: "Waterloo, ON"
status: confirmed
category: hackathon
people:
  - "[[John Smith]]"     # wikilink → resolved to john@email.com via People note
  - lars@example.com     # plain email, used directly

gcal-id: "abc123"        # ← only 2 fields written by the plugin
gcal-synced: "2026-03-15T18:00:00.000Z"
---
```

---

## Full vault property schema

```yaml
# ── ALWAYS PRESENT ────────────────────────────────────────────
summary: ""
start:                    # YYYY-MM-DD or YYYY-MM-DDTHH:MM
end:
location: ""
status: planned           # planned | confirmed | active | completed | cancelled
category: ""              # trip | conference | hackathon | cfp | meeting | social | workshop
people: []                # [[People note]] links or plain emails
sources: []               # URLs, booking refs (vault-only, not synced)

# ── GCAL SYNC (plugin writes these, do not edit manually) ─────
gcal-id: ""
gcal-synced: ""

# ── TRIP (category: trip) ─────────────────────────────────────
transport: ""             # flight | train | car | mixed
trip_type: ""             # leisure | business | adventure
budget_eur:
spent_eur:
cover: ""
rating:                   # 1–10, fill post-trip
coordinates: []           # [lat, lon]

# ── EVENT (category: conference | hackathon | cfp | workshop) ─
due:                      # registration / CFP deadline
event_type: ""

# ── MEETING (category: meeting) ───────────────────────────────
agenda: ""
outcome: ""
recurring: false
```

> Category-specific fields (`transport`, `agenda`, etc.) are vault-only — they are not synced to GCal.

---

## How the mapping works

```
Vault property    GCal API field        Notes
──────────────────────────────────────────────────────────────
summary         → summary
start           → start.dateTime        plugin adds timezone
end             → end.dateTime          plugin adds timezone
location        → location
people[]        → attendees[]           [[Link]] resolved via People note email property
category        → calendarId            via Calendar Mapping config
status          → status                via Status Mapping config
gcal-id         ← id                    written back on create/pull
gcal-synced     ← updated (timestamp)   written back after every sync
```

All mapping keys (property names) are **configurable** in plugin settings. If your notes use `title` instead of `summary`, change one field — done.

---

## Sync behaviour

### GCal → Vault (pull)
- Uses Google's **incremental sync** (`syncToken`) — only fetches events that changed since last sync
- New event → creates note in configured folder
- Updated event → updates vault properties in frontmatter
- Cancelled event → sets `status: cancelled` in note
- On first run or forced full sync: fetches 1 year of history

### Vault → GCal (push)
- Triggered **2 seconds after saving** a note (debounced)
- Also runs during every scheduled sync cycle
- Note with `start:` but no `gcal-id` → creates GCal event, writes back `gcal-id`
- Note with `gcal-id` → updates existing GCal event

### Conflict detection
Uses `gcal-synced` timestamp as the anchor:
- File modified after `gcal-synced` → note is dirty → needs push
- GCal event `updated` newer than `gcal-synced` → needs pull
- Both → **conflict** → resolved by configured strategy (`vault-wins` or `gcal-wins`)

---

## Setup

### 1. Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project
3. Enable **Google Calendar API**
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Desktop app**
6. Add authorized redirect URI: `http://127.0.0.1:42813` (or your configured port)
7. Copy the **Client ID** and **Client Secret**

### 2. Plugin settings

| Setting | Value |
|---|---|
| Client ID | from GCP |
| Client Secret | from GCP |
| Redirect Port | `42813` (default) |
| Timezone | `Europe/Berlin` |
| Event Folder | `Calendar` |

### 3. Add Google Account

Settings → **Add Google Account** → click **Authenticate with Google** → authorise in browser → dialog closes automatically.

### 4. Calendar Mapping

Map your vault categories to real Google Calendar IDs. The calendar ID is the email-like string shown in Google Calendar settings (e.g. `primary`, `yourname@gmail.com`, or a custom calendar ID).

```
trip        → <Travel calendar ID>
meeting     → <Work calendar ID>
hackathon   → <Events calendar ID>
social      → primary
```

### 5. People resolution

For `people: ["[[John Smith]]"]` to resolve to an email, the linked note must have an `email:` property:

```yaml
# People/John Smith.md
---
email: john@example.com
---
```

---

## Commands

| Command | Description |
|---|---|
| **Sync now** | Run a full sync cycle (pull + push) |
| **Force full sync** | Reset sync tokens, re-pull everything |
| **Push current note** | Immediately push the open note to GCal |
| **Pull current event** | Overwrite open note's frontmatter from GCal |

---

## Settings reference

### Property Mapping

Rename any vault property. Useful if your existing notes use different field names.

| Plugin field | Default vault property | Maps to |
|---|---|---|
| Summary | `summary` | GCal event title |
| Start | `start` | GCal start datetime |
| End | `end` | GCal end datetime |
| Location | `location` | GCal location |
| People | `people` | GCal attendees |
| Status | `status` | GCal status (via Status Mapping) |
| Category | `category` | GCal calendar (via Calendar Mapping) |
| GCal ID field | `gcal-id` | Sync anchor |
| GCal Synced field | `gcal-synced` | Conflict detection anchor |

### Status Mapping

Default:
```
planned   → tentative
confirmed → confirmed
active    → confirmed
completed → confirmed
cancelled → cancelled
```

### Calendar Mapping

Define per-category. Unmapped categories fall back to **Default Calendar** (`primary`).

### Sync Behaviour

| Setting | Default | Description |
|---|---|---|
| Timezone | `Europe/Berlin` | Applied to bare `YYYY-MM-DDTHH:MM` values |
| Conflict strategy | `vault-wins` | What wins when both sides changed |
| Sync interval | `15` min | Pull frequency |
| Auto-create notes | off | Create vault notes for new GCal events (vault-first workflow: keep off) |
| Auto-push changes | on | Push note edits 2s after save |

---

## Installation via BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the Obsidian community plugins
2. BRAT → **Add Beta Plugin** → `larsboes/obsidian-gcal-sync`
3. Enable the plugin in Obsidian settings

---

## Development

```bash
bun install
bun run dev          # watch mode
bun run build        # production build → dist/
bun run release      # interactive version bump → commit + tag → CI publishes

# Install to vault for manual testing
cp dist/main.js manifest.json \
  ~/path/to/vault/.obsidian/plugins/obsidian-gcal-sync/
```

**Stack:** TypeScript · `@googleapis/calendar` · `google-auth-library` · esbuild · Obsidian Plugin API

---

## Auth architecture

No relay server. No third-party dependency. The OAuth flow runs entirely locally:

1. Plugin opens a local HTTP server on `127.0.0.1:<port>`
2. User clicks **Authenticate** → browser opens Google consent screen
3. Google redirects to `http://127.0.0.1:<port>/?code=...`
4. Plugin captures the code, exchanges it for tokens via `google-auth-library`
5. Tokens stored in Obsidian's own `data.json` (plugin-scoped, not `localStorage`)
6. `OAuth2Client` refreshes access tokens automatically

Adapted from [obsidian-google-lookup](https://github.com/ntawileh/obsidian-google-lookup) (MIT).

---

## Credits

Built with inspiration from three existing plugins — each informed a different part of the design:

| Plugin | Author | What it contributed |
|--------|--------|---------------------|
| [obsidian-google-calendar](https://github.com/YukiGasai/obsidian-google-calendar) | YukiGasai | GCal API integration patterns, OAuth desktop flow |
| [obsidian-google-lookup](https://github.com/ntawileh/obsidian-google-lookup) | ntawileh | Local OAuth callback server approach (adapted for auth architecture) |
| [obsidian-contact-sync-plugin](https://github.com/aleksejs1/obsidian-contact-sync-plugin) | aleksejs1 | People note / contact resolution patterns |

The core design (clean 2-field sync layer, property mapping in config, vault-first conflict strategy) is original to this plugin.

---

## Limitations

- Desktop only (no mobile — requires local HTTP server for OAuth)
- Recurring events: synced as individual occurrences
- No calendar view UI — use Obsidian's Dataview or Calendar plugin for visualisation
- `sources`, `budget_eur`, `coordinates` and other trip/event fields are vault-only, not pushed to GCal
