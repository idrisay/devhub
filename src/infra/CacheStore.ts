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

  constructor(private readonly context: vscode.ExtensionContext) {
    this.blobDir = vscode.Uri.joinPath(context.globalStorageUri, 'blobs');
  }

  /**
   * Returns a cached value if fresh. If stale, returns the stale value straight
   * away and kicks off a background refresh, so panels never show a spinner for
   * data we already have.
   */
  async wrap<T>(key: string, options: CacheOptions, load: () => Promise<T>): Promise<T> {
    const entry = this.context.globalState.get<Entry<T>>(PREFIX + key);
    const age = entry ? Date.now() - entry.storedAt : Infinity;

    if (entry && age < options.ttl) {
      return entry.value;
    }

    if (entry && options.onRevalidated) {
      void this.revalidate(key, load, options.onRevalidated);
      return entry.value;
    }

    const value = await load();
    await this.set(key, value);
    return value;
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
      const value = await load();
      await this.set(key, value);
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
  pullRequest: 45_000,
  // Short: a review landing on someone else's PR is invisible until this
  // expires, and the whole thing costs one GraphQL request.
  pullQueues: 60_000
} as const;
