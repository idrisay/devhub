import * as vscode from 'vscode';
import { log } from './Logger';

interface Entry<T> {
  value: T;
  storedAt: number;
}

export interface CacheOptions {
  /** Milliseconds before an entry is considered stale. */
  ttl: number;
  /**
   * Serve a stale value immediately and refresh in the background.
   * The callback fires when fresh data lands.
   */
  onRevalidated?: (value: unknown) => void;
}

const PREFIX = 'devhub.cache.';

/**
 * Metadata lives in globalState; binary blobs live on disk under globalStorageUri.
 * Nothing here is a secret — SecretStorage handles those.
 */
export class CacheStore {
  private readonly blobDir: vscode.Uri;
  private readonly revalidating = new Set<string>();
  /** Concurrent loads of the same key collapse into one request. */
  private readonly loading = new Map<string, Promise<unknown>>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.blobDir = vscode.Uri.joinPath(context.globalStorageUri, 'blobs');
  }

  /**
   * Returns a cached value if fresh. If stale, returns the stale value straight
   * away and kicks off a background refresh, so panels never show a spinner for
   * data we already have.
   */
  async wrap<T>(key: string, options: CacheOptions, load: () => Promise<T>): Promise<T> {
    const stored = this.context.globalState.get<Entry<T>>(PREFIX + key);

    // `update()` serialises to JSON, which drops an `undefined` value and
    // leaves `{ storedAt }` behind. That reads back as a present entry whose
    // value is undefined, and serving it hands the caller undefined where its
    // own signature promised an array — the caller then stores that and blows
    // up somewhere unrelated. Treat it as a miss.
    const entry = stored && stored.value !== undefined ? stored : undefined;
    const age = entry ? Date.now() - entry.storedAt : Infinity;

    if (entry && age < options.ttl) {
      return entry.value;
    }

    if (entry && options.onRevalidated) {
      void this.revalidate(key, load, options.onRevalidated);
      return entry.value;
    }

    return this.load(key, load);
  }

  /**
   * A cold load, deduplicated by key.
   *
   * Two things arrive here at once often enough to matter: a branch switch that
   * lands while the previous fan-out is still running, and two views asking for
   * the same key in the same tick. Without this they became two identical
   * requests, and the loser overwrote the winner's cache entry.
   */
  private async load<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.loading.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    const promise = (async () => {
      const value = await load();
      await this.set(key, value);
      return value;
    })().finally(() => this.loading.delete(key));

    this.loading.set(key, promise);
    return promise;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.context.globalState.get<Entry<T>>(PREFIX + key)?.value;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.context.globalState.update(PREFIX + key, { value, storedAt: Date.now() });
  }

  private async revalidate<T>(
    key: string,
    load: () => Promise<T>,
    onRevalidated: (value: T) => void
  ): Promise<void> {
    if (this.revalidating.has(key)) {
      return;
    }
    this.revalidating.add(key);
    try {
      const value = await this.load(key, load);
      onRevalidated(value);
    } catch (err) {
      log.warn(`Background refresh failed for ${key}`);
    } finally {
      this.revalidating.delete(key);
    }
  }

  /** Figma renders are immutable per file version, so these never expire. */
  async blob(key: string, load: () => Promise<Uint8Array>): Promise<vscode.Uri> {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    const target = vscode.Uri.joinPath(this.blobDir, safe);
    try {
      await vscode.workspace.fs.stat(target);
      return target;
    } catch {
      // Not cached yet.
    }
    const bytes = await load();
    await vscode.workspace.fs.createDirectory(this.blobDir);
    await vscode.workspace.fs.writeFile(target, bytes);
    return target;
  }

  get blobRoot(): vscode.Uri {
    return this.blobDir;
  }

  /**
   * Drops every entry under a prefix, so the next read is a real request.
   *
   * This is what makes an explicit refresh mean it. The TTLs are deliberately
   * generous — a background revalidation the user never sees is worth more than
   * a fast-expiring entry that costs a request on every window focus — so the
   * refresh command needs a way to bypass them.
   */
  async invalidate(prefix: string): Promise<void> {
    for (const key of this.context.globalState.keys()) {
      if (key.startsWith(PREFIX + prefix)) {
        await this.context.globalState.update(key, undefined);
      }
    }
  }

  async clear(): Promise<void> {
    for (const key of this.context.globalState.keys()) {
      if (key.startsWith(PREFIX)) {
        await this.context.globalState.update(key, undefined);
      }
    }
    try {
      await vscode.workspace.fs.delete(this.blobDir, { recursive: true });
    } catch {
      // Nothing to delete.
    }
    log.info('Cache cleared');
  }
}

export const TTL = {
  issue: 60_000,
  myTasks: 120_000,
  // Priority schemes change about as often as the company name.
  priorities: 24 * 60 * 60_000,
  transitions: 60 * 60_000,
  sentryIssues: 120_000,
  sentryEvent: 5 * 60_000,
  figmaFile: 5 * 60_000,
  // Four REST calls per miss — the pull request, its reviews, its checks and its
  // comments — so this is the most expensive entry in here. Stale-while-
  // revalidate means the rows are on screen throughout, and `devhub.refresh`
  // bypasses it when someone is actually watching a CI run.
  pullRequest: 90_000,
  // One GraphQL request for both queues. Long enough that alt-tabbing all
  // afternoon costs nothing, short enough that a review request shows up while
  // it still matters.
  pullQueues: 120_000,
  // One request for the whole instance, and an alert you can't see for two
  // minutes is an alert you find out about from someone else.
  grafanaAlerts: 60_000,
  grafanaLatency: 120_000
} as const;
