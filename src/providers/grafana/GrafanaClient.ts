import type * as vscode from 'vscode';
import { http } from '../../infra/HttpClient';

/** One alert rule as Grafana's Prometheus-compatible API reports it. */
export interface RawRule {
  name: string;
  state?: string;
  type?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  alerts?: RawAlertInstance[];
}

export interface RawAlertInstance {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  state?: string;
  activeAt?: string;
  value?: string;
}

export interface RawRuleGroup {
  name: string;
  /** The folder the rules live in. */
  file?: string;
  rules?: RawRule[];
}

interface RulesResponse {
  data?: { groups?: RawRuleGroup[] };
}

export interface PromSample {
  metric: Record<string, string>;
  /** `[unixSeconds, "value"]` */
  value: [number, string];
}

interface QueryResponse {
  data?: { result?: PromSample[] };
}

interface OrgResponse {
  name?: string;
}

export type DatasourceKind = 'prometheus' | 'loki';

interface LokiStreamResponse {
  data?: { result?: { values?: [string, string][] }[] };
}

export interface Datasource {
  uid: string;
  name: string;
  type: string;
  isDefault?: boolean;
}

export class GrafanaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  /** The organisation the token belongs to, which is what identifies it. */
  async verify(token?: vscode.CancellationToken): Promise<string> {
    const org = await http.json<OrgResponse>(`${this.baseUrl}/api/org`, {
      headers: this.headers,
      token
    });
    return org?.name?.trim() || 'Grafana';
  }

  /**
   * Every Grafana-managed alert rule with its current state.
   *
   * The `state` filters are advisory: older Grafana ignores unknown query
   * parameters and returns everything, so the caller filters again rather than
   * trusting the server to have narrowed anything.
   */
  async listRules(token?: vscode.CancellationToken): Promise<RawRuleGroup[]> {
    const url = `${this.baseUrl}/api/prometheus/grafana/api/v1/rules?state=alerting&state=pending`;
    const response = await http.json<RulesResponse>(url, { headers: this.headers, token });
    return response?.data?.groups ?? [];
  }

  /**
   * An instant PromQL query, run through Grafana's datasource proxy so the
   * Prometheus behind it needs no credentials or network route of its own.
   */
  async instantQuery(
    datasourceUid: string,
    query: string,
    token?: vscode.CancellationToken,
    kind: DatasourceKind = 'prometheus'
  ): Promise<PromSample[]> {
    // Loki's metric queries answer on its own path but in the same shape, so
    // everything downstream of here is identical.
    const path = kind === 'loki' ? '/loki/api/v1/query' : '/api/v1/query';
    const url =
      `${this.baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}` +
      `${path}?query=${encodeURIComponent(query)}`;
    const response = await http.json<QueryResponse>(url, { headers: this.headers, token });
    return response?.data?.result ?? [];
  }

  /** Stream label names Loki knows about, over the last six hours. */
  async lokiLabels(datasourceUid: string, token?: vscode.CancellationToken): Promise<string[]> {
    const response = await http.json<{ data?: string[] }>(
      `${this.proxy(datasourceUid)}/loki/api/v1/labels?${this.lokiRange()}`,
      { headers: this.headers, token }
    );
    return (response?.data ?? []).filter((name) => !name.startsWith('__'));
  }

  async lokiLabelValues(
    datasourceUid: string,
    label: string,
    token?: vscode.CancellationToken
  ): Promise<string[]> {
    const response = await http.json<{ data?: string[] }>(
      `${this.proxy(datasourceUid)}/loki/api/v1/label/${encodeURIComponent(label)}/values` +
        `?${this.lokiRange()}`,
      { headers: this.headers, token }
    );
    return response?.data ?? [];
  }

  /**
   * A handful of recent lines from a stream, for working out how they are
   * structured. Sampling beats asking the user to describe their log format.
   */
  async lokiSample(
    datasourceUid: string,
    selector: string,
    limit: number,
    token?: vscode.CancellationToken
  ): Promise<string[]> {
    const url =
      `${this.proxy(datasourceUid)}/loki/api/v1/query_range` +
      `?query=${encodeURIComponent(selector)}&limit=${limit}&direction=backward&${this.lokiRange()}`;
    const response = await http.json<LokiStreamResponse>(url, { headers: this.headers, token });
    const lines: string[] = [];
    for (const stream of response?.data?.result ?? []) {
      for (const [, line] of stream.values ?? []) {
        lines.push(line);
      }
    }
    return lines;
  }

  private proxy(datasourceUid: string): string {
    return `${this.baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}`;
  }

  /** Loki wants nanosecond timestamps, and defaults to a window that can miss. */
  private lokiRange(hours = 6): string {
    const end = Date.now();
    const start = end - hours * 3600_000;
    return `start=${start}000000&end=${end}000000`;
  }

  /** Every datasource the token can see, for picking the Prometheus one. */
  async listDatasources(token?: vscode.CancellationToken): Promise<Datasource[]> {
    const list = await http.json<Datasource[]>(`${this.baseUrl}/api/datasources`, {
      headers: this.headers,
      token
    });
    return Array.isArray(list) ? list : [];
  }

  /**
   * Values of one label, optionally restricted to the series matching a
   * selector. `__name__` yields the metric names themselves.
   */
  async labelValues(
    datasourceUid: string,
    label: string,
    match?: string,
    token?: vscode.CancellationToken
  ): Promise<string[]> {
    const query = match ? `?match[]=${encodeURIComponent(match)}` : '';
    const url =
      `${this.baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}` +
      `/api/v1/label/${encodeURIComponent(label)}/values${query}`;
    const response = await http.json<{ data?: string[] }>(url, { headers: this.headers, token });
    return response?.data ?? [];
  }

  /** Label names carried by the series a selector matches. */
  async labelNames(
    datasourceUid: string,
    match: string,
    token?: vscode.CancellationToken
  ): Promise<string[]> {
    const url =
      `${this.baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}` +
      `/api/v1/labels?match[]=${encodeURIComponent(match)}`;
    const response = await http.json<{ data?: string[] }>(url, { headers: this.headers, token });
    return response?.data ?? [];
  }

  /** Deep link to a rule's detail page. */
  ruleUrl(ruleUid: string | undefined, name: string): string {
    return ruleUid
      ? `${this.baseUrl}/alerting/grafana/${encodeURIComponent(ruleUid)}/view`
      : `${this.baseUrl}/alerting/list?search=${encodeURIComponent(name)}`;
  }
}

/**
 * Explore, opened on the query that produced a row. The pane schema has
 * changed between Grafana versions, so the query is also put in the row's
 * tooltip — if this link lands on an empty Explore, it can still be pasted.
 * A free function rather than a method: building it needs no credentials.
 */
export function exploreUrl(
  baseUrl: string,
  datasourceUid: string,
  query: string,
  window: string,
  kind: DatasourceKind = 'prometheus'
): string {
  const panes = {
    devhub: {
      datasource: datasourceUid,
      queries: [{ refId: 'A', expr: query, datasource: { type: kind, uid: datasourceUid } }],
      range: { from: `now-${window}`, to: 'now' }
    }
  };
  return `${baseUrl}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}
