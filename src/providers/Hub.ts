import * as vscode from 'vscode';
import type { WorkContext, WorkContextService } from '../context/WorkContextService';
import type { AuthManager, ProviderId } from '../infra/AuthManager';
import type { CacheStore } from '../infra/CacheStore';
import { log } from '../infra/Logger';
import { FigmaProvider, DesignFrame } from './figma/FigmaProvider';
import { GitHubProvider } from './github/GitHubProvider';
import type { PullRequest } from './github/GitHubClient';
import type { PullSummary } from './github/pullStatus';
import { JiraProvider } from './jira/JiraProvider';
import type { JiraIssue } from './jira/JiraClient';
import { LocatedIssue, SentryProvider } from './sentry/SentryProvider';
import type { Provider, ProviderStatus } from './Provider';

export interface HubSnapshot {
  context: WorkContext;
  issue?: JiraIssue;
  errors: LocatedIssue[];
  designs: DesignFrame[];
  /** Everything assigned to the user — independent of the current branch. */
  tasks: JiraIssue[];
  /** Jira priority names, most urgent first. Empty when the site didn't say. */
  priorityOrder: string[];
  loading: boolean;
  /** Lets the ticket view explain an empty list instead of just showing one. */
  jiraStatus: ProviderStatus;
  /** The pull request for the current branch, if it has one. */
  pull?: PullRequest;
  /** The user's own open pull requests across the workspace's repositories. */
  myPulls: PullSummary[];
  /** Pull requests waiting on the user's review. */
  reviewRequests: PullSummary[];
  /** The authenticated GitHub login, for telling your own PRs apart. */
  viewerLogin?: string;
  githubStatus: ProviderStatus;
}

/**
 * Owns the fan-out. Two rules matter here: every provider call is wrapped in
 * allSettled so one broken integration can't blank the whole sidebar, and every
 * call gets a cancellation token so rapid branch switching doesn't race.
 */
export class Hub implements vscode.Disposable {
  readonly jira: JiraProvider;
  readonly sentry: SentryProvider;
  readonly figma: FigmaProvider;
  readonly github: GitHubProvider;

  private readonly _onDidChange = new vscode.EventEmitter<HubSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  private readonly disposables: vscode.Disposable[] = [];
  private inFlight?: vscode.CancellationTokenSource;
  private refreshingGitHub = false;

  private snapshot: HubSnapshot = {
    context: { changedFiles: [], pinned: false, repos: [] },
    errors: [],
    designs: [],
    tasks: [],
    priorityOrder: [],
    loading: false,
    jiraStatus: { health: 'unconfigured' },
    myPulls: [],
    reviewRequests: [],
    githubStatus: { health: 'unconfigured' }
  };

  constructor(
    auth: AuthManager,
    cache: CacheStore,
    private readonly workContext: WorkContextService
  ) {
    this.jira = new JiraProvider(auth, cache);
    this.sentry = new SentryProvider(auth, cache);
    this.figma = new FigmaProvider(auth, cache, this.jira);
    this.github = new GitHubProvider(auth, cache);

    this.disposables.push(
      this.jira,
      this.sentry,
      this.figma,
      this.github,
      this.workContext.onDidChange(() => void this.refresh()),
      auth.onDidChange((id) => {
        // Drop the affected provider's cached status before refreshing, so a
        // disconnect can't leave a stale "signed in as" behind.
        this.byId(id).onCredentialsChanged();
        void this.refresh();
      }),
      // Stale-while-revalidate: background refreshes land here.
      this.jira.onDidChange(() => this.emit()),
      this.sentry.onDidChange(() => this.emit()),
      this.figma.onDidChange(() => this.emit()),
      // Not a full refresh: the mergeability recheck writes into the cache, so
      // the new data only reaches the snapshot by being re-read — but re-running
      // the whole fan-out for it also re-queries Jira and Sentry, which is how
      // a background GitHub revalidation turns into a rate-limit storm.
      this.github.onDidChange(() => void this.refreshGitHub())
    );
  }

  get current(): HubSnapshot {
    return this.snapshot;
  }

  private byId(id: ProviderId): Provider<unknown> {
    return { jira: this.jira, figma: this.figma, sentry: this.sentry, github: this.github }[id];
  }

