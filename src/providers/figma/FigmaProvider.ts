import * as vscode from 'vscode';
import type { WorkContext } from '../../context/WorkContextService';
import type { AuthManager } from '../../infra/AuthManager';
import type { CacheStore } from '../../infra/CacheStore';
import { TTL } from '../../infra/CacheStore';
import { config } from '../../infra/Config';
import { log } from '../../infra/Logger';
import { Provider, ProviderStatus, statusFromError } from '../Provider';
import type { JiraProvider } from '../jira/JiraProvider';
import { FigmaClient, FigmaNodeSummary } from './FigmaClient';
import { extractFigmaRefs, FigmaRef } from './urlParser';

export interface DesignFrame extends FigmaNodeSummary {
  fileKey: string;
  url: string;
  /** Local file URI of the cached PNG, if the render succeeded. */
  image?: vscode.Uri;
}

export class FigmaProvider implements Provider<DesignFrame> {
  readonly id = 'figma' as const;
  readonly displayName = 'Figma';

  private currentStatus: ProviderStatus = { health: 'unconfigured' };
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly auth: AuthManager,
    private readonly cache: CacheStore,
    private readonly jira: JiraProvider
  ) {}

  isConfigured(): boolean {
    return config.figma.enabled();
  }

  status(): ProviderStatus {
    return this.currentStatus;
  }

  private async client(): Promise<FigmaClient | undefined> {
    if (!config.figma.enabled()) {
      this.currentStatus = { health: 'unconfigured', detail: 'Figma is disabled in settings.' };
      return undefined;
    }
    const token = await this.auth.getToken('figma');
    if (!token) {
      this.currentStatus = { health: 'unconfigured', detail: 'No access token stored.' };
      return undefined;
    }
    return new FigmaClient(token);
  }

  /** Design links come from the ticket body and its comments. */
  async forContext(ctx: WorkContext, token: vscode.CancellationToken): Promise<DesignFrame[]> {
    if (!ctx.ticketKey) {
      return [];
    }
    const issue = await this.jira.getIssue(ctx.ticketKey, token);
    if (!issue) {
      return [];
    }
    const refs = extractFigmaRefs(issue.links.join('\n'));
    if (refs.length === 0) {
      this.currentStatus = { health: 'ok', detail: 'No Figma links on this ticket.' };
      return [];
    }
    return this.load(refs, token);
  }

  async load(refs: FigmaRef[], token?: vscode.CancellationToken): Promise<DesignFrame[]> {
    const client = await this.client();
    if (!client) {
      return [];
    }

    const byFile = new Map<string, FigmaRef[]>();
    for (const ref of refs) {
      byFile.set(ref.fileKey, [...(byFile.get(ref.fileKey) ?? []), ref]);
    }

    const batches = await Promise.allSettled(
      [...byFile.entries()].map(([fileKey, fileRefs]) => this.loadFile(client, fileKey, fileRefs, token))
    );

    const frames: DesignFrame[] = [];
    for (const batch of batches) {
      if (batch.status === 'fulfilled') {
        frames.push(...batch.value);
        this.currentStatus = { health: 'ok' };
      } else {
        this.currentStatus = statusFromError(batch.reason);
        log.error('Figma load failed', batch.reason);
      }
    }
    return frames;
  }

  private async loadFile(
    client: FigmaClient,
    fileKey: string,
    refs: FigmaRef[],
    token?: vscode.CancellationToken
  ): Promise<DesignFrame[]> {
    const nodeIds = refs.map((r) => r.nodeId).filter((id): id is string => Boolean(id));
    if (nodeIds.length === 0) {
      return [];
    }

    const version = await this.cache.wrap(`figma.version.${fileKey}`, { ttl: TTL.figmaFile }, () =>
      client.getFileVersion(fileKey, token)
    );

    const summaries = await this.cache.wrap(
      `figma.nodes.${fileKey}.${version}.${nodeIds.join(',')}`,
      { ttl: Infinity },
      () => client.getNodes(fileKey, nodeIds, token)
    );

    // Image rendering is the expensive, heavily throttled call. Keyed on file
    // version so the cache only misses when the design actually changed.
    let images: Record<string, string> = {};
    try {
      images = await client.getImageUrls(fileKey, nodeIds, 2, token);
    } catch (err) {
      log.warn(`Could not render frames for ${fileKey}`);
    }

    return Promise.all(
      summaries.map(async (summary) => {
        const ref = refs.find((r) => r.nodeId === summary.id) ?? refs[0];
        let image: vscode.Uri | undefined;
        const remote = images[summary.id];
        if (remote) {
          try {
            image = await this.cache.blob(`${fileKey}-${version}-${summary.id}.png`, () =>
              client.download(remote, token)
            );
          } catch (err) {
            log.warn(`Failed to cache render for ${summary.name}`);
          }
        }
        return { ...summary, fileKey, url: ref.url, image };
      })
    );
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
      const handle = await client.verify();
      this.currentStatus = { health: 'ok', detail: `Signed in as ${handle}` };
      return handle;
    } catch (err) {
      this.currentStatus = statusFromError(err);
      return undefined;
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
