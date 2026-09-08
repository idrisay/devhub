import * as vscode from 'vscode';
import type { WorkContext } from '../../context/WorkContextService';
import type { AuthManager } from '../../infra/AuthManager';
import type { CacheStore } from '../../infra/CacheStore';
import { TTL } from '../../infra/CacheStore';
import { config } from '../../infra/Config';
import { log } from '../../infra/Logger';
import { Provider, ProviderStatus, statusFromError } from '../Provider';
import { SentryClient, SentryFrame, SentryIssue } from './SentryClient';
import { isAppFrame, resolveFrame } from './pathMapper';

export interface FrameLocation {
  file: string;
  line: number;
  function: string | undefined;
}

/** An issue plus the workspace locations its stack trace points at. */
export interface LocatedIssue extends SentryIssue {
  locations: FrameLocation[];
  /** True when the issue touches a file changed on this branch. */
  matchesDiff: boolean;
}

export class SentryProvider implements Provider<LocatedIssue> {
  readonly id = 'sentry' as const;
  readonly displayName = 'Sentry';

  private currentStatus: ProviderStatus = { health: 'unconfigured' };
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly auth: AuthManager,
    private readonly cache: CacheStore
  ) {}

  isConfigured(): boolean {
    return Boolean(config.sentry.organization());
  }

  status(): ProviderStatus {
    return this.currentStatus;
  }

  private async client(): Promise<SentryClient | undefined> {
    if (!this.isConfigured()) {
      this.currentStatus = { health: 'unconfigured', detail: 'Set the Sentry organization slug.' };
      return undefined;
    }
    const token = await this.auth.getToken('sentry');
    if (!token) {
      this.currentStatus = { health: 'unconfigured', detail: 'No auth token stored.' };
      return undefined;
    }
    return new SentryClient(config.sentry.baseUrl(), config.sentry.organization(), token);
  }

  /**
   * Two signals are combined: issues that mention the ticket key (explicit, from
   * Sentry's Jira integration) and issues whose stack traces touch a file in the
   * current diff (implicit, noisier to compute, far more useful in practice).
   */
  async forContext(ctx: WorkContext, token: vscode.CancellationToken): Promise<LocatedIssue[]> {
    const client = await this.client();
    if (!client) {
      return [];
    }

    let projects = config.sentry.projects();
    if (projects.length === 0) {
      try {
        projects = (await client.listProjects(token)).slice(0, 3);
      } catch (err) {
        this.currentStatus = statusFromError(err);
        return [];
      }
    }

    const environment = config.sentry.environment();
    const base = environment ? `is:unresolved environment:${environment}` : 'is:unresolved';
    const queries = [base];
    if (ctx.ticketKey) {
      queries.push(`${base} ${ctx.ticketKey}`);
    }

    const batches = await Promise.allSettled(
      projects.flatMap((project) =>
        queries.map((query) =>
          this.cache.wrap(
            `sentry.issues.${project}.${query}`,
            { ttl: TTL.sentryIssues, onRevalidated: () => this._onDidChange.fire() },
            () => client.listIssues(project, query, 25, token)
          )
        )
      )
    );

    const byId = new Map<string, SentryIssue>();
    let anySucceeded = false;
    for (const batch of batches) {
      if (batch.status === 'fulfilled') {
        anySucceeded = true;
        batch.value.forEach((issue) => byId.set(issue.id, issue));
      } else {
        this.currentStatus = statusFromError(batch.reason);
        log.error('Sentry issue query failed', batch.reason);
      }
    }

    if (anySucceeded) {
      this.currentStatus = { health: 'ok' };
    }

    if (token.isCancellationRequested) {
      return [];
    }

    const located = await this.locate([...byId.values()], ctx, client, token);

    // Diff matches first, then by blast radius.
    return located
      .filter((issue) => issue.matchesDiff || Boolean(ctx.ticketKey))
      .sort((a, b) => Number(b.matchesDiff) - Number(a.matchesDiff) || b.count - a.count)
      .slice(0, 25);
  }

  private async locate(
    issues: SentryIssue[],
    ctx: WorkContext,
    client: SentryClient,
    token: vscode.CancellationToken
  ): Promise<LocatedIssue[]> {
    if (!ctx.repoRoot) {
      return issues.map((issue) => ({ ...issue, locations: [], matchesDiff: false }));
    }

    const changed = new Set(ctx.changedFiles);
    const mappings = config.sentry.pathMappings();
    const knownFiles = await this.workspaceIndex(ctx);

    const results = await Promise.allSettled(
      issues.map(async (issue) => {
        const frames = await this.cache.wrap<SentryFrame[]>(
          `sentry.frames.${issue.id}`,
          { ttl: TTL.sentryEvent },
          () => client.getLatestFrames(issue.id, token)
        );

        const locations: FrameLocation[] = [];
        for (const frame of frames.filter(isAppFrame)) {
          const file = resolveFrame(frame.filename ?? '', {
            repoRoot: ctx.repoRoot as string,
            mappings,
            knownFiles
          });
          if (file && frame.lineNo) {
            locations.push({ file, line: frame.lineNo, function: frame.function });
          }
        }

        const located: LocatedIssue = {
          ...issue,
          frames,
          locations,
          matchesDiff: locations.some((l) => changed.has(l.file))
        };
        return located;
      })
    );

    const resolved: LocatedIssue[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        resolved.push(result.value);
      }
    }
    return resolved;
  }

  /**
   * Source files in the workspace, for resolving stack frames against.
   *
   * The changed files alone are not enough: a production error usually lives in
   * code this branch never touched, and a frame that can't be matched to a real
   * file produces no clickable location at all. Capped and cached for five
   * minutes because `findFiles` over a large repo is not cheap.
   */
  private indexCache?: { root: string; at: number; files: string[] };

  private async workspaceIndex(ctx: WorkContext): Promise<string[]> {
    const root = ctx.repoRoot;
    if (!root) {
      return ctx.changedFiles;
    }
    if (this.indexCache?.root === root && Date.now() - this.indexCache.at < 300_000) {
      return [...new Set([...ctx.changedFiles, ...this.indexCache.files])];
    }
    try {
      const found = await vscode.workspace.findFiles(
        '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rb,java,kt,cs,php,rs,vue,svelte}',
        '**/{node_modules,dist,build,out,.next,vendor,target}/**',
        5000
      );
      const files = found.map((uri) => uri.fsPath).filter((file) => file.startsWith(root));
      this.indexCache = { root, at: Date.now(), files };
      return [...new Set([...ctx.changedFiles, ...files])];
    } catch {
      // Never let indexing failure cost us the issue list.
      return ctx.changedFiles;
    }
  }

  /**
   * A frame-by-frame account of what the path mappings did, for when an issue
   * shows up with no clickable location and the reason isn't obvious.
   * Deliberately uses the same inputs as `locate`, so it explains what actually
   * happened rather than what would happen under different settings.
   */
  async explain(issue: LocatedIssue, ctx: WorkContext): Promise<string[]> {
    const mappings = config.sentry.pathMappings();
    const knownFiles = ctx.repoRoot ? await this.workspaceIndex(ctx) : [];
    const lines = [
      `${issue.shortId}  ${issue.title}`,
      `repoRoot: ${ctx.repoRoot ?? '(none)'}`,
      ''
    ];

    for (const frame of issue.frames ?? []) {
      const inApp = isAppFrame(frame);
      const resolved = ctx.repoRoot
        ? resolveFrame(frame.filename ?? '', { repoRoot: ctx.repoRoot, mappings, knownFiles })
        : undefined;
      lines.push(
        `${inApp ? 'app ' : 'lib '} ${frame.filename ?? '(no filename)'}:${frame.lineNo ?? '?'}` +
          `  \u2192  ${resolved ?? (inApp ? 'unresolved' : 'skipped (not app code)')}`
      );
    }
    return lines;
  }

  onCredentialsChanged(): void {
    this.currentStatus = { health: 'unconfigured' };
  }

  async verify(): Promise<string | undefined> {
    const client = await this.client();
    if (!client) {
      return undefined;
    }
    try {
      const name = await client.verify();
      this.currentStatus = { health: 'ok', detail: `Connected to ${name}` };
      return name;
    } catch (err) {
      this.currentStatus = statusFromError(err);
      return undefined;
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
