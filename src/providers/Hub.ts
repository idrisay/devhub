import * as vscode from 'vscode';
import type { WorkContext, WorkContextService } from '../context/WorkContextService';
import type { AuthManager, ProviderId } from '../infra/AuthManager';
import type { CacheStore } from '../infra/CacheStore';
import { config } from '../infra/Config';
import { log } from '../infra/Logger';
import { FigmaProvider, DesignFrame } from './figma/FigmaProvider';
import { GitHubProvider } from './github/GitHubProvider';
import { GrafanaProvider, GrafanaAlert, LatencySnapshot } from './grafana/GrafanaProvider';
import type { PullRequest } from './github/GitHubClient';
import type { PullSummary } from './github/pullStatus';
import { JiraProvider } from './jira/JiraProvider';
import type { JiraIssue } from './jira/JiraClient';
import { LocatedIssue, SentryProvider } from './sentry/SentryProvider';
import type { Provider, ProviderStatus } from './Provider';
import {
  contextFingerprint,
  NO_PROVIDERS,
  planRefresh,
  providerFlags,
  viewFingerprint,
  type ProviderFlags
} from './refreshPlan';

export type { ProviderFlags } from './refreshPlan';

export interface HubSnapshot {
  context: WorkContext;
  /** The active repository's issue. */
  issue?: JiraIssue;
  /** Every workspace ticket that loaded, by key, for the per-repository view. */
  issues: Record<string, JiraIssue>;
  errors: LocatedIssue[];
  designs: DesignFrame[];
  /** Everything assigned to the user — independent of the current branch. */
  tasks: JiraIssue[];
  /** Jira priority names, most urgent first. Empty when the site didn't say. */
  priorityOrder: string[];
  /**
   * Providers with a request in flight. Only ever a hint — a view that already
   * has rows must keep showing them.
   */
  refreshing: ProviderFlags;
  /**
   * Providers that have answered at least once, successfully or not. A view may
   * only call a section empty once its provider is in here.
   */
  loaded: ProviderFlags;
  /**
   * A fan-out has completed for the work context that is currently on screen.
   * Until it has, an empty section means "not looked yet", not "nothing there".
   */
  contextLoaded: boolean;
  /**
   * A provider is loading for the first time, so somewhere in the sidebar there
   * is genuinely nothing to show yet. Not "a refresh is running": that is true
   * several times a minute and is no reason to take rows off the screen.
   */
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
  /** Grafana alerts for the service this repository is. */
  alerts: GrafanaAlert[];
  /** Alerts firing anywhere in Grafana, matched or not. */
  alertsSeen: number;
  /** Slowest endpoints for the same service, and the query behind them. */
  latency?: LatencySnapshot;
  grafanaStatus: ProviderStatus;
}

/**
 * How long a fan-out may run before the views hear about it at all.
 *
 * Nearly every round is served from cache in a millisecond or two, so emitting
 * at the start of one only costs a re-render that changes nothing. Anything
 * that genuinely has to fetch is well past this by the time it matters.
 */
const LOADING_ANNOUNCE_MS = 150;

/** Every provider the fan-out asks for something. */
const FANNED_OUT: readonly ProviderId[] = ['jira', 'sentry', 'figma', 'github', 'grafana'];

export interface RefreshOptions {
  /**
   * Run now, whatever the refresh interval says. For the refresh command and
   * for anything the user just did that wrote to a provider — never for a
   * trigger they did not ask for. It does not skip the caches: only
   * `devhub.refresh` does that, by dropping the entries first.
   */
  force?: boolean;
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
  readonly grafana: GrafanaProvider;

  private readonly _onDidChange = new vscode.EventEmitter<HubSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  private readonly disposables: vscode.Disposable[] = [];
  private inFlight?: vscode.CancellationTokenSource;
  /** The context the running fan-out is for, so a repeat can join it. */
  private inFlightFingerprint?: string;
  private inFlightRun?: Promise<void>;
  private lastFingerprint?: string;
  private lastCompletedAt = 0;
  private trailingTimer?: NodeJS.Timeout;
  private readonly refreshingIds = new Set<ProviderId>();
  private readonly loadedIds = new Set<ProviderId>();
  private refreshingGitHub = false;
  private gitHubRefreshQueued = false;

