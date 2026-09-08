import * as vscode from 'vscode';
import type { Hub, HubSnapshot } from '../providers/Hub';
import type { JiraIssue } from '../providers/jira/JiraClient';
import {
  applyStatusFilter,
  DEFAULT_TASK_SORT,
  isTaskSort,
  priorityTier,
  sortLabel,
  sortShortLabel,
  sortTasks,
  statusFacets,
  TASK_SORTS,
  type PriorityTier,
  type TaskSort
} from '../providers/jira/taskSort';

type Node =
  | { kind: 'task'; issue: JiraIssue }
  | { kind: 'subtask'; key: string; summary: string; status: string; url: string }
  | { kind: 'message'; label: string; icon: string; tooltip?: string; command?: vscode.Command };

const FILTER_KEY = 'devhub.tasks.statusFilter';
const SORT_KEY = 'devhub.tasks.sort';

const TIER_ICON: Record<PriorityTier, { id: string; color?: string }> = {
  high: { id: 'chevron-up', color: 'charts.red' },
  medium: { id: 'dash', color: 'charts.yellow' },
  low: { id: 'chevron-down', color: 'charts.blue' },
  none: { id: 'circle-outline', color: 'descriptionForeground' }
};

const CATEGORY_ICON: Record<string, string> = {
  new: 'circle-large-outline',
  indeterminate: 'debug-start',
  done: 'pass-filled'
};

