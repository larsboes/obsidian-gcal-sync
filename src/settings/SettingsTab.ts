import { App, PluginSettingTab, Setting, Notice, ButtonComponent } from 'obsidian';
import { GoogleAccount } from '@/models/Account';
import { AuthModal } from '@/ui/AuthModal';
import { ConfirmModal } from '@/ui/ConfirmModal';
import { DEFAULT_SETTINGS } from './defaults';
import type GCalSyncPlugin from '@/main';

export class GCalSyncSettingTab extends PluginSettingTab {
  plugin: GCalSyncPlugin;
  private accountsEl!: HTMLElement;

  constructor(app: App, plugin: GCalSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderCredentials(containerEl);
    this.renderAccounts(containerEl);
    this.renderPropertyMapping(containerEl);
    this.renderStatusMapping(containerEl);
    this.renderCalendarMapping(containerEl);
    this.renderSyncBehaviour(containerEl);
    this.renderNoteOrganisation(containerEl);
    this.renderActions(containerEl);
  }

  // ── OAuth credentials ─────────────────────────────────────────────────────

  private renderCredentials(el: HTMLElement): void {
    el.createEl('h2', { text: 'Google Cloud Credentials' });
    el.createEl('p', {
      text: 'Create a project at console.cloud.google.com → Enable Calendar API → OAuth 2.0 Client ID (Desktop app) → add http://127.0.0.1:<port> as redirect URI.',
      cls: 'setting-item-description',
    });

    new Setting(el)
      .setName('Client ID')
      .addText((t) =>
        t
          .setPlaceholder('123456-xxx.apps.googleusercontent.com')
          .setValue(this.plugin.settings.clientId)
          .onChange(async (v) => {
            this.plugin.settings.clientId = v.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshCredentials();
          }),
      );

    new Setting(el)
      .setName('Client Secret')
      .addText((t) =>
        t
          .setPlaceholder('GOCSPX-...')
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (v) => {
            this.plugin.settings.clientSecret = v.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshCredentials();
          }),
      );

    new Setting(el)
      .setName('Redirect port')
      .setDesc('Port for the local OAuth callback server')
      .addText((t) =>
        t
          .setPlaceholder('42813')
          .setValue(this.plugin.settings.redirectPort)
          .onChange(async (v) => {
            this.plugin.settings.redirectPort = v.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshCredentials();
          }),
      );
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  private renderAccounts(el: HTMLElement): void {
    el.createEl('h2', { text: 'Accounts' });
    this.accountsEl = el.createDiv();
    this.refreshAccountList();
  }

  private refreshAccountList(): void {
    this.accountsEl.empty();

    for (const account of GoogleAccount.getAll()) {
      new Setting(this.accountsEl)
        .setName(account.accountName)
        .addExtraButton((b) =>
          b.setIcon('reset').setTooltip('Re-authenticate').onClick(() => {
            AuthModal.open(this.app, this.plugin, account, () => this.refreshAccountList());
          }),
        )
        .addExtraButton((b) =>
          b.setIcon('trash').setTooltip('Remove account').onClick(() => {
            new ConfirmModal(this.app, `Remove "${account.accountName}"?`, async () => {
              account.removeFromStore();
              await GoogleAccount.saveToSettings();
              this.refreshAccountList();
            }).open();
          }),
        );
    }

    new Setting(this.accountsEl)
      .addButton((b) => b.setButtonText('Add Google Account').setCta().onClick(() => {
        AuthModal.open(this.app, this.plugin, undefined, () => this.refreshAccountList());
      }));
  }

  // ── Property mapping ──────────────────────────────────────────────────────

