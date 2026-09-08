import * as vscode from 'vscode';
import type { Hub, HubSnapshot } from '../providers/Hub';
import type { LocatedIssue } from '../providers/sentry/SentryProvider';

type Node =
  | { kind: 'error'; issue: LocatedIssue }
  | { kind: 'frame'; file: string; line: number; label: string }
  | { kind: 'message'; label: string; icon: string; command?: vscode.Command };

function formatCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

export class ErrorTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private snapshot: HubSnapshot;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly hub: Hub) {
    this.snapshot = hub.current;
    this.subscription = hub.onDidChange((s) => {
      this.snapshot = s;
      this._onDidChangeTreeData.fire();
    });
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'error': {
        const { issue } = node;
        const item = new vscode.TreeItem(
          issue.title,
          issue.locations.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        item.description = `${formatCount(issue.count)} events · ${formatCount(issue.userCount)} users`;
        item.iconPath = new vscode.ThemeIcon(
          issue.level === 'error' || issue.level === 'fatal' ? 'error' : 'warning',
          new vscode.ThemeColor(
            issue.matchesDiff ? 'problemsErrorIcon.foreground' : 'problemsWarningIcon.foreground'
          )
        );
        const tooltip = new vscode.MarkdownString('', true);
        tooltip.appendMarkdown(`**${issue.title}**\n\n`);
        tooltip.appendMarkdown(`${issue.culprit}\n\n`);
        if (issue.matchesDiff) {
          tooltip.appendMarkdown('$(git-compare) Touches a file you changed on this branch\n\n');
        }
        tooltip.appendMarkdown(`Last seen ${new Date(issue.lastSeen).toLocaleString()}`);
        item.tooltip = tooltip;
        item.contextValue = 'devhub.error';
        item.command = {
          command: 'vscode.open',
          title: 'Open in Sentry',
          arguments: [vscode.Uri.parse(issue.permalink)]
        };
        return item;
      }
      case 'frame': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon('symbol-method');
        item.description = `${vscode.workspace.asRelativePath(node.file)}:${node.line}`;
        item.command = {
          command: 'vscode.open',
          title: 'Go to line',
          arguments: [
            vscode.Uri.file(node.file),
            { selection: new vscode.Range(node.line - 1, 0, node.line - 1, 0) }
          ]
        };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.command) {
          item.command = node.command;
        }
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (node) {
      if (node.kind !== 'error') {
        return [];
      }
      return node.issue.locations.slice(0, 6).map((l) => ({
        kind: 'frame',
        file: l.file,
        line: l.line,
        label: l.function ?? 'anonymous'
      }));
    }

    const status = this.hub.sentry.status();
    if (status.health === 'unconfigured') {
      return [
        {
          kind: 'message',
          label: status.detail ?? 'Sentry is not connected',
          icon: 'plug',
          command: { command: 'devhub.signIn', title: 'Connect a service' }
        }
      ];
    }
    if (status.health === 'auth-expired') {
      return [
        {
          kind: 'message',
          label: 'Sentry credentials rejected — reconnect',
          icon: 'key',
          command: { command: 'devhub.signIn', title: 'Connect a service' }
        }
      ];
    }
    if (status.health === 'rate-limited') {
      return [{ kind: 'message', label: 'Rate limited — backing off', icon: 'watch' }];
    }

    if (this.snapshot.errors.length === 0) {
      return [
        {
          kind: 'message',
          label: this.snapshot.loading ? 'Loading…' : 'No production errors in your changes',
          icon: this.snapshot.loading ? 'sync~spin' : 'pass'
        }
      ];
    }

    return this.snapshot.errors.map((issue) => ({ kind: 'error', issue }));
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
