import * as vscode from 'vscode';
import type { Hub, HubSnapshot } from '../providers/Hub';
import type { JiraIssue } from '../providers/jira/JiraClient';
import type { ProviderStatus } from '../providers/Provider';

type Node =
  | { kind: 'issue'; issue: JiraIssue }
  | { kind: 'status'; issue: JiraIssue }
  | { kind: 'group'; label: string; icon: string; children: Node[] }
  | { kind: 'text'; label: string; detail?: string; tooltip?: string }
  | { kind: 'subtask'; key: string; summary: string; status: string; url: string }
  | { kind: 'message'; label: string; command?: vscode.Command; icon?: string; tooltip?: string };

/**
 * A failed Jira call and a query that matched nothing both leave the view with
 * no issues. Only the first is the user's problem to fix, so it gets a node of
 * its own rather than sharing the "no ticket" welcome screen.
 */
function isBroken(status: ProviderStatus): boolean {
  return status.health === 'auth-expired' || status.health === 'error' || status.health === 'rate-limited';
}

/**
 * Acceptance criteria are conventionally a heading or a checklist in the
 * description. Pulling them out into their own node is worth the heuristic —
 * it's the part of the ticket people actually re-read while coding.
 */
function extractAcceptanceCriteria(description: string): string[] {
  const lines = description.split('\n');
  const headingIndex = lines.findIndex((line) =>
    /^#{1,6}\s*(acceptance criteria|ac|definition of done|dod)\b/i.test(line.trim())
  );

  const scope = headingIndex >= 0 ? lines.slice(headingIndex + 1) : lines;
  const criteria: string[] = [];

  for (const line of scope) {
    if (headingIndex >= 0 && /^#{1,6}\s/.test(line.trim())) {
      break;
    }
    const match = line.match(/^\s*(?:[-*]|\d+\.)\s*(?:\[( |x|X)\]\s*)?(.+)$/);
    if (match && match[2].trim()) {
      criteria.push(`${match[1] ? (match[1].toLowerCase() === 'x' ? '✓ ' : '○ ') : ''}${match[2].trim()}`);
    }
  }

  return headingIndex >= 0 ? criteria : criteria.slice(0, 0);
}

export class TicketTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private snapshot: HubSnapshot;
  private readonly subscription: vscode.Disposable;

  constructor(hub: Hub) {
    this.snapshot = hub.current;
    this.subscription = hub.onDidChange((s) => {
      this.snapshot = s;
      this._onDidChangeTreeData.fire();
    });
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'issue': {
        const item = new vscode.TreeItem(
          `${node.issue.key}  ${node.issue.summary}`,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('issues');
        item.contextValue = 'devhub.issue';
        item.tooltip = new vscode.MarkdownString(
          `**${node.issue.key}** — ${node.issue.summary}\n\n${node.issue.description.slice(0, 1200)}`
        );
        item.command = { command: 'devhub.openTicket', title: 'Open ticket in browser' };
        return item;
      }
      case 'status': {
        const item = new vscode.TreeItem(node.issue.status, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(
          node.issue.statusCategory === 'done'
            ? 'pass-filled'
            : node.issue.statusCategory === 'indeterminate'
              ? 'debug-start'
              : 'circle-large-outline'
        );
        item.description = node.issue.assignee ?? 'Unassigned';
        item.tooltip = 'Change status';
        item.command = { command: 'devhub.transitionIssue', title: 'Change ticket status' };
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(
          node.label,
          node.children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.description = String(node.children.length);
        return item;
      }
      case 'subtask': {
        const item = new vscode.TreeItem(`${node.key}  ${node.summary}`);
        item.iconPath = new vscode.ThemeIcon('circle-small');
        item.description = node.status;
        item.command = {
          command: 'vscode.open',
          title: 'Open',
          arguments: [vscode.Uri.parse(node.url)]
        };
        return item;
      }
      case 'text': {
        const item = new vscode.TreeItem(node.label);
        item.description = node.detail;
        item.tooltip = node.tooltip ?? node.label;
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon ?? 'info');
        item.tooltip = node.tooltip ?? node.label;
        if (node.command) {
          item.command = node.command;
        }
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (node) {
      return node.kind === 'group' ? node.children : [];
    }

    const { context, issue, loading, jiraStatus } = this.snapshot;
    const broken = isBroken(jiraStatus);

    if (!context.ticketKey) {
      if (broken && !loading) {
        // Returning a node suppresses viewsWelcome, which would otherwise claim
        // there is simply no ticket for this branch.
        return [this.failureNode(jiraStatus)];
      }
      // The viewsWelcome contribution covers this case with real buttons.
      return [];
    }

    if (!issue) {
      if (loading) {
        return [
          { kind: 'message', label: `Loading ${context.ticketKey}…`, icon: 'sync~spin' }
        ];
      }
      if (broken) {
        return [this.failureNode(jiraStatus)];
      }
      return [
        {
          kind: 'message',
          label: `${context.ticketKey} not found in Jira`,
          icon: 'question',
          tooltip: `Jira is reachable, but ${context.ticketKey} did not come back. Check the key exists and that you can see it.`
        }
      ];
    }

    const nodes: Node[] = [{ kind: 'issue', issue }, { kind: 'status', issue }];

    const criteria = extractAcceptanceCriteria(issue.description);
    if (criteria.length > 0) {
      nodes.push({
        kind: 'group',
        label: 'Acceptance criteria',
        icon: 'checklist',
        children: criteria.map((label) => ({ kind: 'text', label }))
      });
    }

    if (issue.subtasks.length > 0) {
      nodes.push({
        kind: 'group',
        label: 'Subtasks',
        icon: 'list-tree',
        children: issue.subtasks.map((s) => ({ kind: 'subtask', ...s }))
      });
    }

    if (issue.comments.length > 0) {
      nodes.push({
        kind: 'group',
        label: 'Comments',
        icon: 'comment-discussion',
        children: issue.comments.slice(-10).reverse().map((c) => ({
          kind: 'text',
          label: c.body.replace(/\s+/g, ' ').slice(0, 90),
          detail: c.author,
          tooltip: `**${c.author}**\n\n${c.body}`
        }))
      });
    }

    return nodes;
  }

  private failureNode(status: ProviderStatus): Node {
    return {
      kind: 'message',
      label: `Jira: ${status.detail ?? 'request failed'}`,
      icon: status.health === 'rate-limited' ? 'watch' : 'key',
      tooltip: status.hint ?? status.detail,
      command: { command: 'devhub.signIn', title: 'Reconnect Jira', arguments: ['jira'] }
    };
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
