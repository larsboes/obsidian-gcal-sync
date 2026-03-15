import { GoogleCredentials } from '@/types';
import type GCalSyncPlugin from '@/main';

/**
 * Represents one authenticated Google account.
 * Tokens are persisted via plugin.saveData() (Obsidian-scoped, not localStorage).
 */
export class GoogleAccount {
  private static _credentials: GoogleCredentials;
  private static _allAccounts: Map<string, GoogleAccount> = new Map();
  private static _plugin: GCalSyncPlugin;

  readonly accountName: string;
  token: string | undefined;

  constructor(accountName: string, token: string | undefined) {
    this.accountName = accountName;
    this.token = token;
  }

  // ── Static helpers ──────────────────────────────────────────────────────────

  static init(plugin: GCalSyncPlugin): void {
    GoogleAccount._plugin = plugin;
    GoogleAccount._allAccounts = new Map();
  }

  static get credentials(): GoogleCredentials {
    return GoogleAccount._credentials;
  }

  static set credentials(c: GoogleCredentials) {
    GoogleAccount._credentials = c;
  }

  static getAll(): GoogleAccount[] {
    return Array.from(GoogleAccount._allAccounts.values());
  }

  static getByName(name: string): GoogleAccount | undefined {
    return GoogleAccount._allAccounts.get(name);
  }

  static getFirst(): GoogleAccount | undefined {
    return GoogleAccount._allAccounts.values().next().value;
  }

  static removeAll(): void {
    GoogleAccount._allAccounts = new Map();
  }

  /** Load accounts from plugin settings (called on plugin load). */
  static loadFromSettings(): void {
    const accounts = GoogleAccount._plugin.settings.accounts ?? [];
    GoogleAccount._allAccounts = new Map();
    for (const { accountName, token } of accounts) {
      GoogleAccount._allAccounts.set(accountName, new GoogleAccount(accountName, token));
    }
  }

  /** Persist current accounts to plugin settings. */
  static async saveToSettings(): Promise<void> {
    const accounts = GoogleAccount.getAll().map((a) => ({
      accountName: a.accountName,
      token: a.token ?? '',
    }));
    GoogleAccount._plugin.settings.accounts = accounts;
    await GoogleAccount._plugin.saveSettings();
  }

  // ── Instance helpers ─────────────────────────────────────────────────────────

  addToStore(): void {
    GoogleAccount._allAccounts.set(this.accountName, this);
  }

  removeFromStore(): void {
    GoogleAccount._allAccounts.delete(this.accountName);
  }

  async persistToken(): Promise<void> {
    // Upsert this account in settings and save
    const existing = GoogleAccount._allAccounts.get(this.accountName);
    if (!existing) this.addToStore();
    await GoogleAccount.saveToSettings();
  }
}
