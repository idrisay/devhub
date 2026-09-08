import * as vscode from 'vscode';
import { log } from './Logger';

export type ProviderId = 'jira' | 'figma' | 'sentry' | 'github';

interface CredentialSpec {
  label: string;
  prompt: string;
  helpUrl: string;
  /** Settings that must be filled in before the token is any use. */
  requiredSettings: { key: string; label: string; placeholder: string }[];
}

const SPECS: Record<ProviderId, CredentialSpec> = {
  jira: {
    label: 'Jira',
    prompt: 'Atlassian API token',
    helpUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    requiredSettings: [
      { key: 'jira.baseUrl', label: 'Jira site URL', placeholder: 'https://acme.atlassian.net' },
      { key: 'jira.email', label: 'Atlassian account email', placeholder: 'you@acme.com' }
    ]
  },
  figma: {
    label: 'Figma',
    prompt: 'Figma personal access token',
    helpUrl: 'https://www.figma.com/developers/api#access-tokens',
    requiredSettings: []
  },
  sentry: {
    label: 'Sentry',
    prompt: 'Sentry auth token with project:read and event:read',
    helpUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    requiredSettings: [
      { key: 'sentry.organization', label: 'Sentry organization slug', placeholder: 'acme' }
    ]
  },
  github: {
    label: 'GitHub',
    prompt: 'GitHub token with repo and read:org',
    helpUrl: 'https://github.com/settings/tokens',
    requiredSettings: []
  }
};

const KEY = (id: ProviderId) => `devhub.token.${id}`;

/**
 * Proves a candidate token works before it is persisted, and resolves to the
 * identity it belongs to. Rejecting with a useful `message` is the contract —
 * that message is what the user sees.
 */
export type TokenValidator = (token: string) => Promise<string>;

export interface ConnectResult {
  stored: boolean;
  /** Set when a validator ran and vouched for the token. */
  identity?: string;
}

/**
 * Tokens live in SecretStorage only. They must never be written to settings.json,
 * which syncs in plaintext and ends up in dotfile repos.
 */
export class AuthManager {
  private readonly _onDidChange = new vscode.EventEmitter<ProviderId>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getToken(id: ProviderId): Promise<string | undefined> {
    return this.secrets.get(KEY(id));
  }

  async hasToken(id: ProviderId): Promise<boolean> {
    return (await this.getToken(id)) !== undefined;
  }

  /**
   * Prompts for any missing settings first, then the token itself. When a
   * validator is supplied the token is only persisted if it passes, so a
   * rejected token never becomes stored state you have to notice and undo.
   */
  async connect(id: ProviderId, validate?: TokenValidator): Promise<ConnectResult> {
    const spec = SPECS[id];
    const settings = vscode.workspace.getConfiguration('devhub');

    for (const setting of spec.requiredSettings) {
      const current = settings.get<string>(setting.key, '');
      if (current) {
        continue;
      }
      const value = await vscode.window.showInputBox({
        title: `DevHub — connect ${spec.label}`,
        prompt: setting.label,
        placeHolder: setting.placeholder,
        ignoreFocusOut: true
      });
      if (!value) {
        return { stored: false };
      }
      await settings.update(setting.key, value.trim(), vscode.ConfigurationTarget.Global);
    }

    const token = await vscode.window.showInputBox({
      title: `DevHub — connect ${spec.label}`,
      prompt: `${spec.prompt}. Create one at ${spec.helpUrl}`,
      password: true,
      ignoreFocusOut: true
    });

    if (!token) {
      return { stored: false };
    }

    const trimmed = token.trim();
    let identity: string | undefined;

    if (validate) {
      try {
        identity = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `DevHub: checking your ${spec.label} token…`
          },
          () => validate(trimmed)
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Rejected ${id} token`, err);
        void vscode.window
          .showErrorMessage(`DevHub: ${message}`, 'Show logs')
          .then((choice) => choice === 'Show logs' && log.show());
        return { stored: false };
      }
    }

    await this.secrets.store(KEY(id), trimmed);
    log.info(`Stored credentials for ${id}`);
    this._onDidChange.fire(id);
    return { stored: true, identity };
  }

  async disconnect(id: ProviderId): Promise<void> {
    await this.secrets.delete(KEY(id));
    log.info(`Cleared credentials for ${id}`);
    this._onDidChange.fire(id);
  }

  /**
   * Resets the non-secret settings a provider needs, so the next `connect`
   * asks for them again. Kept separate from `disconnect`: a wrong token and a
   * wrong site URL are different mistakes, and clearing the token is the far
   * more common one.
   */
  async clearRequiredSettings(id: ProviderId): Promise<void> {
    const settings = vscode.workspace.getConfiguration('devhub');
    for (const setting of SPECS[id].requiredSettings) {
      await settings.update(setting.key, undefined, vscode.ConfigurationTarget.Global);
    }
    log.info(`Cleared settings for ${id}`);
  }

  static requiredSettingLabels(id: ProviderId): string[] {
    return SPECS[id].requiredSettings.map((setting) => setting.label);
  }

  static label(id: ProviderId): string {
    return SPECS[id].label;
  }

  static isProviderId(value: unknown): value is ProviderId {
    return typeof value === 'string' && value in SPECS;
  }

  static all(): ProviderId[] {
    return Object.keys(SPECS) as ProviderId[];
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
