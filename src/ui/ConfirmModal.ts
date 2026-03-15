import { App, Modal } from 'obsidian';

export class ConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => void;

  constructor(app: App, message: string, onConfirm: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('p', { text: this.message });

    const btns = contentEl.createDiv({ cls: 'modal-button-container' });

    btns
      .createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.close());

    const confirm = btns.createEl('button', { text: 'Confirm', cls: 'mod-warning' });
    confirm.addEventListener('click', () => {
      this.onConfirm();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
