import * as vscode from 'vscode';
import { formatAge } from '../providers/github/pullStatus';
import type { GrafanaAlert, LatencySnapshot, SlowEndpoint } from '../providers/grafana/GrafanaProvider';
import { formatDuration } from '../providers/grafana/latencyQuery';
import { answered } from '../providers/refreshPlan';
import type { Hub, HubSnapshot } from '../providers/Hub';

type Node =
  | { kind: 'group'; group: 'alerts' | 'latency' }
  | { kind: 'alert'; alert: GrafanaAlert }
  | { kind: 'endpoint'; endpoint: SlowEndpoint; snapshot: LatencySnapshot }
  | { kind: 'message'; label: string; icon: string; tooltip?: string; command?: vscode.Command };

const CRITICAL = new Set(['critical', 'error', 'high', 'page']);

function alertIcon(alert: GrafanaAlert): vscode.ThemeIcon {
  if (alert.state === 'pending') {
    return new vscode.ThemeIcon('clock', new vscode.ThemeColor('problemsWarningIcon.foreground'));
  }
  const severe = CRITICAL.has((alert.severity ?? '').toLowerCase());
  return new vscode.ThemeIcon(
    'flame',
    new vscode.ThemeColor(severe ? 'problemsErrorIcon.foreground' : 'problemsWarningIcon.foreground')
  );
}

function alertDescription(alert: GrafanaAlert): string {
  const parts: string[] = [];
  if (alert.state === 'pending') {
    parts.push('Pending');
  }
  if (alert.severity) {
    parts.push(alert.severity);
  }
  if (alert.instances > 1) {
    parts.push(`${alert.instances} series`);
  }
  const age = alert.activeAt ? formatAge(alert.activeAt) : undefined;
  if (age) {
    parts.push(`for ${age}`);
  }
  return parts.join(' · ');
}

/**
 * Grafana in two groups: what is on fire in the service this repository is,
 * and what is slow in it. Both answer the same question the Errors view does —
 * is what I shipped holding up — from the metrics side rather than the
 * exception side.
 */