  statuses(): { id: ProviderId; name: string; status: ProviderStatus }[] {
    return [
      { id: this.jira.id, name: this.jira.displayName, status: this.jira.status() },
      { id: this.figma.id, name: this.figma.displayName, status: this.figma.status() },
      { id: this.sentry.id, name: this.sentry.displayName, status: this.sentry.status() },
      { id: this.github.id, name: this.github.displayName, status: this.github.status() }
    ];
  }

  async refresh(): Promise<void> {
    // Abandon anything still running for the previous context.
    this.inFlight?.cancel();
    this.inFlight?.dispose();
    const source = new vscode.CancellationTokenSource();
    this.inFlight = source;
    const token = source.token;

    const ctx = this.workContext.context;
    this.snapshot = { ...this.snapshot, context: ctx, loading: true };
    this.emit();

    // The task list and the priority scheme don't depend on `ctx`, but they ride
    // along on the same fan-out: both are cached, so a branch switch costs
    // nothing, and the view stays in step with everything else.
    const [jira, sentry, figma, tasks, priorities, pull, queues] = await Promise.allSettled([
      this.jira.forContext(ctx, token),
      this.sentry.forContext(ctx, token),
      this.figma.forContext(ctx, token),
      this.jira.isConfigured() ? this.jira.assignedToMe(token) : Promise.resolve([]),
      this.jira.isConfigured() ? this.jira.priorityOrder(token) : Promise.resolve([]),
      this.github.forContext(ctx, token),
      this.github.pullQueues(ctx, token)
    ]);

    if (token.isCancellationRequested) {
      return;
    }

    this.snapshot = {
      context: ctx,
      issue: jira.status === 'fulfilled' ? jira.value[0] : this.snapshot.issue,
      errors: sentry.status === 'fulfilled' ? sentry.value : [],
      designs: figma.status === 'fulfilled' ? figma.value : [],
      // Keep the last good list on failure rather than blanking the view; the
      // task tree reads jiraStatus to say why it may be out of date.
      tasks: (tasks.status === 'fulfilled' ? tasks.value : undefined) ?? this.snapshot.tasks,
      priorityOrder:
        priorities.status === 'fulfilled' ? priorities.value : this.snapshot.priorityOrder,
      loading: false,
      jiraStatus: this.jira.status(),
      pull: pull.status === 'fulfilled' ? pull.value[0] : undefined,
      // Same reasoning as the task list: keep the last good queues rather than
      // blanking the view, and let githubStatus explain why they may be stale.
      myPulls: queues.status === 'fulfilled' ? queues.value.mine : this.snapshot.myPulls,
      reviewRequests:
        queues.status === 'fulfilled' ? queues.value.reviewRequested : this.snapshot.reviewRequests,
      viewerLogin:
        queues.status === 'fulfilled' && queues.value.viewer
          ? queues.value.viewer
          : this.snapshot.viewerLogin,
      githubStatus: this.github.status()
    };

    for (const [name, result] of [
      ['jira', jira],
      ['sentry', sentry],
      ['figma', figma],
      ['jira tasks', tasks],
      ['github branch pull request', pull],
      ['github pull request queues', queues]
    ] as const) {
      if (result.status === 'rejected') {
        log.error(`${name} provider failed`, result.reason);
      }
    }

    this.emit();
  }

  /**
   * Re-reads only the GitHub half of the snapshot. Both reads are cached, so
   * the call that triggered this finds a fresh entry and does not fire again.
   */
  private async refreshGitHub(): Promise<void> {
    if (this.refreshingGitHub) {
      return;
    }
    this.refreshingGitHub = true;
    const source = new vscode.CancellationTokenSource();
    try {
      const ctx = this.snapshot.context;
      const [pull, queues] = await Promise.allSettled([
        this.github.forContext(ctx, source.token),
        this.github.pullQueues(ctx, source.token)
      ]);

      this.snapshot = {
        ...this.snapshot,
        pull: pull.status === 'fulfilled' ? pull.value[0] : this.snapshot.pull,
        myPulls: queues.status === 'fulfilled' ? queues.value.mine : this.snapshot.myPulls,
        reviewRequests:
          queues.status === 'fulfilled'
            ? queues.value.reviewRequested
            : this.snapshot.reviewRequests,
        githubStatus: this.github.status()
      };
      this.emit();
    } finally {
      source.dispose();
      this.refreshingGitHub = false;
    }
  }

  private emit(): void {
    this._onDidChange.fire(this.snapshot);
  }

  dispose(): void {
    this.inFlight?.cancel();
    this.inFlight?.dispose();
    this._onDidChange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
