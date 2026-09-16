import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkContext } from '../../context/WorkContextService';
import type { AuthManager } from '../../infra/AuthManager';
import type { CacheStore } from '../../infra/CacheStore';
import { TTL } from '../../infra/CacheStore';
import { config } from '../../infra/Config';
import { log } from '../../infra/Logger';
import { Provider, ProviderStatus, statusFromError } from '../Provider';
import {
  exploreUrl,
  GrafanaClient,
  type Datasource,
  type DatasourceKind,
  RawRule,
  RawRuleGroup
} from './GrafanaClient';
import {
  endpointLabel,
  latencyCandidates,
  renderLatencyQuery,
  type LatencyCandidate
} from './latencyQuery';
import {
  alertMatchesScope,
  mentionsTicket,
  scopeForRepo,
  toPromSelector,
  type ServiceScope
} from './serviceScope';

export interface GrafanaAlert {
  /** Rule uid where Grafana gave one, else the rule name. Stable per row. */
  id: string;
  name: string;
  state: 'firing' | 'pending';
  severity?: string;
  summary?: string;
  folder?: string;
  labels: Record<string, string>;
  /** When the earliest matching instance started firing. */
  activeAt?: string;
  /** How many series are alerting under this rule. */
  instances: number;
  url: string;
  /** Why this alert is in your list. */
  matchedBy: 'service' | 'ticket';
}

export interface SlowEndpoint {
  label: string;
  seconds: number;
  metric: Record<string, string>;
}

export interface LatencySnapshot {
  endpoints: SlowEndpoint[];
  query: string;
  datasourceUid: string;
  kind: DatasourceKind;
  window: string;
  /** Set when the section could not run: what the user needs to fix. */
  note?: string;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  error: 1,
  high: 1,
  warning: 2,
  warn: 2,
  info: 3,
  none: 4
};

function severityRank(severity: string | undefined): number {
  return SEVERITY_RANK[(severity ?? 'none').toLowerCase()] ?? 4;
}

/** The repository name a service selector is keyed by. */
export function repoNameOf(ctx: WorkContext): string | undefined {
  if (ctx.githubRepo?.name) {
    return ctx.githubRepo.name;
  }
  return ctx.repoRoot ? path.basename(ctx.repoRoot) : undefined;
}

export class GrafanaProvider implements Provider<GrafanaAlert> {
  readonly id = 'grafana' as const;
  readonly displayName = 'Grafana';

