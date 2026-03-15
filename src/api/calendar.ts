import { calendar, calendar_v3 } from '@googleapis/calendar';
import { getAuthClient } from './auth';
import { CalendarEvent, GoogleServiceOptions } from '@/types';

// ── Service factory ──────────────────────────────────────────────────────────

export async function getCalendarService(
  opts: GoogleServiceOptions,
): Promise<calendar_v3.Calendar | undefined> {
  const auth = await getAuthClient(opts);
  if (!auth) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return calendar({ version: 'v3', auth: auth as any });
}

// ── Data mapping ─────────────────────────────────────────────────────────────

function mapEvent(
  raw: calendar_v3.Schema$Event,
  calendarId: string,
  accountName: string,
): CalendarEvent {
  const allDay = !!raw.start?.date;
  return {
    id: raw.id ?? '',
    calendarId,
    accountName,
    summary: raw.summary ?? '(No title)',
    description: raw.description ?? undefined,
    start: raw.start?.dateTime ?? raw.start?.date ?? '',
    end: raw.end?.dateTime ?? raw.end?.date ?? '',
    allDay,
    etag: raw.etag ?? '',
    updated: raw.updated ?? '',
    status: raw.status ?? 'confirmed',
    location: raw.location ?? undefined,
    attendees: raw.attendees
      ?.filter((a) => !!a.email)
      .map((a) => a.email as string),
  };
}

// ── List events (full range) ─────────────────────────────────────────────────

export async function listEvents(
  service: calendar_v3.Calendar,
  calendarId: string,
  accountName: string,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;

  do {
    const res = await service.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'updated',
      maxResults: 250,
      pageToken,
    });

    for (const item of res.data.items ?? []) {
      if (item.id) events.push(mapEvent(item, calendarId, accountName));
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return events;
}

// ── Incremental sync (syncToken) ─────────────────────────────────────────────

export type IncrementalSyncResult = {
  events: CalendarEvent[];
  nextSyncToken: string;
};

/**
 * Lists only events that changed since the last sync.
 * On first call pass undefined to get all events + a syncToken.
 * On subsequent calls pass the stored syncToken.
 */
export async function listEventsSince(
  service: calendar_v3.Calendar,
  calendarId: string,
  accountName: string,
  syncToken?: string,
): Promise<IncrementalSyncResult> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken = '';

  do {
    const params: calendar_v3.Params$Resource$Events$List = {
      calendarId,
      singleEvents: true,
      maxResults: 250,
      pageToken,
      ...(syncToken
        ? { syncToken }
        : {
            timeMin: new Date(
              Date.now() - 365 * 24 * 60 * 60 * 1000,
            ).toISOString(), // 1 year back on first full sync
          }),
    };

    const res = await service.events.list(params);

    for (const item of res.data.items ?? []) {
      if (item.id) events.push(mapEvent(item, calendarId, accountName));
    }

    if (res.data.nextSyncToken) {
      nextSyncToken = res.data.nextSyncToken;
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { events, nextSyncToken };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function getEvent(
  service: calendar_v3.Calendar,
  calendarId: string,
  eventId: string,
  accountName: string,
): Promise<CalendarEvent | undefined> {
  try {
    const res = await service.events.get({ calendarId, eventId });
    if (!res.data.id) return undefined;
    return mapEvent(res.data, calendarId, accountName);
  } catch (err) {
    console.error('[gcal-sync] getEvent error:', err);
    return undefined;
  }
}

export async function createEvent(
  service: calendar_v3.Calendar,
  calendarId: string,
  event: Omit<CalendarEvent, 'id' | 'etag' | 'updated' | 'calendarId' | 'accountName'>,
): Promise<CalendarEvent | undefined> {
  try {
    const body: calendar_v3.Schema$Event = {
      summary: event.summary,
      description: event.description,
      location: event.location,
      status: event.status,
      start: event.allDay
        ? { date: event.start.substring(0, 10) }
        : { dateTime: event.start },
      end: event.allDay
        ? { date: event.end.substring(0, 10) }
        : { dateTime: event.end },
      attendees: event.attendees?.map((email) => ({ email })),
    };

    const res = await service.events.insert({ calendarId, requestBody: body });
    if (!res.data.id) return undefined;
    return mapEvent(res.data, calendarId, 'local');
  } catch (err) {
    console.error('[gcal-sync] createEvent error:', err);
    return undefined;
  }
}

export async function updateEvent(
  service: calendar_v3.Calendar,
  calendarId: string,
  eventId: string,
  event: Partial<Omit<CalendarEvent, 'id' | 'calendarId' | 'accountName'>>,
  currentEtag?: string,
): Promise<CalendarEvent | undefined> {
  try {
    const body: calendar_v3.Schema$Event = {
      summary: event.summary,
      description: event.description,
      location: event.location,
      status: event.status,
      ...(event.start && {
        start: event.allDay
          ? { date: event.start.substring(0, 10) }
          : { dateTime: event.start },
      }),
      ...(event.end && {
        end: event.allDay
          ? { date: event.end.substring(0, 10) }
          : { dateTime: event.end },
      }),
      ...(event.attendees && {
        attendees: event.attendees.map((email) => ({ email })),
      }),
    };

    const res = await service.events.patch({
      calendarId,
      eventId,
      requestBody: body,
      // If we have an etag, use If-Match to detect conflicts
      ...(currentEtag && { requestHeaders: { 'If-Match': currentEtag } }),
    });

    if (!res.data.id) return undefined;
    return mapEvent(res.data, calendarId, 'local');
  } catch (err: any) {
    // 412 Precondition Failed = etag mismatch = upstream changed
    if (err?.code === 412) {
      console.warn('[gcal-sync] Conflict detected for event', eventId);
      throw new ConflictError(eventId, calendarId);
    }
    console.error('[gcal-sync] updateEvent error:', err);
    return undefined;
  }
}

export async function deleteEvent(
  service: calendar_v3.Calendar,
  calendarId: string,
  eventId: string,
): Promise<boolean> {
  try {
    await service.events.delete({ calendarId, eventId });
    return true;
  } catch (err) {
    console.error('[gcal-sync] deleteEvent error:', err);
    return false;
  }
}

export async function listCalendars(
  service: calendar_v3.Calendar,
): Promise<calendar_v3.Schema$CalendarListEntry[]> {
  try {
    const res = await service.calendarList.list({ minAccessRole: 'writer' });
    return res.data.items ?? [];
  } catch (err) {
    console.error('[gcal-sync] listCalendars error:', err);
    return [];
  }
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class ConflictError extends Error {
  constructor(
    public readonly eventId: string,
    public readonly calendarId: string,
  ) {
    super(`Conflict on event ${eventId} in calendar ${calendarId}`);
    this.name = 'ConflictError';
  }
}
