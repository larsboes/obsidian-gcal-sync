import { GCalSyncSettings } from '@/types';

export const DEFAULT_SETTINGS: GCalSyncSettings = {
  // Auth
  clientId: '',
  clientSecret: '',
  redirectPort: '42813',

  // Property mapping — matches the vault schema described in README
  propertyMapping: {
    summary:    'summary',
    start:      'start',
    end:        'end',
    location:   'location',
    people:     'people',
    status:     'status',
    category:   'category',
    gcalId:     'gcal-id',
    gcalSynced: 'gcal-synced',
  },

  // Vault status → GCal status
  statusMapping: {
    discovered: 'tentative',
    planned:    'tentative',
    applied:    'tentative',
    confirmed:  'confirmed',
    active:     'confirmed',
    completed:  'confirmed',
    cancelled:  'cancelled',
    rejected:   'cancelled',
  },

  // Vault category → GCal calendar ID (user fills in real calendar IDs)
  calendarMapping: {
    trip:         'primary',
    conference:   'primary',
    hackathon:    'primary',
    workshop:     'primary',
    meetup:       'primary',
    meeting:      'primary',
    social:       'primary',
    sport:        'primary',
  },

  defaultCalendarId: 'primary',
  timezone: 'Europe/Berlin',
  conflictStrategy: 'vault-wins',

  syncEnabled: true,
  syncIntervalMinutes: 15,
  autoCreateNotesFromEvents: false,
  autoPushNoteChanges: true,

  eventFolder: 'Calendar',
  noteTitleFormat: '{{date}} {{summary}}',

  accounts: [],
  syncTokens: {},
};
