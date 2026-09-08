import * as vscode from 'vscode';
import type { WorkContext } from '../../context/WorkContextService';
import type { AuthManager } from '../../infra/AuthManager';
import { CacheStore, TTL } from '../../infra/CacheStore';
import { config } from '../../infra/Config';
import { log } from '../../infra/Logger';
import { statusFromError, type Provider, type ProviderStatus } from '../Provider';
import { GitHubClient, type PullQueues, type PullRequest } from './GitHubClient';
import { repoSlug, type RepoRef } from './remoteUrl';

/**
 * How long to wait before asking again about a pull request whose mergeability
 * came back UNKNOWN, and how many times to bother.
 *
 * GitHub computes mergeability lazily: the first request for a pull request it
 * hasn't recently merged-tested returns UNKNOWN and *starts* the calculation,
 * so the answer only exists once someone asks twice. Two retries a few seconds
 * apart covers it without becoming a poll — there is no timer running when
 * every pull request has a known answer.
 */
const MERGEABILITY_RECHECK_MS = 3_000;
const MERGEABILITY_RECHECK_LIMIT = 2;

const EMPTY_QUEUES: PullQueues = {
  viewer: '',
  mine: [],
  reviewRequested: [],
  filteredClientSide: false
};

export class GitHubProvider implements Provider<PullRequest> {
  readonly id = 'github' as const;
  readonly displayName = 'GitHub';

  private currentStatus: ProviderStatus = { health: 'unconfigured' };
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private recheckTimer?: NodeJS.Timeout;
  private recheckAttempts = 0;

  constructor(
    private readonly auth: AuthManager,
    private readonly cache: CacheStore
  ) {}

  isConfigured(): boolean {
    return config.github.enabled();
  }

  status(): ProviderStatus {
    return this.currentStatus;
  }

  onCredentialsChanged(): void {
    this.currentStatus = { health: 'unconfigured' };
    this.cancelRecheck();
    this.recheckAttempts = 0;
  }

  private async client(): Promise<GitHubClient | undefined> {
    if (!config.github.enabled()) {
      this.currentStatus = { health: 'unconfigured', detail: 'GitHub is disabled in settings.' };
      return undefined;
    }
    const token = await this.auth.getToken('github');
    if (!token) {
      this.currentStatus = { health: 'unconfigured', detail: 'No access token stored.' };
      return undefined;
    }
    return new GitHubClient(config.github.baseUrl(), token);
  }

  /** The pull request for the checked-out branch. */
  async forContext(ctx: WorkContext, token: vscode.CancellationToken): Promise<PullRequest[]> {
    if (!ctx.branch || !ctx.githubRepo) {
      if (ctx.branch && !ctx.githubRepo) {
        this.currentStatus = { health: 'ok', detail: 'Origin is not a GitHub remote.' };
      }
      return [];
    }
    const client = await this.client();
    if (!client) {
      return [];
    }

    const { owner, name } = ctx.githubRepo;
    try {
      const pull = await this.cache.wrap(
        `github.pr.${owner}.${name}.${ctx.branch}`,
        { ttl: TTL.pullRequest, onRevalidated: () => this._onDidChange.fire() },
        () => client.findPullForBranch(owner, name, ctx.branch as string, token)
      );
      this.currentStatus = { health: 'ok' };
      return pull ? [pull] : [];
    } catch (err) {
      this.currentStatus = statusFromError(err);
      log.error('GitHub branch pull request lookup failed', err);
      return [];
    }
  }

  /**
   * The user's open pull requests and the ones waiting on their review, across
   * every GitHub repository in the workspace.
   */
  async pullQueues(ctx: WorkContext, token: vscode.CancellationToken): Promise<PullQueues> {
    const repos = ctx.repos;
    if (repos.length === 0) {
      return EMPTY_QUEUES;
    }
    const client = await this.client();
    if (!client) {
      return EMPTY_QUEUES;
    }

    const limit = config.github.limit();
    const key = this.queuesKey(repos, limit);
    try {
      const queues = await this.cache.wrap(
        key,
        { ttl: TTL.pullQueues, onRevalidated: () => this._onDidChange.fire() },
        () => client.pullQueues(repos, limit, token)
      );
      this.currentStatus = { health: 'ok' };
      this.scheduleMergeabilityRecheck(queues, key, repos, limit);
      return queues;
    } catch (err) {
      this.currentStatus = statusFromError(err);
      log.error('GitHub pull request queues failed', err);
      return EMPTY_QUEUES;
    }
  }

  private queuesKey(repos: readonly RepoRef[], limit: number): string {
    const slugs = repos.map(repoSlug).sort().join(',');
    return `github.queues.${limit}.${slugs}`;
  }

  private scheduleMergeabilityRecheck(
    queues: PullQueues,
    key: string,
    repos: readonly RepoRef[],
    limit: number
  ): void {
    const pending = [...queues.mine, ...queues.reviewRequested].some(
      (pull) => pull.mergeable === 'unknown'
    );
    if (!pending) {
      this.recheckAttempts = 0;
      return;
    }
    if (this.recheckTimer || this.recheckAttempts >= MERGEABILITY_RECHECK_LIMIT) {
      return;
    }

    this.recheckAttempts++;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = undefined;
      void this.recheckMergeability(key, repos, limit);
    }, MERGEABILITY_RECHECK_MS);
  }

  /**
   * Refetches past the cache and writes the result back into it, so the refresh
   * this triggers finds the new answer instead of re-serving the UNKNOWN one.
   */
  private async recheckMergeability(
    key: string,
    repos: readonly RepoRef[],
    limit: number
  ): Promise<void> {
    try {
      const client = await this.client();
      if (!client) {
        return;
      }
      const fresh = await client.pullQueues(repos, limit);
      await this.cache.set(key, fresh);
      log.info('Rechecked pull request mergeability');
      this._onDidChange.fire();
    } catch (err) {
      // Nothing is broken if this fails — the badge just stays unknown.
      log.warn(`Mergeability recheck failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private cancelRecheck(): void {
    clearTimeout(this.recheckTimer);
    this.recheckTimer = undefined;
  }

  /** Proves a token before it is stored, and reports who it belongs to. */
  async verifyToken(token: string): Promise<string> {
    return new GitHubClient(config.github.baseUrl(), token).verify();
  }

  /** Checks the token already in storage, for the Connections view. */
  async verify(): Promise<string | undefined> {
    const client = await this.client();
    if (!client) {
      return undefined;
    }
    try {
      const login = await client.verify();
      this.currentStatus = { health: 'ok', detail: `Signed in as ${login}` };
      return login;
    } catch (err) {
      this.currentStatus = statusFromError(err);
      return undefined;
    }
  }

  dispose(): void {
    this.cancelRecheck();
    this._onDidChange.dispose();
  }
}
