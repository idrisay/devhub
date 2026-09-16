/**
 * The default "slowest APIs" query: p95 per route over the window, top N.
 *
 * Metric and label names differ from stack to stack, so this is a starting
 * point rather than a promise — `devhub.grafana.latency.query` overrides it,
 * and the Monitoring view shows the query it ran so a mismatch is visible
 * rather than mysterious.
 */
export const DEFAULT_LATENCY_QUERY =
  'topk(${limit}, histogram_quantile(0.95, sum by (le, route) ' +
  '(rate(http_server_request_duration_seconds_bucket{${selector}}[${window}]))))';

export interface LatencyVars {
  selector: string;
  window: string;
  limit: number;
  service: string;
}

const PLACEHOLDER = /\$\{(\w+)\}/g;

/**
 * Fills `${selector}`, `${window}`, `${limit}` and `${service}` into the
 * template. An unrecognised placeholder is left as written, so a typo shows up
 * in the query Grafana rejects rather than silently emptying part of it.
 */
export function renderLatencyQuery(template: string, vars: LatencyVars): string {
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = (vars as unknown as Record<string, unknown>)[name];
    return value === undefined ? match : String(value);
  });
}

/** Label names that name an endpoint, most specific first. */
const ENDPOINT_LABELS = [
  'route',
  'path',
  'endpoint',
  'handler',
  'operation',
  'uri',
  'url',
  'target',
  'job'
];

/**
 * The row label for one series. Which label holds the endpoint depends on the
 * query the user wrote, so prefer the well-known names and fall back to
 * whatever the series is actually keyed by — an unhelpful label beats a row
 * that reads "unknown".
 */
export function endpointLabel(metric: Record<string, string>): string {
  for (const name of ENDPOINT_LABELS) {
    if (metric[name]) {
      return metric[name];
    }
  }
  const rest = Object.entries(metric).filter(([key]) => key !== '__name__');
  if (rest.length === 0) {
    return metric.__name__ ?? 'unlabelled series';
  }
  return rest.map(([key, value]) => `${key}=${value}`).join(' · ');
}

/**
 * Seconds as something readable at a glance. Sub-millisecond values round to
 * `0 ms` rather than to a spread of meaningless decimals.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return 'no data';
  }
  if (seconds >= 1) {
    return `${seconds.toFixed(2)} s`;
  }
  return `${Math.round(seconds * 1000)} ms`;
}

/** Labels that are never the endpoint. */
const NOT_ENDPOINT = new Set([
  '__name__',
  'le',
  'instance',
  'pod',
  'container',
  'namespace',
  'cluster',
  'node',
  'service',
  'app',
  'env',
  'environment',
  'version',
  'status',
  'status_code',
  'code',
  'method'
]);

/**
 * Orders candidate metrics so the one the user wants is first. Names that say
 * what they measure win; among equals the shortest wins, because the long ones
 * are usually a more specific variant of the short one.
 */
export function rankMetrics(names: string[]): string[] {
  const score = (name: string): number => {
    const lower = name.toLowerCase();
    let points = 0;
    if (/(^|_)http(_|$)/.test(lower)) points -= 4;
    if (lower.includes('request')) points -= 3;
    if (lower.includes('duration') || lower.includes('latency')) points -= 3;
    if (lower.includes('seconds')) points -= 1;
    if (lower.includes('server')) points -= 1;
    if (lower.startsWith('go_') || lower.startsWith('process_') || lower.startsWith('grafana')) {
      points += 5;
    }
    return points;
  };
  return [...names].sort((a, b) => score(a) - score(b) || a.length - b.length || a.localeCompare(b));
}

/** Orders candidate group-by labels, dropping the ones that can't be an endpoint. */
export function rankGroupLabels(names: string[]): string[] {
  return names
    .filter((name) => !NOT_ENDPOINT.has(name) && !name.startsWith('__'))
    .sort((a, b) => {
      const ai = ENDPOINT_LABELS.indexOf(a);
      const bi = ENDPOINT_LABELS.indexOf(b);
      return (
        (ai === -1 ? ENDPOINT_LABELS.length : ai) - (bi === -1 ? ENDPOINT_LABELS.length : bi) ||
        a.localeCompare(b)
      );
    });
}

/**
 * How a metric can answer "how slow is this endpoint".
 *
 * `histogram` gives a real p95. `average` is the consolation prize for stacks
 * that export a `_sum`/`_count` pair with no buckets: a mean hides the tail
 * that makes latency interesting, but it beats an empty panel and it is what
 * the data can actually support.
 */
export type LatencyKind = 'histogram' | 'average';

export interface LatencyCandidate {
  /** The metric to query: the `_bucket` series, or the `_sum`/`_count` base. */
  metric: string;
  kind: LatencyKind;
}

/**
 * Sorts metric names into what can be turned into a latency figure.
 * A `_sum` only counts when its `_count` exists, since the ratio needs both.
 */
export function latencyCandidates(names: string[]): LatencyCandidate[] {
  const present = new Set(names);
  const candidates: LatencyCandidate[] = names
    .filter((name) => name.endsWith('_bucket'))
    .map((metric) => ({ metric, kind: 'histogram' as const }));

  for (const name of names) {
    if (!name.endsWith('_sum')) {
      continue;
    }
    const base = name.slice(0, -'_sum'.length);
    // A histogram exports _bucket, _sum and _count; offering its _sum as an
    // average as well would list the same metric twice, worse the second time.
    if (present.has(`${base}_count`) && !present.has(`${base}_bucket`)) {
      candidates.push({ metric: base, kind: 'average' });
    }
  }
  return candidates;
}

/** The query template for a discovered metric and group-by label. */
export function buildLatencyQuery(
  metric: string,
  groupBy: string,
  kind: LatencyKind = 'histogram'
): string {
  if (kind === 'average') {
    return (
      `topk(\${limit}, sum by (${groupBy}) (rate(${metric}_sum{\${selector}}[\${window}])) ` +
      `/ sum by (${groupBy}) (rate(${metric}_count{\${selector}}[\${window}])))`
    );
  }
  return (
    `topk(\${limit}, histogram_quantile(0.95, sum by (le, ${groupBy}) ` +
    `(rate(${metric}{\${selector}}[\${window}]))))`
  );
}