function relativeTime(iso: string): string | undefined {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return undefined;
  }
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 60) {
    return `${Math.max(minutes, 0)}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(then).toLocaleDateString();
}

/**
 * Everything assigned to the user, filtered by status and sorted by priority.
 *
 * The list is deliberately not grouped: grouping and sorting fight each other,
 * and the whole point of the priority sort is that the top row is the next
 * thing to pick up.
 */
export class TaskTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private snapshot: HubSnapshot;
  private readonly subscription: vscode.Disposable;
  private view?: vscode.TreeView<Node>;

  private statusFilter: string[];
  private sort: TaskSort;

  constructor(
    private readonly hub: Hub,
    private readonly state: vscode.Memento
  ) {
    this.snapshot = hub.current;
    const storedSort = state.get<unknown>(SORT_KEY);
    this.sort = isTaskSort(storedSort) ? storedSort : DEFAULT_TASK_SORT;
    this.statusFilter = state.get<string[]>(FILTER_KEY, []);

    this.subscription = hub.onDidChange((s) => {
      this.snapshot = s;
      this.render();
    });
    void this.publishContext();
  }

  /** Lets the view header report the filter and sort without spending a row. */
  attach(view: vscode.TreeView<Node>): void {
    this.view = view;
    this.updateHeader();
  }

  get isFiltered(): boolean {
    return this.statusFilter.length > 0;
  }

  async pickStatusFilter(): Promise<void> {
    const facets = statusFacets(this.snapshot.tasks);
    if (facets.length === 0) {
      void vscode.window.showInformationMessage(
        'DevHub: no tasks loaded yet, so there are no statuses to filter by.'
      );
      return;
    }

    const selected = new Set(this.statusFilter.map((s) => s.toLowerCase()));
    const items = facets.map((facet) => ({
      label: facet.name,
      description: `${facet.count} task${facet.count === 1 ? '' : 's'}`,
      detail: facet.category === 'done' ? 'Done' : facet.category === 'new' ? 'To do' : 'In progress',
      picked: selected.has(facet.name.toLowerCase())
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Show tasks with these statuses',
      placeHolder: 'Select none to show every status',
      canPickMany: true
    });
    if (!picked) {
      return;
    }
    // Picking every status is the same as picking none, and storing it as none
    // keeps the filter from going stale when a new status appears in Jira.
    await this.setStatusFilter(picked.length === facets.length ? [] : picked.map((p) => p.label));
  }

  async clearStatusFilter(): Promise<void> {
    await this.setStatusFilter([]);
  }

  async pickSort(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      TASK_SORTS.map((option) => ({
        label: option.label,
        description: option.description,
        key: option.key,
        picked: option.key === this.sort
      })),
      { title: 'Sort tasks by', placeHolder: sortLabel(this.sort) }
    );
    if (!picked) {
      return;
    }
    this.sort = picked.key;
    await this.state.update(SORT_KEY, picked.key);
    this.render();
  }

  private async setStatusFilter(statuses: string[]): Promise<void> {
    this.statusFilter = statuses;
    await this.state.update(FILTER_KEY, statuses);
    await this.publishContext();
    this.render();
  }

  private async publishContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'devhub.tasksFiltered', this.isFiltered);
  }

  private render(): void {
    this.updateHeader();
    this._onDidChangeTreeData.fire();
  }

  private updateHeader(): void {
    if (!this.view) {
      return;
    }
    const total = this.snapshot.tasks.length;
    const shown = applyStatusFilter(this.snapshot.tasks, this.statusFilter).length;
    const count = this.isFiltered ? `${shown}/${total}` : String(total);
    this.view.description = total === 0 ? undefined : `${count} · ${sortShortLabel(this.sort)}`;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'task': {
        const { issue } = node;
        const item = new vscode.TreeItem(
          `${issue.key}  ${issue.summary}`,
          issue.subtasks.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );

        // Priority drives the icon because that is what the default sort orders
        // by; status goes in the description, next to the filter that uses it.
        const icon = TIER_ICON[priorityTier(issue.priority, this.snapshot.priorityOrder)];
        item.iconPath = new vscode.ThemeIcon(
          icon.id,
          icon.color ? new vscode.ThemeColor(icon.color) : undefined
        );

        const updated = relativeTime(issue.updated);
        item.description = [issue.status, updated].filter(Boolean).join(' · ');
        item.contextValue = 'devhub.task';

        const tooltip = new vscode.MarkdownString('', true);
        tooltip.appendMarkdown(`**${issue.key}** — ${issue.summary}\n\n`);
        tooltip.appendMarkdown(
          `${CATEGORY_ICON[issue.statusCategory] ? `$(${CATEGORY_ICON[issue.statusCategory]}) ` : ''}${issue.status}`
        );
        tooltip.appendMarkdown(` · ${issue.issueType}`);
        tooltip.appendMarkdown(` · ${issue.priority ?? 'No priority'}\n\n`);
        if (updated) {
          tooltip.appendMarkdown(`Updated ${updated}\n\n`);
        }
        if (issue.description) {
          tooltip.appendMarkdown(`${issue.description.slice(0, 600)}`);
        }
        item.tooltip = tooltip;

        item.command = {
          command: 'vscode.open',
          title: 'Open in Jira',
          arguments: [vscode.Uri.parse(issue.url)]
        };
        return item;
      }
      case 'subtask': {
        const item = new vscode.TreeItem(`${node.key}  ${node.summary}`);
        item.iconPath = new vscode.ThemeIcon('circle-small');
        item.description = node.status;
        item.command = {
          command: 'vscode.open',
          title: 'Open in Jira',
          arguments: [vscode.Uri.parse(node.url)]
        };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon);
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
      return node.kind === 'task'
        ? node.issue.subtasks.map((s) => ({ kind: 'subtask', ...s }))
        : [];
    }

    const status = this.hub.jira.status();
    if (status.health === 'unconfigured') {
      return [
        {
          kind: 'message',
          label: status.detail ?? 'Jira is not connected',
          icon: 'plug',
          command: { command: 'devhub.signIn', title: 'Connect a service', arguments: ['jira'] }
        }
      ];
    }
    if (status.health === 'auth-expired') {
      return [
        {
          kind: 'message',
          label: 'Jira credentials rejected — reconnect',
          icon: 'key',
          tooltip: status.hint ?? status.detail,
          command: { command: 'devhub.signIn', title: 'Connect a service', arguments: ['jira'] }
        }
      ];
    }

    const { tasks, loading } = this.snapshot;

    if (tasks.length === 0) {
      if (loading) {
        return [{ kind: 'message', label: 'Loading your tasks…', icon: 'sync~spin' }];
      }
      if (status.health === 'rate-limited') {
        return [{ kind: 'message', label: 'Rate limited — backing off', icon: 'watch' }];
      }
      if (status.health === 'error') {
        return [
          {
            kind: 'message',
            label: `Jira: ${status.detail ?? 'request failed'}`,
            icon: 'warning',
            tooltip: status.hint ?? status.detail,
            command: { command: 'devhub.showLogs', title: 'Show logs' }
          }
        ];
      }
      // Jira answered, so an empty list is the query's doing.
      return [
        {
          kind: 'message',
          label: 'Nothing assigned to you',
          icon: 'pass',
          tooltip: 'devhub.jira.tasksJql matched no issues. Widen it to see more.'
        }
      ];
    }

    const visible = applyStatusFilter(tasks, this.statusFilter);
    if (visible.length === 0) {
      return [
        {
          kind: 'message',
          label: `No tasks with status ${this.statusFilter.join(', ')}`,
          icon: 'filter',
          tooltip: `${tasks.length} task(s) are hidden by the status filter.`,
          command: { command: 'devhub.tasks.clearFilter', title: 'Clear status filter' }
        }
      ];
    }

    return sortTasks(visible, this.sort, this.snapshot.priorityOrder).map((issue) => ({
      kind: 'task',
      issue
    }));
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