  private renderPropertyMapping(el: HTMLElement): void {
    el.createEl('h2', { text: 'Property Mapping' });
    el.createEl('p', {
      text: 'Map your vault frontmatter property names to the GCal fields they represent. Change these if your notes use different property names (e.g. "title" instead of "summary").',
      cls: 'setting-item-description',
    });

    const pm = this.plugin.settings.propertyMapping;
    const def = DEFAULT_SETTINGS.propertyMapping;

    const fields: Array<{ key: keyof typeof pm; label: string; desc: string }> = [
      { key: 'summary',    label: 'Summary / Title',  desc: 'Event title → GCal summary' },
      { key: 'start',      label: 'Start',            desc: 'Start date/time → GCal start' },
      { key: 'end',        label: 'End',              desc: 'End date/time → GCal end' },
      { key: 'location',   label: 'Location',         desc: 'Location string → GCal location' },
      { key: 'people',     label: 'People',           desc: 'List of [[links]] or emails → GCal attendees' },
      { key: 'status',     label: 'Status',           desc: 'Event status → GCal status (via Status Mapping below)' },
      { key: 'category',   label: 'Category',         desc: 'Event category → GCal calendar (via Calendar Mapping below)' },
      { key: 'gcalId',     label: 'GCal ID field',    desc: 'Where the plugin stores the GCal event ID' },
      { key: 'gcalSynced', label: 'GCal Synced field',desc: 'Where the plugin stores the last sync timestamp' },
    ];

    for (const { key, label, desc } of fields) {
      new Setting(el)
        .setName(label)
        .setDesc(desc)
        .addText((t) =>
          t
            .setPlaceholder(def[key])
            .setValue(pm[key])
            .onChange(async (v) => {
              this.plugin.settings.propertyMapping[key] = v.trim() || def[key];
              await this.plugin.saveSettings();
            }),
        );
    }
  }

  // ── Status mapping ────────────────────────────────────────────────────────

  private renderStatusMapping(el: HTMLElement): void {
    el.createEl('h2', { text: 'Status Mapping' });
    el.createEl('p', {
      text: 'Map vault status values to GCal status values. GCal accepts: confirmed, tentative, cancelled.',
      cls: 'setting-item-description',
    });

    const mapEl = el.createDiv();
    this.refreshStatusMappingRows(mapEl);
  }

  private refreshStatusMappingRows(el: HTMLElement): void {
    el.empty();
    const sm = this.plugin.settings.statusMapping;

    for (const [vaultStatus, gcalStatus] of Object.entries(sm)) {
      const row = new Setting(el)
        .setName(`${vaultStatus} → ${gcalStatus}`)
        .addExtraButton((b) =>
          b.setIcon('trash').setTooltip('Remove').onClick(async () => {
            delete this.plugin.settings.statusMapping[vaultStatus];
            await this.plugin.saveSettings();
            this.refreshStatusMappingRows(el);
          }),
        );
    }

    // Add new entry
    let newVault = '';
    let newGcal: 'confirmed' | 'tentative' | 'cancelled' = 'confirmed';

    new Setting(el)
      .setName('Add mapping')
      .addText((t) => t.setPlaceholder('vault status').onChange((v) => (newVault = v.trim())))
      .addDropdown((d) =>
        d
          .addOption('confirmed', 'confirmed')
          .addOption('tentative', 'tentative')
          .addOption('cancelled', 'cancelled')
          .setValue('confirmed')
          .onChange((v) => (newGcal = v as any)),
      )
      .addButton((b) =>
        b.setButtonText('Add').onClick(async () => {
          if (!newVault) return;
          this.plugin.settings.statusMapping[newVault] = newGcal;
          await this.plugin.saveSettings();
          this.refreshStatusMappingRows(el);
        }),
      );
  }

  // ── Calendar mapping ──────────────────────────────────────────────────────

  private renderCalendarMapping(el: HTMLElement): void {
    el.createEl('h2', { text: 'Calendar Mapping' });
    el.createEl('p', {
      text: 'Map vault category values to Google Calendar IDs. Calendar ID is the email-like string shown in Google Calendar settings (e.g. primary, yourname@gmail.com).',
      cls: 'setting-item-description',
    });

    new Setting(el)
      .setName('Default calendar')
      .setDesc('Fallback calendar ID when a note\'s category has no mapping')
      .addText((t) =>
        t
          .setPlaceholder('primary')
          .setValue(this.plugin.settings.defaultCalendarId)
          .onChange(async (v) => {
            this.plugin.settings.defaultCalendarId = v.trim() || 'primary';
            await this.plugin.saveSettings();
          }),
      );

    const mapEl = el.createDiv();
    this.refreshCalendarMappingRows(mapEl);
  }

  private refreshCalendarMappingRows(el: HTMLElement): void {
    el.empty();
    const cm = this.plugin.settings.calendarMapping;

    for (const [category, calendarId] of Object.entries(cm)) {
      new Setting(el)
        .setName(category)
        .addText((t) =>
          t
            .setPlaceholder('primary')
            .setValue(calendarId)
            .onChange(async (v) => {
              this.plugin.settings.calendarMapping[category] = v.trim();
              await this.plugin.saveSettings();
            }),
        )
        .addExtraButton((b) =>
          b.setIcon('trash').setTooltip('Remove category').onClick(async () => {
            delete this.plugin.settings.calendarMapping[category];
            await this.plugin.saveSettings();
            this.refreshCalendarMappingRows(el);
          }),
        );
    }

    // Add new category
    let newCategory = '';
    new Setting(el)
      .setName('Add category')
      .addText((t) => t.setPlaceholder('category name').onChange((v) => (newCategory = v.trim())))
      .addButton((b) =>
        b.setButtonText('Add').onClick(async () => {
          if (!newCategory) return;
          this.plugin.settings.calendarMapping[newCategory] = this.plugin.settings.defaultCalendarId;
          await this.plugin.saveSettings();
          this.refreshCalendarMappingRows(el);
        }),
      );
  }