  private snapshot: HubSnapshot = {
    context: { changedFiles: [], pinned: false, repos: [], work: [] },
    issues: {},
    errors: [],
    designs: [],
    tasks: [],
    priorityOrder: [],
    refreshing: NO_PROVIDERS,
    loaded: NO_PROVIDERS,
    contextLoaded: false,
    loading: false,
    jiraStatus: { health: 'unconfigured' },
    myPulls: [],
    reviewRequests: [],
    githubStatus: { health: 'unconfigured' },
    alerts: [],
    alertsSeen: 0,
    grafanaStatus: { health: 'unconfigured' }
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
    this.grafana = new GrafanaProvider(auth, cache);

    this.disposables.push(
      this.jira,
      this.sentry,
      this.figma,
      this.github,
      this.grafana,
      this.workContext.onDidChange(() => void this.refresh()),
      auth.onDidChange((id) => {
        // Drop the affected provider's cached status before refreshing, so a
        // disconnect can't leave a stale "signed in as" behind. Forced: the
        // context has not moved, so the interval would otherwise hold this back.
        this.byId(id).onCredentialsChanged();
        this.loadedIds.delete(id);
        void this.refresh({ force: true });
      }),
      // Stale-while-revalidate: background refreshes land here.
      this.jira.onDidChange(() => this.emit()),
      this.sentry.onDidChange(() => this.emit()),
      this.figma.onDidChange(() => this.emit()),
      this.grafana.onDidChange(() => this.emit()),
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
    return {
      jira: this.jira,
      figma: this.figma,
      sentry: this.sentry,
      github: this.github,
      grafana: this.grafana
    }[id];
  }

  statuses(): { id: ProviderId; name: string; status: ProviderStatus }[] {
    return [
      { id: this.jira.id, name: this.jira.displayName, status: this.jira.status() },
      { id: this.figma.id, name: this.figma.displayName, status: this.figma.status() },
      { id: this.sentry.id, name: this.sentry.displayName, status: this.sentry.status() },
      { id: this.github.id, name: this.github.displayName, status: this.github.status() },
      { id: this.grafana.id, name: this.grafana.displayName, status: this.grafana.status() }
    ];
  }

  /**
   * The single entry point for "the sidebar may be out of date".
   *
   * Everything funnels through here: activation, window focus, a Git state
   * event, a branch checkout, a save, a command that just wrote to Jira. Most
   * of those repeat the context of the round before, so the work here is
   * deciding which ones earn requests — see `planRefresh`. What always happens
   * is that the new context is published, because the branch name and the
   * changed-file list are local reads that should never wait on a network.
   */
  async refresh(options: RefreshOptions = {}): Promise<void> {
    const ctx = this.workContext.context;
    const fingerprint = contextFingerprint(ctx);

    if (viewFingerprint(ctx) !== viewFingerprint(this.snapshot.context)) {
      this.snapshot = { ...this.snapshot, context: ctx };
      this.emit();
    }

    const decision = planRefresh({
      force: Boolean(options.force),
      fingerprint,
      inFlight: this.inFlightFingerprint,
      lastFingerprint: this.lastFingerprint,
      lastCompletedAt: this.lastCompletedAt,
      now: Date.now(),
      minIntervalMs: config.refresh.minIntervalMs()
    });

    if (decision.run === 'join') {
      await this.inFlightRun;
      return;
    }
    if (decision.run === 'later') {
      // Trailing edge: the last trigger inside the window still gets its
      // round, just once and at the end, instead of one round per trigger.
      this.scheduleTrailing(decision.inMs);
      return;
    }

    this.clearTrailing();
    const run = this.fanOut(ctx, fingerprint);
    this.inFlightRun = run;
    await run;
  }

  private async fanOut(ctx: WorkContext, fingerprint: string): Promise<void> {
    // Abandon anything still running for a *different* context. A repeat of the
    // same one joined this call instead of getting here, which is the whole
    // point: cancelling an in-flight request and immediately re-issuing it is
    // how a rate limit gets spent on data nobody ever sees.
    this.inFlight?.cancel();
    this.inFlight?.dispose();
    const source = new vscode.CancellationTokenSource();
    this.inFlight = source;
    this.inFlightFingerprint = fingerprint;
    const token = source.token;

    // Set synchronously rather than on the announce timer: a view that opens
    // mid-fan-out has to be able to tell "waiting" from "nothing to show", and
    // it reads the snapshot the moment it is asked for children.
    this.refreshingIds.clear();
    FANNED_OUT.forEach((id) => this.refreshingIds.add(id));
    this.snapshot = { ...this.snapshot, context: ctx };

    const announceLoading = setTimeout(() => {
      if (this.inFlight === source && !token.isCancellationRequested) {
        this.emit();
      }
    }, LOADING_ANNOUNCE_MS);

    // The task list and the priority scheme don't depend on `ctx`, but they ride
    // along on the same fan-out: both are cached, so a branch switch costs
    // nothing, and the view stays in step with everything else.
    let settled;
    try {
      settled = await Promise.allSettled([
        this.jira.forContext(ctx, token),
        this.sentry.forContext(ctx, token),
        this.figma.forContext(ctx, token),
        this.jira.isConfigured() ? this.jira.assignedToMe(token) : Promise.resolve([]),
        this.jira.isConfigured() ? this.jira.priorityOrder(token) : Promise.resolve([]),
        this.github.forContext(ctx, token),
        this.github.pullQueues(ctx, token),
        this.grafana.forContext(ctx, token),
        this.grafana.isConfigured() ? this.grafana.latency(ctx, token) : Promise.resolve(undefined)
      ]);
    } finally {
      clearTimeout(announceLoading);
    }
    const [jira, sentry, figma, tasks, priorities, pull, queues, alerts, latency] = settled;

    if (token.isCancellationRequested || this.inFlight !== source) {
      return;
    }

    this.refreshingIds.clear();
    this.inFlightFingerprint = undefined;
    this.inFlightRun = undefined;
    this.lastFingerprint = fingerprint;
    this.lastCompletedAt = Date.now();

    // A provider call resolves whether or not the service answered — failures
    // come back as a status the views render — so a fulfilled call means the
    // section is no longer waiting to hear anything, and an empty section can
    // stop being ambiguous.
    for (const [id, result] of [
      ['jira', jira],
      ['sentry', sentry],
      ['figma', figma],
      ['github', queues],
      ['grafana', alerts]
    ] as const) {
      if (result.status === 'fulfilled') {
        this.loadedIds.add(id);
      }
    }

    // Keep the last good set on failure rather than blanking the view.
    const issues =
      jira.status === 'fulfilled'
        ? Object.fromEntries(jira.value.map((issue) => [issue.key, issue]))
        : this.snapshot.issues;

    this.snapshot = {
      context: ctx,
      issues,
      issue: ctx.ticketKey ? issues[ctx.ticketKey] : undefined,
      errors: sentry.status === 'fulfilled' ? sentry.value : [],
      designs: figma.status === 'fulfilled' ? figma.value : [],
      // Keep the last good list on failure rather than blanking the view; the
      // task tree reads jiraStatus to say why it may be out of date.
      tasks: (tasks.status === 'fulfilled' ? tasks.value : undefined) ?? this.snapshot.tasks,
      priorityOrder:
        priorities.status === 'fulfilled' ? priorities.value : this.snapshot.priorityOrder,
      refreshing: NO_PROVIDERS,
      loaded: providerFlags(this.loadedIds),
      contextLoaded: true,
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
      githubStatus: this.github.status(),
      // Scoped to the repository, like the Sentry errors: keeping the last good
      // list across a branch switch would show one service's alerts under
      // another's name, which is worse than showing none.
      alerts: alerts.status === 'fulfilled' ? alerts.value : [],
      alertsSeen: this.grafana.firingTotal,
      latency: latency.status === 'fulfilled' ? latency.value : undefined,
      grafanaStatus: this.grafana.status()
    };

    for (const [name, result] of [
      ['jira', jira],
      ['sentry', sentry],
      ['figma', figma],
      ['jira tasks', tasks],
      ['github branch pull request', pull],
      ['github pull request queues', queues],
      ['grafana alerts', alerts],
      ['grafana latency', latency]
    ] as const) {
      if (result.status === 'rejected') {
        log.error(`${name} provider failed`, result.reason);
      }
    }

    this.emit();
  }

  private scheduleTrailing(inMs: number): void {
    if (this.trailingTimer) {
      return;
    }
    this.trailingTimer = setTimeout(() => {
      this.trailingTimer = undefined;
      void this.refresh();
    }, inMs);
  }

  private clearTrailing(): void {
    clearTimeout(this.trailingTimer);
    this.trailingTimer = undefined;
  }

  /**
   * Re-reads only the GitHub half of the snapshot. Both reads are cached, so
   * the call that triggered this finds a fresh entry and does not fire again.
   */
  private async refreshGitHub(): Promise<void> {
    // Coalesce rather than drop: two cache keys revalidate independently, and
    // dropping the second one loses whichever result landed last.
    if (this.refreshingGitHub) {
      this.gitHubRefreshQueued = true;
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

    if (this.gitHubRefreshQueued) {
      this.gitHubRefreshQueued = false;
      await this.refreshGitHub();
    }
  }

  /** Every emit carries the current activity, so no view can read a stale flag. */
  private emit(): void {
    this.snapshot = {
      ...this.snapshot,
      refreshing: providerFlags(this.refreshingIds),
      loaded: providerFlags(this.loadedIds),
      // Derived rather than stored: publishing a new context has to invalidate
      // this in the same breath, or a branch switch would render the previous
      // branch's emptiness as if it had been checked.
      contextLoaded:
        this.lastFingerprint !== undefined &&
        this.lastFingerprint === contextFingerprint(this.snapshot.context),
      loading: [...this.refreshingIds].some((id) => !this.loadedIds.has(id))
    };
    this._onDidChange.fire(this.snapshot);
  }

  dispose(): void {
    this.clearTrailing();
    this.inFlight?.cancel();
    this.inFlight?.dispose();
    this._onDidChange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
