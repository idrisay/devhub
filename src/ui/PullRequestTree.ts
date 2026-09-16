import * as path from 'path';
import * as vscode from 'vscode';
import type { Hub, HubSnapshot } from '../providers/Hub';
import { answered, sectionState, type SectionState } from '../providers/refreshPlan';
import { config } from '../infra/Config';
import { rowLabel, rowMeta } from './rowText';
import type { PullRequest } from '../providers/github/GitHubClient';
import {
  ageLabel,
  DEFAULT_PULL_SORT,
  describePull,
  formatAge,
  isBlocked,
  isPullSort,
  primaryFlag,
  pullFlags,
  pullSortLabel,
  pullSortShortLabel,
  PULL_SORTS,
  sortPulls,
  type PullSort,
  type PullSummary
} from '../providers/github/pullStatus';

type GroupId = 'branch' | 'mine' | 'review';

type Node =
  | { kind: 'group'; id: GroupId; label: string; icon: string; count: number }
  | { kind: 'branchPull'; pull: PullRequest }
  | { kind: 'pull'; pull: PullSummary; group: GroupId }
  | { kind: 'review'; pull: PullRequest }
  | { kind: 'checks'; pull: PullRequest }
  | { kind: 'comment'; comment: PullRequest['comments'][number]; repoRoot?: string }
  | { kind: 'check'; name: string; status: string; url: string }
  | { kind: 'message'; label: string; icon: string; tooltip?: string; command?: vscode.Command };

const REVIEW_LABEL: Record<string, { label: string; icon: string }> = {
  approved: { label: 'Approved', icon: 'check' },
  changes_requested: { label: 'Changes requested', icon: 'request-changes' },
  review_required: { label: 'Review pending', icon: 'comment-discussion' },
  none: { label: 'No reviews yet', icon: 'circle-large-outline' }
};

const SORT_KEY = 'devhub.pullRequests.sort';

const CHECK_ICON: Record<string, { id: string; color?: string }> = {
  success: { id: 'pass-filled', color: 'charts.green' },
  failure: { id: 'error', color: 'charts.red' },
  pending: { id: 'sync~spin' },
  neutral: { id: 'circle-outline', color: 'descriptionForeground' }
};

const BRANCH_STATE_ICON: Record<string, { id: string; color?: string }> = {
  open: { id: 'git-pull-request', color: 'charts.green' },
  draft: { id: 'git-pull-request-draft', color: 'descriptionForeground' },
  merged: { id: 'git-merge', color: 'charts.purple' },
  closed: { id: 'git-pull-request-closed', color: 'charts.red' }
};

function themeIcon(icon: { id: string; color?: string }): vscode.ThemeIcon {
  return new vscode.ThemeIcon(icon.id, icon.color ? new vscode.ThemeColor(icon.color) : undefined);
}

/**
 * The pull requests that matter right now: the one for this branch, your own
 * open ones, and the ones waiting on your review.
 *
 * Scope comes from the workspace — every GitHub repository the Git extension
 * has open — rather than from the whole account, so a multi-root workspace
 * shows one queue across all of its repos and nothing from outside them.
 */
