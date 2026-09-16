/** A single `label=value` matcher, parsed out of a configured selector. */
export interface Matcher {
  label: string;
  value: string;
}

export interface ServiceScope {
  matchers: Matcher[];
  /** Where the matchers came from, so an empty list can explain itself. */
  source: 'configured' | 'repo-name' | 'none';
}

const QUOTED = /^(["'])(.*)\1$/;

/**
 * Parses `service=web, env="prod"` into matchers.
 *
 * Only equality is supported. A negative or regex matcher (`!=`, `=~`) is
 * dropped rather than coerced into an equality it doesn't mean — silently
 * turning "not web" into "web" would scope the sidebar to exactly the alerts
 * the user excluded.
 */
export function parseSelector(raw: string): Matcher[] {
  const matchers: Matcher[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const label = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(QUOTED, '$2');
    if (!label || !value || /[!~]$/.test(label) || value.startsWith('~')) {
      continue;
    }
    matchers.push({ label, value });
  }
  return matchers;
}

/** Renders matchers back into the selector body of a PromQL series selector. */
export function toPromSelector(matchers: Matcher[]): string {
  return matchers
    .map((m) => `${m.label}="${m.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');
}

/** The spellings of a repository name that might show up as a label value. */
export function repoAliases(repoName: string): string[] {
  const lower = repoName.toLowerCase();
  return [...new Set([lower, lower.replace(/_/g, '-'), lower.replace(/-/g, '_')])];
}

/**
 * What counts as "your" service for this repository. An explicit mapping wins;
 * otherwise the repository name is assumed to be the value of the first
 * fallback label, which is right often enough to be worth not configuring.
 */
export function scopeForRepo(
  repoName: string | undefined,
  services: Record<string, string>,
  fallbackLabels: string[]
): ServiceScope {
  if (repoName) {
    const key = repoName in services ? repoName : repoName.toLowerCase();
    const configured = services[key];
    if (configured !== undefined && !configured.trim()) {
      // An explicit empty selector is how a repository says "don't scope me".
      // Falling back to the name guess here would put the scope straight back.
      return { matchers: [], source: 'configured' };
    }
    if (configured?.trim()) {
      const matchers = parseSelector(configured);
      if (matchers.length > 0) {
        return { matchers, source: 'configured' };
      }
    }
    if (fallbackLabels.length > 0) {
      return { matchers: [{ label: fallbackLabels[0], value: repoName }], source: 'repo-name' };
    }
  }
  return { matchers: [], source: 'none' };
}

/**
 * A configured scope matches on every matcher, because that is what the user
 * wrote. A guessed one matches loosely — any of the fallback labels carrying a
 * spelling of the repository name — since guessing narrowly just hides alerts.
 */
export function alertMatchesScope(
  labels: Record<string, string>,
  scope: ServiceScope,
  fallbackLabels: string[],
  repoName: string | undefined
): boolean {
  if (scope.source === 'configured') {
    return scope.matchers.every((m) => labels[m.label] === m.value);
  }
  if (!repoName) {
    return false;
  }
  const aliases = new Set(repoAliases(repoName));
  return fallbackLabels.some((label) => {
    const value = labels[label];
    return value !== undefined && aliases.has(value.toLowerCase());
  });
}

/**
 * Whether an alert names the ticket you're on, in any label or annotation.
 * These are always shown regardless of service scope: someone wiring a ticket
 * key into an alert has said, explicitly, that it belongs to that work.
 */
export function mentionsTicket(
  alert: { labels: Record<string, string>; annotations: Record<string, string> },
  ticketKey: string | undefined
): boolean {
  if (!ticketKey) {
    return false;
  }
  const needle = ticketKey.toLowerCase();
  return [...Object.values(alert.labels), ...Object.values(alert.annotations)].some((value) =>
    value.toLowerCase().includes(needle)
  );
}
