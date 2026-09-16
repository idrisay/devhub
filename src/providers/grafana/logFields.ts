/** How a log line is structured, which decides the LogQL parser stage. */
export type LogFormat = 'json' | 'logfmt' | 'unknown';

const LOGFMT_PAIR = /(\w[\w.-]*)=("(?:[^"\\]|\\.)*"|\S+)/g;

/**
 * Whichever format most of the sample parses as. Decided on a majority rather
 * than the first line, because one stray line — a startup banner, a stack
 * trace — should not pick the parser for the whole stream.
 */
export function detectFormat(lines: string[]): LogFormat {
  let json = 0;
  let logfmt = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          json++;
          continue;
        }
      } catch {
        // Not JSON after all.
      }
    }
    if ([...trimmed.matchAll(LOGFMT_PAIR)].length >= 2) {
      logfmt++;
    }
  }
  if (json === 0 && logfmt === 0) {
    return 'unknown';
  }
  return json >= logfmt ? 'json' : 'logfmt';
}

function flatten(value: unknown, prefix: string, into: Map<string, string[]>): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      // LogQL's json parser flattens nested objects with an underscore.
      flatten(child, prefix ? `${prefix}_${key}` : key, into);
    }
    return;
  }
  if (typeof value === 'object') {
    return;
  }
  const samples = into.get(prefix) ?? [];
  samples.push(String(value));
  into.set(prefix, samples);
}

/** Field names in the sample, with the values seen for each. */
export function fieldsFrom(lines: string[], format: LogFormat): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (format === 'json') {
      try {
        flatten(JSON.parse(trimmed), '', fields);
      } catch {
        // Skip a line that doesn't parse; the rest of the sample still counts.
      }
    } else if (format === 'logfmt') {
      for (const [, key, raw] of trimmed.matchAll(LOGFMT_PAIR)) {
        const value = raw.startsWith('"') ? raw.slice(1, -1) : raw;
        const samples = fields.get(key) ?? [];
        samples.push(value);
        fields.set(key, samples);
      }
    }
  }
  return fields;
}

/** Whether every sample of a field parses as a number. */
export function isNumeric(values: string[]): boolean {
  return (
    values.length > 0 &&
    values.every((value) => value !== '' && Number.isFinite(Number(value)))
  );
}

const DURATION_NAMES = [
  'duration',
  'duration_ms',
  'duration_seconds',
  'response_time',
  'responsetime',
  'request_time',
  'latency',
  'elapsed',
  'took',
  'time_taken',
  'rt',
  'upstream_response_time'
];

const ROUTE_NAMES = [
  'route',
  'path',
  'uri',
  'request_uri',
  'endpoint',
  'url',
  'request_path',
  'handler',
  'operation'
];

function rankBy(names: string[], preferred: string[]): string[] {
  const index = (name: string): number => {
    const lower = name.toLowerCase();
    const exact = preferred.indexOf(lower);
    if (exact !== -1) {
      return exact;
    }
    // A field that merely contains a known word still beats an unknown one.
    return preferred.some((p) => lower.includes(p)) ? preferred.length : preferred.length + 1;
  };
  return [...names].sort((a, b) => index(a) - index(b) || a.localeCompare(b));
}

/** Numeric fields, most duration-like first. */
export function rankDurationFields(fields: Map<string, string[]>): string[] {
  const numeric = [...fields.entries()]
    .filter(([, values]) => isNumeric(values))
    .map(([name]) => name);
  return rankBy(numeric, DURATION_NAMES);
}

/** Fields that could name an endpoint, most route-like first. */
export function rankRouteFields(fields: Map<string, string[]>): string[] {
  const textual = [...fields.entries()]
    .filter(([, values]) => !isNumeric(values))
    .map(([name]) => name);
  return rankBy(textual, ROUTE_NAMES);
}

export type DurationUnit = 'seconds' | 'milliseconds';

/**
 * Guesses the unit from the size of the numbers. A typical web request is
 * hundreds of milliseconds, so a median under 30 is far more likely to be
 * seconds than a stream of 5ms responses — and the setup flow offers the guess
 * as a default rather than applying it silently.
 */
export function guessUnit(values: string[]): DurationUnit {
  const numbers = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (numbers.length === 0) {
    return 'seconds';
  }
  const median = numbers[Math.floor(numbers.length / 2)];
  return median >= 30 ? 'milliseconds' : 'seconds';
}

export interface LokiQuerySpec {
  /** The stream selector, e.g. `{job="acme/web"}`. */
  selector: string;
  format: LogFormat;
  durationField: string;
  routeField: string;
  unit: DurationUnit;
}

/**
 * A p95-per-route query over logs. The stream selector is baked in rather than
 * templated: for logs the stream *is* the service, so there is no separate
 * label selector to substitute.
 */
export function buildLokiLatencyQuery(spec: LokiQuerySpec): string {
  const parser = spec.format === 'logfmt' ? '| logfmt' : '| json';
  const inner =
    `quantile_over_time(0.95, ${spec.selector} ${parser} ` +
    `| unwrap ${spec.durationField} [\${window}]) by (${spec.routeField})`;
  const scaled = spec.unit === 'milliseconds' ? `(${inner}) / 1000` : inner;
  return `topk(\${limit}, ${scaled})`;
}