export class PullRequestTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private snapshot: HubSnapshot;
  private readonly subscriptions: vscode.Disposable[] = [];
  private view?: vscode.TreeView<Node>;
  private sort: PullSort;
  private rendered?: string;

  constructor(
    hub: Hub,
    private readonly state: vscode.Memento
  ) {
    this.snapshot = hub.current;
    const stored = state.get<unknown>(SORT_KEY);
    this.sort = isPullSort(stored) ? stored : DEFAULT_PULL_SORT;

    this.subscriptions.push(
      hub.onDidChange((s) => {
        this.snapshot = s;
        this.render();
      }),
      // How long a row's title may be is a setting, and nothing else would
      // redraw the rows until the next round of data came in.
      config.onDidChange(() => this.render())
    );
  }

  attach(view: vscode.TreeView<Node>): void {
    this.view = view;
    this.updateHeader();
  }

  async pickSort(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      PULL_SORTS.map((option) => ({
        label: option.label,
        description: option.description,
        key: option.key,
        picked: option.key === this.sort
      })),
      { title: 'Sort pull requests by', placeHolder: pullSortLabel(this.sort) }
    );
    if (!picked) {
      return;
    }
    this.sort = picked.key;
    await this.state.update(SORT_KEY, picked.key);
    this.render();
  }

  private render(): void {
    this.updateHeader();

    // Firing this rebuilds every row and collapses whatever the user had open,
    // so it may only happen when the rows have actually changed. A refresh that
    // comes back with the same queues — which is most of them — should be
    // invisible apart from the header hint updated just above.
    const key = this.renderKey();
    if (key === this.rendered) {
      return;
    }
    this.rendered = key;
    this._onDidChangeTreeData.fire();
  }

  /** Everything the rows are drawn from, and nothing that only the header is. */
  private renderKey(): string {
    const s = this.snapshot;
    return JSON.stringify([
      s.context.branch,
      s.context.repoRoot,
      s.context.githubRepo,
      s.context.repos,
      s.pull,
      s.myPulls,
      s.reviewRequests,
      s.githubStatus,
      s.loaded.github,
      s.contextLoaded,
      this.sort,
      config.rows.titleLength()
    ]);
  }

  /**
   * The review count goes on the view badge, which VS Code also rolls up onto
   * the DevHub icon in the activity bar — the point being to notice a review
   * request without having the sidebar open.
   */
  private updateHeader(): void {
    if (!this.view) {
      return;
    }
    const waiting = this.snapshot.reviewRequests.length;
    const mine = this.snapshot.myPulls.length;

    // A background refresh belongs in the header, not in the rows: the queues
    // stay on screen and readable while it runs.
    const parts = [
      mine + waiting === 0 ? undefined : `${mine + waiting} · ${pullSortShortLabel(this.sort)}`,
      this.snapshot.refreshing.github ? 'refreshing…' : undefined
    ].filter(Boolean);
    this.view.description = parts.length > 0 ? parts.join(' · ') : undefined;
    this.view.badge =
      waiting === 0
        ? undefined
        : {
            value: waiting,
            tooltip: `${waiting} pull request${waiting === 1 ? '' : 's'} awaiting your review`
          };
  }

  /**
   * Whether a section has rows, is still waiting for GitHub's first answer, or
   * is genuinely empty. Every group asks this rather than reading a refresh
   * flag, so a background revalidation never takes rows off the screen.
   */
  private stateOf(hasData: boolean): SectionState {
    return sectionState({ hasData, answered: answered(this.snapshot, 'github') });
  }

  /** `mine` minus the branch PR, which already has its own section above. */
  private myPulls(): PullSummary[] {
    const branch = this.snapshot.pull;
    const repo = this.snapshot.context.githubRepo;
    const branchSlug = repo ? `${repo.owner}/${repo.name}`.toLowerCase() : undefined;

    const pulls = this.snapshot.myPulls.filter(
      (pull) =>
        !branch ||
        !branchSlug ||
        pull.number !== branch.number ||
        pull.repo.toLowerCase() !== branchSlug
    );
    return sortPulls(pulls, this.sort);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'group': {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.description = node.count > 0 ? String(node.count) : undefined;
        item.contextValue = `devhub.pullGroup.${node.id}`;
        return item;
      }

      case 'branchPull': {
        const { pull } = node;
        const item = new vscode.TreeItem(
          rowLabel({
            lead: `#${pull.number}`,
            title: pull.title,
            separator: '  ',
            budget: config.rows.titleLength()
          }),
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = themeIcon(BRANCH_STATE_ICON[pull.state] ?? BRANCH_STATE_ICON.open);

        const review = {
          approved: 'Approved',
          changes_requested: 'Changes requested',
          review_required: 'Awaiting review',
          none: undefined
        }[pull.reviewDecision];
        item.description = rowMeta(pull.state === 'open' ? undefined : pull.state, review);

        const tooltip = new vscode.MarkdownString('', true);
        tooltip.appendMarkdown(`**#${pull.number}** ${pull.title}\n\n`);
        tooltip.appendMarkdown(`by ${pull.author}`);
        if (review) {
          tooltip.appendMarkdown(` · ${review}`);
        }
        if (pull.reviewComments > 0) {
          tooltip.appendMarkdown(` · ${pull.reviewComments} review comment(s)`);
        }
        item.tooltip = tooltip;
        item.contextValue = 'devhub.branchPull';
        item.command = {
          command: 'vscode.open',
          title: 'Open pull request',
          arguments: [vscode.Uri.parse(pull.url)]
        };
        return item;
      }

      case 'pull': {
        const { pull } = node;
        const item = new vscode.TreeItem(
          rowLabel({
            lead: `#${pull.number}`,
            title: pull.title,
            separator: '  ',
            budget: config.rows.titleLength()
          })
        );
        item.iconPath = themeIcon(primaryFlag(pull));

        // Ordered by what you would look for, because the row clips from the
        // right: the state it is in, then how long it has been in it, then
        // whose it is, then which repository. The title above is clamped so
        // that at least the first two of those always have somewhere to go.
        //
        // Two flags is the budget, not the limit: `describePull` spends it on
        // the informational flags and never drops a blocking one, so a pull
        // request that conflicts *and* has changes requested *and* is failing
        // its checks says all three here rather than hiding the last in the
        // tooltip. Those three are why you would open it.
        const byCreation = this.sort.startsWith('created');
        const age = ageLabel(byCreation ? pull.createdAt : pull.updatedAt);
        item.description = rowMeta(
          describePull(pull, 2),
          age,
          node.group === 'review' ? pull.author : undefined,
          pull.repo
        );

        const tooltip = new vscode.MarkdownString('', true);
        tooltip.appendMarkdown(`**${pull.repo}#${pull.number}**\n\n${pull.title}\n\n`);
        tooltip.appendMarkdown(`by ${pull.author}`);
        tooltip.appendMarkdown(` · +${pull.additions} −${pull.deletions}\n\n`);
        for (const flag of pullFlags(pull)) {
          tooltip.appendMarkdown(`$(${flag.icon.replace('~spin', '')}) ${flag.label}\n\n`);
        }
        if (pull.mergeable === 'unknown') {
          tooltip.appendMarkdown('$(question) GitHub is still computing mergeability\n\n');
        }
        if (node.group === 'review' && pull.viewerReviewed) {
          tooltip.appendMarkdown('$(comment) You have already reviewed this — a new review was requested\n\n');
        }
        // Only on your own, and only when there is something to unblock: the
        // button is inline on the row, but an inline button is easy to miss
        // until you know it is there.
        if (node.group === 'mine' && isBlocked(pull)) {
          tooltip.appendMarkdown('$(copy) The button on this row copies a prompt to fix it\n\n');
        }
        const opened = formatAge(pull.createdAt);
        const touched = formatAge(pull.updatedAt);
        tooltip.appendMarkdown(`Opened ${opened} ago · updated ${touched} ago`);
        item.tooltip = tooltip;

        item.contextValue = `devhub.pull.${node.group}`;
        item.command = {
          command: 'vscode.open',
          title: 'Open pull request',
          arguments: [vscode.Uri.parse(pull.url)]
        };
        return item;
      }

      case 'review': {
        const { pull } = node;
        const meta = REVIEW_LABEL[pull.reviewDecision] ?? REVIEW_LABEL.none;
        const item = new vscode.TreeItem(
          meta.label,
          pull.comments.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon(meta.icon);
        item.description =
          pull.comments.length > 0 ? `${pull.comments.length} comments` : undefined;
        return item;
      }

      case 'checks': {
        const { pull } = node;
        const failing = pull.checks.filter((c) => c.status === 'failure').length;
        const running = pull.checks.filter((c) => c.status === 'pending').length;
        const item = new vscode.TreeItem(
          'Checks',
          pull.checks.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon(failing ? 'error' : running ? 'sync~spin' : 'pass');
        item.description = failing
          ? `${failing} failing`
          : running
            ? `${running} running`
            : pull.checks.length > 0
              ? 'all passing'
              : 'none';
        return item;
      }

      case 'comment': {
        const { comment, repoRoot } = node;
        const item = new vscode.TreeItem(
          rowLabel({ title: comment.body, budget: config.rows.titleLength() })
        );
        item.iconPath = new vscode.ThemeIcon('comment');
        item.description = rowMeta(
          comment.author,
          `${comment.path?.split('/').pop() ?? 'pull request'}${comment.line ? `:${comment.line}` : ''}`
        );
        item.tooltip = new vscode.MarkdownString(
          `**${comment.author}** on \`${comment.path ?? 'the pull request'}\`\n\n${comment.body}`
        );
        // Jump to the line in the working tree when we can place it; otherwise
        // fall back to the comment on GitHub.
        item.command =
          repoRoot && comment.path && comment.line
            ? {
                command: 'vscode.open',
                title: 'Go to comment',
                arguments: [
                  vscode.Uri.file(path.join(repoRoot, comment.path)),
                  { selection: new vscode.Range(comment.line - 1, 0, comment.line - 1, 0) }
                ]
              }
            : {
                command: 'vscode.open',
                title: 'Open comment',
                arguments: [vscode.Uri.parse(comment.url)]
              };
        return item;
      }

      case 'check': {
        const item = new vscode.TreeItem(node.name);
        item.iconPath = themeIcon(CHECK_ICON[node.status] ?? CHECK_ICON.neutral);
        item.description = node.status;
        item.command = {
          command: 'vscode.open',
          title: 'Open check',
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
      return this.childrenOf(node);
    }

    const status = this.snapshot.githubStatus;
    if (status.health === 'unconfigured') {
      return [
        {
          kind: 'message',
          label: status.detail ?? 'GitHub is not connected',
          icon: 'plug',
          command: { command: 'devhub.signIn', title: 'Connect a service', arguments: ['github'] }
        }
      ];
    }
    if (status.health === 'auth-expired') {
      return [
        {
          kind: 'message',
          label: 'GitHub credentials rejected — reconnect',
          icon: 'key',
          tooltip: status.hint ?? status.detail,
          command: { command: 'devhub.signIn', title: 'Connect a service', arguments: ['github'] }
        }
      ];
    }

    return [
      { kind: 'group', id: 'branch', label: 'Current branch', icon: 'git-branch', count: 0 },
      {
        kind: 'group',
        id: 'mine',
        label: 'My open pull requests',
        icon: 'git-pull-request',
        count: this.myPulls().length
      },
      {
        kind: 'group',
        id: 'review',
        label: 'Awaiting my review',
        icon: 'eye',
        count: this.snapshot.reviewRequests.length
      }
    ];
  }

  private childrenOf(node: Node): Node[] {
    if (node.kind === 'branchPull') {
      return [
        { kind: 'review', pull: node.pull },
        { kind: 'checks', pull: node.pull }
      ];
    }
    if (node.kind === 'review') {
      return node.pull.comments.map((comment) => ({
        kind: 'comment',
        comment,
        repoRoot: this.snapshot.context.repoRoot
      }));
    }
    if (node.kind === 'checks') {
      return node.pull.checks.map((check) => ({
        kind: 'check',
        name: check.name,
        status: check.status,
        url: check.url
      }));
    }
    if (node.kind !== 'group') {
      return [];
    }

    const status = this.snapshot.githubStatus;

    switch (node.id) {
      case 'branch': {
        if (this.snapshot.pull) {
          return [{ kind: 'branchPull', pull: this.snapshot.pull }];
        }
        if (this.stateOf(false) === 'first-load') {
          return [{ kind: 'message', label: 'Loading…', icon: 'sync~spin' }];
        }
        if (!this.snapshot.context.branch) {
          return [{ kind: 'message', label: 'No branch checked out', icon: 'git-branch' }];
        }
        if (!this.snapshot.context.githubRepo) {
          return [
            {
              kind: 'message',
              label: 'Origin is not a GitHub remote',
              icon: 'info',
              tooltip: 'DevHub reads owner/name from the origin remote of the active repository.'
            }
          ];
        }
        return [
          {
            kind: 'message',
            label: `No pull request for ${this.snapshot.context.branch}`,
            icon: 'circle-outline'
          }
        ];
      }

      case 'mine': {
        const pulls = this.myPulls();
        if (pulls.length > 0) {
          return pulls.map((pull) => ({ kind: 'pull', pull, group: 'mine' }));
        }
        return [this.emptyMessage(status, 'You have no open pull requests')];
      }

      case 'review': {
        const pulls = sortPulls(this.snapshot.reviewRequests, this.sort);
        if (pulls.length > 0) {
          return pulls.map((pull) => ({ kind: 'pull', pull, group: 'review' }));
        }
        return [this.emptyMessage(status, 'Nothing waiting on your review')];
      }
    }
  }

  /** An empty group is only good news once GitHub has actually answered. */
  private emptyMessage(status: HubSnapshot['githubStatus'], allClear: string): Node {
    if (this.stateOf(false) === 'first-load') {
      return { kind: 'message', label: 'Loading…', icon: 'sync~spin' };
    }
    if (status.health === 'rate-limited') {
      return { kind: 'message', label: 'Rate limited — backing off', icon: 'watch' };
    }
    if (status.health === 'error') {
      return {
        kind: 'message',
        label: `GitHub: ${status.detail ?? 'request failed'}`,
        icon: 'warning',
        tooltip: status.hint ?? status.detail,
        command: { command: 'devhub.showLogs', title: 'Show logs' }
      };
    }
    if (this.snapshot.context.repos.length === 0) {
      return {
        kind: 'message',
        label: 'No GitHub repositories in this workspace',
        icon: 'folder',
        tooltip: 'The queues are scoped to the repositories open in the workspace.'
      };
    }
    return { kind: 'message', label: allClear, icon: 'pass' };
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this._onDidChangeTreeData.dispose();
  }
}