  // ── Sync behaviour ────────────────────────────────────────────────────────

  private renderSyncBehaviour(el: HTMLElement): void {
    el.createEl('h2', { text: 'Sync Behaviour' });

    new Setting(el)
      .setName('Timezone')
      .setDesc('Applied to bare dates/datetimes when pushing to GCal')
      .addText((t) =>
        t
          .setPlaceholder('Europe/Berlin')
          .setValue(this.plugin.settings.timezone)
          .onChange(async (v) => {
            this.plugin.settings.timezone = v.trim() || 'Europe/Berlin';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Conflict strategy')
      .setDesc('When both sides changed since last sync — which wins?')
      .addDropdown((d) =>
        d
          .addOption('vault-wins', 'Vault wins (note overwrites GCal)')
          .addOption('gcal-wins', 'GCal wins (GCal overwrites note)')
          .setValue(this.plugin.settings.conflictStrategy)
          .onChange(async (v: string) => {
            this.plugin.settings.conflictStrategy = v as 'vault-wins' | 'gcal-wins';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Enable sync')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncEnabled).onChange(async (v) => {
          this.plugin.settings.syncEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.restartSyncInterval();
        }),
      );

    new Setting(el)
      .setName('Sync interval (minutes)')
      .addText((t) =>
        t
          .setPlaceholder('15')
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (v) => {
            const n = parseInt(v);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.syncIntervalMinutes = n;
              await this.plugin.saveSettings();
              this.plugin.restartSyncInterval();
            }
          }),
      );

    new Setting(el)
      .setName('Auto-create notes from GCal events')
      .setDesc('Create a vault note for each new event pulled from GCal')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoCreateNotesFromEvents).onChange(async (v) => {
          this.plugin.settings.autoCreateNotesFromEvents = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName('Auto-push note changes to GCal')
      .setDesc('Push edits back to GCal 2 seconds after saving a note')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoPushNoteChanges).onChange(async (v) => {
          this.plugin.settings.autoPushNoteChanges = v;
          await this.plugin.saveSettings();
        }),
      );

  }

  // ── Note organisation ─────────────────────────────────────────────────────

  private renderNoteOrganisation(el: HTMLElement): void {
    el.createEl('h2', { text: 'Note Organisation' });

    new Setting(el)
      .setName('Event notes folder')
      .setDesc('Vault folder for auto-created event notes')
      .addText((t) =>
        t
          .setPlaceholder('Calendar')
          .setValue(this.plugin.settings.eventFolder)
          .onChange(async (v) => {
            this.plugin.settings.eventFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Note title format')
      .setDesc('Tokens: {{summary}}, {{date}} (YYYY-MM-DD), {{category}}')
      .addText((t) =>
        t
          .setPlaceholder('{{date}} {{summary}}')
          .setValue(this.plugin.settings.noteTitleFormat)
          .onChange(async (v) => {
            this.plugin.settings.noteTitleFormat = v.trim() || '{{date}} {{summary}}';
            await this.plugin.saveSettings();
          }),
      );
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private renderActions(el: HTMLElement): void {
    el.createEl('h2', { text: 'Actions' });

    new Setting(el)
      .setName('Force full sync')
      .setDesc('Resets sync tokens and re-pulls everything from GCal')
      .addButton((b) =>
        b.setButtonText('Full sync').setCta().onClick(async () => {
          this.plugin.settings.syncTokens = {};
          await this.plugin.saveSettings();
          new Notice('[GCal Sync] Full sync started…');
          await this.plugin.syncEngine.syncAll();
        }),
      );

    new Setting(el)
      .setName('Reset property mapping')
      .setDesc('Restore all property names to defaults')
      .addButton((b) =>
        b.setButtonText('Reset').setWarning().onClick(async () => {
          this.plugin.settings.propertyMapping = { ...DEFAULT_SETTINGS.propertyMapping };
          await this.plugin.saveSettings();
          this.display();
        }),
      );
  }
}