export class MonitoringTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
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
      case 'group': {
        const alerts = node.group === 'alerts';
        const item = new vscode.TreeItem(
          alerts ? 'Firing alerts' : 'Slowest endpoints',
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon(alerts ? 'bell' : 'pulse');
        item.description = alerts
          ? this.snapshot.alerts.length > 0
            ? String(this.snapshot.alerts.length)
            : ''
          : this.snapshot.latency
            ? `p95 · last ${this.snapshot.latency.window}`
            : '';
        item.contextValue = `devhub.grafana.${node.group}`;
        return item;
      }
      case 'alert': {
        const { alert } = node;
        const item = new vscode.TreeItem(alert.name);
        item.description = alertDescription(alert);
        item.iconPath = alertIcon(alert);
        item.contextValue = 'devhub.alert';

        const tooltip = new vscode.MarkdownString('', true);
        tooltip.appendMarkdown(`**${alert.name}**\n\n`);
        if (alert.summary) {
          tooltip.appendMarkdown(`${alert.summary}\n\n`);
        }
        if (alert.matchedBy === 'ticket') {
          tooltip.appendMarkdown('$(link) Names the ticket on this branch\n\n');
        }
        if (alert.folder) {
          tooltip.appendMarkdown(`Folder: ${alert.folder}\n\n`);
        }
        const labels = Object.entries(alert.labels)
          .filter(([key]) => !key.startsWith('__'))
          .slice(0, 8)
          .map(([key, value]) => `\`${key}=${value}\``)
          .join(' ');
        if (labels) {
          tooltip.appendMarkdown(`${labels}\n\n`);
        }
        if (alert.activeAt) {
          tooltip.appendMarkdown(`Active since ${new Date(alert.activeAt).toLocaleString()}`);
        }
        item.tooltip = tooltip;

        item.command = {
          command: 'vscode.open',
          title: 'Open in Grafana',
          arguments: [vscode.Uri.parse(alert.url)]
        };
        return item;
      }
      case 'endpoint': {
        const item = new vscode.TreeItem(node.endpoint.label);
        item.description = formatDuration(node.endpoint.seconds);
        item.iconPath = new vscode.ThemeIcon('watch');
        item.contextValue = 'devhub.endpoint';

        const tooltip = new vscode.MarkdownString('', true);
        tooltip.appendMarkdown(`**${node.endpoint.label}** — ${formatDuration(node.endpoint.seconds)}\n\n`);
        const labels = Object.entries(node.endpoint.metric)
          .filter(([key]) => key !== '__name__')
          .map(([key, value]) => `\`${key}=${value}\``)
          .join(' ');
        if (labels) {
          tooltip.appendMarkdown(`${labels}\n\n`);
        }
        // The query is here so a row that looks wrong can be checked, and so
        // it survives an Explore link that a future Grafana stops honouring.
        tooltip.appendCodeblock(node.snapshot.query, 'promql');
        item.tooltip = tooltip;

        const explore = this.hub.grafana.exploreUrl(node.snapshot);
        if (explore) {
          item.command = {
            command: 'vscode.open',
            title: 'Open in Grafana Explore',
            arguments: [vscode.Uri.parse(explore)]
          };
        }
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.tooltip;
        if (node.command) {
          item.command = node.command;
        }
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.roots();
    }
    if (node.kind !== 'group') {
      return [];
    }
    return node.group === 'alerts' ? this.alertRows() : this.latencyRows();
  }

  private roots(): Node[] {
    const status = this.hub.grafana.status();
    if (status.health === 'unconfigured') {
      return [
        {
          kind: 'message',
          label: status.detail ?? 'Grafana is not connected',
          icon: 'plug',
          command: { command: 'devhub.signIn', title: 'Connect a service' }
        }
      ];
    }
    if (status.health === 'auth-expired') {
      return [
        {
          kind: 'message',
          label: 'Grafana credentials rejected — reconnect',
          icon: 'key',
          command: { command: 'devhub.signIn', title: 'Connect a service' }
        }
      ];
    }
    if (status.health === 'rate-limited') {
      return [{ kind: 'message', label: 'Rate limited — backing off', icon: 'watch' }];
    }
    return [
      { kind: 'group', group: 'alerts' },
      { kind: 'group', group: 'latency' }
    ];
  }

  /** Grafana has not answered for this context yet, so there is nothing to claim. */
  private waiting(): boolean {
    return !answered(this.snapshot, 'grafana');
  }

  private alertRows(): Node[] {
    if (this.snapshot.alerts.length > 0) {
      return this.snapshot.alerts.map((alert) => ({ kind: 'alert', alert }));
    }
    if (this.waiting()) {
      return [{ kind: 'message', label: 'Loading…', icon: 'sync~spin' }];
    }
    // An empty list here means either "nothing is wrong" or "nothing matched
    // the selector", and those need different reactions, so say which.
    const scope = this.hub.grafana.scope(this.snapshot.context);
    if (scope.source === 'none') {
      return [
        {
          kind: 'message',
          label: 'No repository to scope alerts to',
          icon: 'question',
          tooltip: 'Open a Git repository, or map one to a label selector in devhub.grafana.services.'
        }
      ];
    }
    const selector = scope.matchers.map((m) => `${m.label}=${m.value}`).join(', ');
    // "Nothing is wrong" and "nine alerts are firing, none of them matched the
    // scope I guessed" look identical from here unless the count says otherwise.
    if (this.snapshot.alertsSeen > 0) {
      return [
        {
          kind: 'message',
          label: `${this.snapshot.alertsSeen} firing in Grafana — none match ${selector || 'this repository'}`,
          icon: 'filter',
          tooltip: 'Pick the label that identifies this service from the ones your alerts carry.',
          command: { command: 'devhub.setupAlertScope', title: 'Fix the alert scope' }
        }
      ];
    }
    return [
      {
        kind: 'message',
        label: 'Nothing firing anywhere in Grafana',
        icon: 'pass',
        tooltip:
          scope.source === 'repo-name'
            ? `Scope guessed from the repository name: ${selector}.`
            : `Scoped to ${selector}.`
      }
    ];
  }

  private latencyRows(): Node[] {
    const snapshot = this.snapshot.latency;
    if (!snapshot) {
      return [
        {
          kind: 'message',
          label: this.waiting() ? 'Loading…' : 'No latency data',
          icon: this.waiting() ? 'sync~spin' : 'dash'
        }
      ];
    }
    if (snapshot.note) {
      return [
        {
          kind: 'message',
          label: snapshot.note,
          icon: 'gear',
          tooltip: snapshot.query,
          command: { command: 'devhub.setupLatency', title: 'Set up the latency query' }
        }
      ];
    }
    if (snapshot.endpoints.length === 0) {
      return [
        {
          kind: 'message',
          label: 'The latency query returned nothing — set it up',
          icon: 'tools',
          tooltip: `${snapshot.query}\n\nRun DevHub: Set up latency query… to find the metric this service actually exports.`,
          command: { command: 'devhub.setupLatency', title: 'Set up the latency query' }
        }
      ];
    }
    return snapshot.endpoints.map((endpoint) => ({ kind: 'endpoint', endpoint, snapshot }));
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
