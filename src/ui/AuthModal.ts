import http from 'http';
import { App, Modal, Notice } from 'obsidian';
import { getAuthUrl, exchangeCodeForToken, getAccountEmail } from '@/api/auth';
import { GoogleAccount } from '@/models/Account';
import type GCalSyncPlugin from '@/main';

/**
 * Opens a local HTTP server on the configured redirect port,
 * launches the Google OAuth consent screen in the default browser,
 * and captures the auth code on redirect.
 *
 * Copied and adapted from obsidian-google-lookup (MIT).
 */
export class AuthModal extends Modal {
  private server: http.Server | undefined;
  private plugin: GCalSyncPlugin;
  private existingAccount: GoogleAccount | undefined;
  private onComplete: () => void;

  private constructor(
    app: App,
    plugin: GCalSyncPlugin,
    existingAccount: GoogleAccount | undefined,
    onComplete: () => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.existingAccount = existingAccount;
    this.onComplete = onComplete;
  }

  static open(
    app: App,
    plugin: GCalSyncPlugin,
    existingAccount: GoogleAccount | undefined,
    onComplete: () => void,
  ): void {
    new AuthModal(app, plugin, existingAccount, onComplete).open();
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    const credentials = GoogleAccount.credentials;

    if (!credentials.clientId || !credentials.clientSecret) {
      contentEl.createEl('p', {
        text: 'Please fill in your Google Cloud Client ID and Client Secret in settings first.',
      });
      return;
    }

    const authUrl = await getAuthUrl(credentials);

    contentEl.createEl('h3', {
      text: this.existingAccount
        ? `Re-authenticate "${this.existingAccount.accountName}"`
        : 'Add Google Account',
    });
    contentEl.createEl('p', {
      text: 'Click the button below. After authorising in your browser, this dialog will close automatically.',
    });

    contentEl
      .createEl('button', { text: 'Authenticate with Google', cls: 'mod-cta' })
      .addEventListener('click', () => window.open(authUrl, '_blank'));

    // Spin up local callback server
    this.server = http
      .createServer(async (req, res) => {
        if (!req.url) return res.end('Not found');

        const url = req.url.replace('%2F', '/');
        const match = url.match(/[?&]code=([^&]+)/);

        if (match && match[1]) {
          res.statusCode = 200;
          res.end('Authenticated — you can close this tab and return to Obsidian.');
          await this.handleCode(match[1]);
        } else {
          res.statusCode = 400;
          res.end('Missing code parameter.');
        }
      })
      .listen(credentials.redirectPort);
  }

  private async handleCode(code: string): Promise<void> {
    const credentials = GoogleAccount.credentials;
    const token = await exchangeCodeForToken(credentials, code);

    if (!token) {
      new Notice('[GCal Sync] Authentication failed — could not exchange code for token.');
      this.close();
      return;
    }

    // Resolve account name from the token
    const email = await getAccountEmail({ credentials, token });
    const accountName = email ?? `account-${Date.now()}`;

    const account = this.existingAccount ?? new GoogleAccount(accountName, token);
    account.token = token;
    account.addToStore();
    await GoogleAccount.saveToSettings();

    new Notice(`[GCal Sync] Authenticated as ${accountName}`);
    this.onComplete();
    setTimeout(() => this.close(), 600);
  }

  onClose(): void {
    this.server?.close();
    this.contentEl.empty();
  }
}
