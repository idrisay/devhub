import * as vscode from 'vscode';
import type { AuthManager, ProviderId } from '../infra/AuthManager';
import type { Hub } from '../providers/Hub';
import type { ProviderHealth } from '../providers/Provider';

interface Node {
  id: ProviderId;
  name: string;
  health: ProviderHealth;
  detail?: string;
  hint?: string;
  /** Whether there is a stored token to clear. */
  connected: boolean;
}

const ICONS: Record<ProviderHealth, { icon: string; color?: string }> = {
  ok: { icon: 'pass-filled', color: 'testing.iconPassed' },
  unconfigured: { icon: 'circle-large-outline' },
  'auth-expired': { icon: 'key', color: 'problemsWarningIcon.foreground' },
  'rate-limited': { icon: 'watch', color: 'problemsWarningIcon.foreground' },
  error: { icon: 'error', color: 'problemsErrorIcon.foreground' }
};

/**
 * A visible health readout per provider removes most of the "why isn't it
 * working" guesswork, and gives auth failures somewhere to land.
 */
export class ProviderTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly hub: Hub,
    private readonly auth: AuthManager
  ) {
    this.subscription = hub.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(node.name);
    const { icon, color } = ICONS[node.health];
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.description = node.detail ?? node.health.replace('-', ' ');
    item.tooltip = node.hint ?? node.detail ?? `${node.name}: ${node.health}`;
    // Gates the row's context menu: you can only clear a credential that
    // exists, and health alone can't tell you that — an unconfigured provider
    // may be missing a setting, a token, or both.
    item.contextValue = node.connected ? 'devhub.provider.connected' : 'devhub.provider.empty';
    if (node.health !== 'ok') {
      item.command = {
        command: 'devhub.signIn',
        title: `Connect ${node.name}`,
        arguments: [node.id]
      };
    }
    return item;
  }

  async getChildren(): Promise<Node[]> {
    return Promise.all(
      this.hub.statuses().map(async ({ id, name, status }) => ({
        id,
        name,
        health: status.health,
        detail: status.detail,
        hint: status.hint,
        connected: await this.auth.hasToken(id)
      }))
    );
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