  private currentStatus: ProviderStatus = { health: 'unconfigured' };
  /** The last fetched rules, for explaining an empty list without refetching. */
  private lastRules: RawRuleGroup[] = [];
  private lastFiringTotal = 0;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly auth: AuthManager,
    private readonly cache: CacheStore
  ) {}

  isConfigured(): boolean {
    return config.grafana.enabled() && Boolean(config.grafana.baseUrl());
  }

  status(): ProviderStatus {
    return this.currentStatus;
  }

  private async client(): Promise<GrafanaClient | undefined> {
    if (!config.grafana.enabled()) {
      this.currentStatus = { health: 'unconfigured', detail: 'Grafana is turned off.' };
      return undefined;
    }
    if (!config.grafana.baseUrl()) {
      this.currentStatus = { health: 'unconfigured', detail: 'Set the Grafana URL.' };
      return undefined;
    }
    const token = await this.auth.getToken('grafana');
    if (!token) {
      this.currentStatus = { health: 'unconfigured', detail: 'No service account token stored.' };
      return undefined;
    }
    return new GrafanaClient(config.grafana.baseUrl(), token);
  }

  /** The label matchers that stand for "the service this repository is". */
  scope(ctx: WorkContext): ServiceScope {
    return scopeForRepo(repoNameOf(ctx), config.grafana.services(), config.grafana.serviceLabels());
  }

  /**
   * Firing and pending alerts for the service this repository is, plus any
   * alert that names the current ticket. One row per rule: a rule alerting on
   * forty series is one thing being wrong, not forty.
   */
  async forContext(ctx: WorkContext, token: vscode.CancellationToken): Promise<GrafanaAlert[]> {
    const client = await this.client();
    if (!client) {
      return [];
    }

    let groups: RawRuleGroup[];
    try {
      groups = await this.cache.wrap(
        'grafana.rules',
        { ttl: TTL.grafanaAlerts, onRevalidated: () => this._onDidChange.fire() },
        () => client.listRules(token)
      );
    } catch (err) {
      this.currentStatus = statusFromError(err);
      log.error('Grafana rule query failed', err);
      return [];
    }

    this.currentStatus = { health: 'ok' };

    if (token.isCancellationRequested) {
      return [];
    }

    this.lastRules = groups;
    this.lastFiringTotal = groups.reduce(
      (total, group) =>
        total +
        (group.rules ?? []).filter((rule) =>
          ['firing', 'pending', 'alerting'].includes((rule.state ?? '').toLowerCase())
        ).length,
      0
    );

    const scope = this.scope(ctx);
    const fallbackLabels = config.grafana.serviceLabels();
    const repoName = repoNameOf(ctx);

    const alerts: GrafanaAlert[] = [];
    for (const group of groups) {
      for (const rule of group.rules ?? []) {
        const alert = this.toAlert(rule, group, client, {
          scope,
          fallbackLabels,
          repoName,
          ticketKey: ctx.ticketKey
        });
        if (alert) {
          alerts.push(alert);
        }
      }
    }

    return alerts
      .sort(
        (a, b) =>
          Number(a.state === 'pending') - Number(b.state === 'pending') ||
          severityRank(a.severity) - severityRank(b.severity) ||
          // Longest-burning first: an alert that has been firing all morning is
          // more interesting than the one that started while you read this.
          Date.parse(a.activeAt ?? '') - Date.parse(b.activeAt ?? '')
      )
      .slice(0, 25);
  }

  private toAlert(
    rule: RawRule,
    group: RawRuleGroup,
    client: GrafanaClient,
    ctx: {
      scope: ServiceScope;
      fallbackLabels: string[];
      repoName: string | undefined;
      ticketKey: string | undefined;
    }
  ): GrafanaAlert | undefined {
    const state = (rule.state ?? '').toLowerCase();
    if (state !== 'firing' && state !== 'pending' && state !== 'alerting') {
      return undefined;
    }

    const ruleLabels = rule.labels ?? {};
    const ruleAnnotations = rule.annotations ?? {};
    const instances = (rule.alerts ?? []).filter(
      (instance) => (instance.state ?? '').toLowerCase() !== 'normal'
    );

    // Scope is decided on the instance labels, not the rule's: the series
    // labels that say which service is affected only exist per instance.
    const candidates = instances.length > 0 ? instances : [{ labels: {}, annotations: {} }];
    const matching = candidates.filter((instance) =>
      alertMatchesScope(
        { ...ruleLabels, ...(instance.labels ?? {}) },
        ctx.scope,
        ctx.fallbackLabels,
        ctx.repoName
      )
    );

    let matchedBy: GrafanaAlert['matchedBy'] = 'service';
    let chosen = matching;
    if (matching.length === 0) {
      const named = candidates.filter((instance) =>
        mentionsTicket(
          {
            labels: { ...ruleLabels, ...(instance.labels ?? {}) },
            annotations: { ...ruleAnnotations, ...(instance.annotations ?? {}) }
          },
          ctx.ticketKey
        )
      );
      if (named.length === 0) {
        return undefined;
      }
      matchedBy = 'ticket';
      chosen = named;
    }

    const first = chosen[0];
    const labels = { ...ruleLabels, ...(first.labels ?? {}) };
    const annotations = { ...ruleAnnotations, ...(first.annotations ?? {}) };
    const ruleUid = labels.__alert_rule_uid__;
    const activeAt = chosen
      .map((instance) => instance.activeAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0];

    return {
      id: ruleUid ?? `${group.file ?? group.name}/${rule.name}`,
      name: rule.name,
      state: state === 'pending' ? 'pending' : 'firing',
      severity: labels.severity,
      summary: annotations.summary || annotations.description,
      folder: group.file,
      labels,
      activeAt,
      instances: chosen.length,
      url: client.ruleUrl(ruleUid, rule.name),
      matchedBy
    };
  }

  /**
   * The slowest endpoints for this service, as an instant PromQL query through
   * Grafana's datasource proxy. Returns the query it ran either way, so a
   * result of nothing can be told apart from a query that doesn't fit the
   * metrics this stack actually exports.
   */
  async latency(
    ctx: WorkContext,
    token: vscode.CancellationToken
  ): Promise<LatencySnapshot | undefined> {
    const client = await this.client();
    if (!client) {
      return undefined;
    }

    const datasourceUid = config.grafana.latency.datasourceUid();
    const kind = config.grafana.latency.datasourceKind();
    const window = config.grafana.latency.window();
    const limit = config.grafana.latency.limit();
    const scope = this.scope(ctx);
    const query = renderLatencyQuery(config.grafana.latency.query(), {
      selector: toPromSelector(scope.matchers),
      service: repoNameOf(ctx) ?? '',
      window,
      limit
    });

    if (!datasourceUid) {
      return {
        endpoints: [],
        query,
        datasourceUid: '',
        kind,
        window,
        note: 'No datasource chosen yet — run DevHub: Set up latency query…'
      };
    }

    try {
      const samples = await this.cache.wrap(
        `grafana.latency.${datasourceUid}.${query}`,
        { ttl: TTL.grafanaLatency, onRevalidated: () => this._onDidChange.fire() },
        () => client.instantQuery(datasourceUid, query, token, kind)
      );

      const endpoints = samples
        .map((sample) => ({
          label: endpointLabel(sample.metric ?? {}),
          seconds: Number(sample.value?.[1]),
          metric: sample.metric ?? {}
        }))
        .filter((endpoint) => Number.isFinite(endpoint.seconds))
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, limit);

      return { endpoints, query, datasourceUid, kind, window };
    } catch (err) {
      log.error('Grafana latency query failed', err);
      // A bad query is the user's to fix and shouldn't mark the whole provider
      // broken — alerts are still fine.
      const message = err instanceof Error ? err.message : String(err);
      return { endpoints: [], query, datasourceUid, kind, window, note: message };
    }
  }

  /**
   * How many alerts are firing anywhere in Grafana, matched or not. "Nothing
   * firing for this service" and "nine firing, none of them yours" call for
   * very different reactions, and only this number tells them apart.
   */
  get firingTotal(): number {
    return this.lastFiringTotal;
  }

  /**
   * Label names and values carried by the firing alerts, so the scope can be
   * fixed by picking from what is actually there. Reads the last fetch rather
   * than the network: the data is already in hand.
   */
  alertLabelFacets(): Map<string, Set<string>> {
    const facets = new Map<string, Set<string>>();
    for (const group of this.lastRules) {
      for (const rule of group.rules ?? []) {
        if (!['firing', 'pending', 'alerting'].includes((rule.state ?? '').toLowerCase())) {
          continue;
        }
        for (const instance of rule.alerts ?? []) {
          for (const [key, value] of Object.entries({ ...rule.labels, ...instance.labels })) {
            if (key.startsWith('__') || !value) {
              continue;
            }
            const values = facets.get(key) ?? new Set<string>();
            values.add(value);
            facets.set(key, values);
          }
        }
      }
    }
    return facets;
  }

  /**
   * Discovery for the latency setup flow. These go straight to the network
   * rather than through the cache: they run once, when the user is sitting in
   * front of a quick pick waiting for the answer.
   */
  async datasources(token: vscode.CancellationToken): Promise<Datasource[]> {
    const client = await this.client();
    if (!client) {
      return [];
    }
    const all = await client.listDatasources(token);
    return all.filter((ds) => ds.type === 'prometheus');
  }

  /**
   * Everything in the datasource that could yield a latency figure, plus the
   * full metric count — a caller that finds nothing needs to be able to say
   * whether it looked at ten metrics or ten thousand.
   */
  async latencyMetrics(
    datasourceUid: string,
    token: vscode.CancellationToken
  ): Promise<{ candidates: LatencyCandidate[]; total: number; sample: string[] }> {
    const client = await this.client();
    if (!client) {
      return { candidates: [], total: 0, sample: [] };
    }
    const names = await client.labelValues(datasourceUid, '__name__', undefined, token);
    const sample = names
      .filter((name) => /duration|latency|request|response|seconds|time/i.test(name))
      .slice(0, 40);
    log.info(
      `Grafana: ${names.length} metric(s) in ${datasourceUid}; ` +
        `${sample.length} look latency-related: ${sample.join(', ') || '(none)'}`
    );
    return { candidates: latencyCandidates(names), total: names.length, sample };
  }

  async metricLabels(
    datasourceUid: string,
    metric: string,
    token: vscode.CancellationToken
  ): Promise<string[]> {
    const client = await this.client();
    return client ? client.labelNames(datasourceUid, metric, token) : [];
  }

  async metricLabelValues(
    datasourceUid: string,
    metric: string,
    label: string,
    token: vscode.CancellationToken
  ): Promise<string[]> {
    const client = await this.client();
    return client ? client.labelValues(datasourceUid, label, metric, token) : [];
  }

  /** How many series a query returns right now. Used to test a candidate. */
  async probe(
    datasourceUid: string,
    query: string,
    token: vscode.CancellationToken,
    kind: DatasourceKind = 'prometheus'
  ): Promise<number> {
    const client = await this.client();
    if (!client) {
      return 0;
    }
    const samples = await client.instantQuery(datasourceUid, query, token, kind);
    return samples.length;
  }

  /** Loki datasources the token can see. */
  async lokiDatasources(token: vscode.CancellationToken): Promise<Datasource[]> {
    const client = await this.client();
    if (!client) {
      return [];
    }
    return (await client.listDatasources(token)).filter((ds) => ds.type === 'loki');
  }

  async lokiLabels(datasourceUid: string, token: vscode.CancellationToken): Promise<string[]> {
    const client = await this.client();
    return client ? client.lokiLabels(datasourceUid, token) : [];
  }

  async lokiLabelValues(
    datasourceUid: string,
    label: string,
    token: vscode.CancellationToken
  ): Promise<string[]> {
    const client = await this.client();
    return client ? client.lokiLabelValues(datasourceUid, label, token) : [];
  }

  async lokiSample(
    datasourceUid: string,
    selector: string,
    token: vscode.CancellationToken
  ): Promise<string[]> {
    const client = await this.client();
    return client ? client.lokiSample(datasourceUid, selector, 25, token) : [];
  }

  /** The Explore link for the latency query, for the view's title action. */
  exploreUrl(snapshot: LatencySnapshot): string | undefined {
    const baseUrl = config.grafana.baseUrl();
    if (!baseUrl || !snapshot.datasourceUid) {
      return undefined;
    }
    return exploreUrl(
      baseUrl,
      snapshot.datasourceUid,
      snapshot.query,
      snapshot.window,
      snapshot.kind
    );
  }

  onCredentialsChanged(): void {
    this.currentStatus = { health: 'unconfigured' };
    this.lastRules = [];
    this.lastFiringTotal = 0;
  }

  async verify(): Promise<string | undefined> {
    const client = await this.client();
    if (!client) {
      return undefined;
    }
    try {
      const org = await client.verify();
      this.currentStatus = { health: 'ok', detail: `Connected to ${org}` };
      return org;
    } catch (err) {
      this.currentStatus = statusFromError(err);
      return undefined;
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
