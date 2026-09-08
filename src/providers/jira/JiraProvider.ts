import * as vscode from 'vscode';
import type { WorkContext } from '../../context/WorkContextService';
import type { AuthManager } from '../../infra/AuthManager';
import type { CacheStore } from '../../infra/CacheStore';
import { TTL } from '../../infra/CacheStore';
import { config } from '../../infra/Config';
import { log } from '../../infra/Logger';
import { Provider, ProviderStatus } from '../Provider';
import { diagnoseJiraFailure } from './diagnose';
import { JiraClient, JiraIssue, JiraTransition } from './JiraClient';

export class JiraProvider implements Provider<JiraIssue> {
  readonly id = 'jira' as const;
  readonly displayName = 'Jira';

  private currentStatus: ProviderStatus = { health: 'unconfigured' };
  private probed = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly auth: AuthManager,
    private readonly cache: CacheStore
  ) {}

  isConfigured(): boolean {
    return Boolean(config.jira.baseUrl() && config.jira.email());
  }

  status(): ProviderStatus {
    return this.currentStatus;
  }

  /** Records the failure as status and returns the message to show the user. */
  private record(err: unknown): string {
    const failure = diagnoseJiraFailure(err, {
      baseUrl: config.jira.baseUrl(),
      email: config.jira.email()
    });
    this.currentStatus = {
      health: failure.health,
      detail: failure.summary,
      hint: failure.message
    };
    return failure.message;
  }

  private async client(): Promise<JiraClient | undefined> {
    if (!this.isConfigured()) {
      this.currentStatus = { health: 'unconfigured', detail: 'Set the Jira site URL and email.' };
      return undefined;
    }
    const token = await this.auth.getToken('jira');
    if (!token) {
      this.currentStatus = { health: 'unconfigured', detail: 'No API token stored.' };
      return undefined;
    }
    return new JiraClient(config.jira.baseUrl(), config.jira.email(), token);
  }

  async forContext(ctx: WorkContext, token: vscode.CancellationToken): Promise<JiraIssue[]> {
    if (!ctx.ticketKey) {
      // Nothing to fetch, but a stored token that no longer works should still
      // show up in the sidebar rather than looking like an ordinary branch.
      await this.probe(token);
      return [];
    }
    const issue = await this.getIssue(ctx.ticketKey, token);
    return issue ? [issue] : [];
  }

  async getIssue(key: string, token?: vscode.CancellationToken): Promise<JiraIssue | undefined> {
    const client = await this.client();
    if (!client) {
      return undefined;
    }
    try {
      const issue = await this.cache.wrap(
        `jira.issue.${key}`,
        { ttl: TTL.issue, onRevalidated: () => this._onDidChange.fire() },
        () => client.getIssue(key, token)
      );
      this.currentStatus = { health: 'ok' };
      return issue;
    } catch (err) {
      log.error(`Failed to load ${key}: ${this.record(err)}`, err);
      return undefined;
    }
  }

  /**
   * Fallback list when no ticket is detected, and the source for the picker.
   *
   * Throws rather than returning an empty array: an empty result has to mean
   * "the JQL matched nothing", or callers cannot tell the two apart.
   */
  async forMe(token?: vscode.CancellationToken): Promise<JiraIssue[]> {
    const client = await this.client();
    if (!client) {
      throw new Error(this.currentStatus.detail ?? 'Jira is not connected.');
    }
    try {
      const issues = await client.search(config.jira.jql(), 30, token);
      this.currentStatus = { health: 'ok' };
      return issues;
    } catch (err) {
      const message = this.record(err);
      log.error('Failed to run JQL search', err);
      throw new Error(message);
    }
  }

  /**
   * Everything assigned to the user, for the task list. Cached and revalidated
   * in the background because Hub.refresh runs on every branch change and
   * window focus, and this list does not depend on either.
   */
  async assignedToMe(token?: vscode.CancellationToken): Promise<JiraIssue[]> {
    const client = await this.client();
    if (!client) {
      throw new Error(this.currentStatus.detail ?? 'Jira is not connected.');
    }
    const jql = config.jira.tasksJql();
    const limit = config.jira.tasksLimit();
    try {
      const issues = await this.cache.wrap(
        `jira.myTasks.${limit}.${jql}`,
        { ttl: TTL.myTasks, onRevalidated: () => this._onDidChange.fire() },
        () => client.search(jql, limit, token)
      );
      this.currentStatus = { health: 'ok' };
      return issues;
    } catch (err) {
      const message = this.record(err);
      log.error('Failed to load assigned tasks', err);
      throw new Error(message);
    }
  }

  /**
   * The site's priority names, most urgent first. Returns an empty array rather
   * than throwing: an unsortable list is still a usable list, so a failure here
   * must not take the whole view down with it.
   */
  async priorityOrder(token?: vscode.CancellationToken): Promise<string[]> {
    const client = await this.client();
    if (!client) {
      return [];
    }
    try {
      return await this.cache.wrap(`jira.priorities`, { ttl: TTL.priorities }, () =>
        client.getPriorities(token)
      );
    } catch (err) {
      log.warn('Could not read the Jira priority scheme; falling back to the well-known names');
      return [];
    }
  }

  /** Drops the cached task list so the next read hits Jira. */
  async invalidateTasks(): Promise<void> {
    const key = `jira.myTasks.${config.jira.tasksLimit()}.${config.jira.tasksJql()}`;
    await this.cache.set(key, undefined);
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const client = await this.client();
    if (!client) {
      return [];
    }
    return this.cache.wrap(`jira.transitions.${key}`, { ttl: TTL.transitions }, () =>
      client.getTransitions(key)
    );
  }

  async transition(key: string, transitionId: string): Promise<void> {
    const client = await this.client();
    if (!client) {
      throw new Error('Jira is not connected.');
    }
    await client.transition(key, transitionId);
    await this.cache.set(`jira.issue.${key}`, undefined);
    await this.invalidateTasks();
    this._onDidChange.fire();
  }

  async addComment(key: string, body: string): Promise<void> {
    const client = await this.client();
    if (!client) {
      throw new Error('Jira is not connected.');
    }
    await client.addComment(key, body);
    await this.cache.set(`jira.issue.${key}`, undefined);
    await this.invalidateTasks();
    this._onDidChange.fire();
  }

  /** Also clears `probed`, which would otherwise skip the next credential check. */
  onCredentialsChanged(): void {
    this.probed = false;
    this.currentStatus = { health: 'unconfigured' };
  }

  async verify(): Promise<string | undefined> {
    const client = await this.client();
    if (!client) {
      return undefined;
    }
    this.probed = true;
    try {
      const name = await client.verify();
      this.currentStatus = { health: 'ok', detail: `Signed in as ${name}` };
      return name;
    } catch (err) {
      this.record(err);
      return undefined;
    }
  }

  /**
   * Checks a token that has not been stored yet. Rejects with the diagnosed
   * message so AuthManager can refuse to persist it and say why.
   */
  async verifyToken(candidate: string): Promise<string> {
    const baseUrl = config.jira.baseUrl();
    const email = config.jira.email();
    if (!baseUrl || !email) {
      throw new Error('Set devhub.jira.baseUrl and devhub.jira.email before adding a token.');
    }
    const client = new JiraClient(baseUrl, email, candidate);
    try {
      const name = await client.verify();
      this.currentStatus = { health: 'ok', detail: `Signed in as ${name}` };
      this.probed = true;
      return name;
    } catch (err) {
      throw new Error(diagnoseJiraFailure(err, { baseUrl, email }).message);
    }
  }

  /** One cheap /myself call per session while the status is still unproven. */
  private async probe(token?: vscode.CancellationToken): Promise<void> {
    if (this.probed || this.currentStatus.health === 'ok') {
      return;
    }
    const client = await this.client();
    if (!client) {
      return;
    }
    this.probed = true;
    try {
      const name = await client.verify(token);
      this.currentStatus = { health: 'ok', detail: `Signed in as ${name}` };
    } catch (err) {
      log.error(`Jira credential check failed: ${this.record(err)}`, err);
    }
  }

  browseUrl(key: string): string {
    return `${config.jira.baseUrl()}/browse/${key}`;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
