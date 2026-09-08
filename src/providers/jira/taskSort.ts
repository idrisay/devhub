import type { JiraIssue } from './JiraClient';

export type TaskSort = 'priority-desc' | 'priority-asc' | 'updated-desc' | 'key';

export const DEFAULT_TASK_SORT: TaskSort = 'priority-desc';

export const TASK_SORTS: { key: TaskSort; label: string; description: string; short: string }[] = [
  { key: 'priority-desc', label: 'Priority', description: 'Highest first', short: 'Priority \u2193' },
  { key: 'priority-asc', label: 'Priority', description: 'Lowest first', short: 'Priority \u2191' },
  { key: 'updated-desc', label: 'Recently updated', description: 'Newest first', short: 'Updated' },
  { key: 'key', label: 'Issue key', description: 'PROJ-2 before PROJ-10', short: 'Key' }
];

/** Terse form for the view header, where there is only room for a word. */
export function sortShortLabel(sort: TaskSort): string {
  return TASK_SORTS.find((s) => s.key === sort)?.short ?? sort;
}

export function isTaskSort(value: unknown): value is TaskSort {
  return TASK_SORTS.some((s) => s.key === value);
}

export function sortLabel(sort: TaskSort): string {
  const match = TASK_SORTS.find((s) => s.key === sort);
  return match ? `${match.label} · ${match.description}` : sort;
}

/**
 * Priority names are per-site configuration, so the real order comes from
 * `/rest/api/3/priority`. This list is the fallback for when that call fails,
 * and it interleaves the default scheme (Highest…Lowest) with the severity
 * scheme (Blocker…Trivial) so either one ranks correctly on its own.
 */
export const FALLBACK_PRIORITY_ORDER = [
  'Blocker',
  'Highest',
  'Critical',
  'High',
  'Major',
  'Medium',
  'Normal',
  'Low',
  'Minor',
  'Lowest',
  'Trivial'
];

/** Sorts after everything that could be ranked, in either direction. */
const UNRANKED = Number.MAX_SAFE_INTEGER;

function indexOfName(table: string[], name: string): number {
  const needle = name.trim().toLowerCase();
  return table.findIndex((entry) => entry.toLowerCase() === needle);
}

/**
 * Lower is more urgent. `order` is the site's own priority list, highest first;
 * pass an empty array to fall back to the well-known names.
 */
export function priorityRank(name: string | undefined, order: string[] = []): number {
  if (!name?.trim()) {
    return UNRANKED;
  }
  const table = order.length > 0 ? order : FALLBACK_PRIORITY_ORDER;
  const exact = indexOfName(table, name);
  if (exact >= 0) {
    return exact;
  }
  // A name the site list didn't mention. Guess from the conventional names
  // rather than lumping it in with "no priority set".
  if (table !== FALLBACK_PRIORITY_ORDER) {
    const guess = indexOfName(FALLBACK_PRIORITY_ORDER, name);
    if (guess >= 0) {
      return table.length + guess;
    }
  }
  return UNRANKED;
}

function updatedMillis(issue: JiraIssue): number {
  const parsed = Date.parse(issue.updated ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Natural key order, so PROJ-2 comes before PROJ-10. */
export function compareKeys(a: string, b: string): number {
  const split = (key: string): [string, number] => {
    const match = key.match(/^(.*?)-(\d+)$/);
    return match ? [match[1], Number(match[2])] : [key, 0];
  };
  const [projectA, numberA] = split(a);
  const [projectB, numberB] = split(b);
  return projectA === projectB ? numberA - numberB : projectA.localeCompare(projectB);
}

export function sortTasks(
  issues: readonly JiraIssue[],
  sort: TaskSort,
  priorityOrder: string[] = []
): JiraIssue[] {
  const byRecency = (a: JiraIssue, b: JiraIssue) => updatedMillis(b) - updatedMillis(a);
  const byKey = (a: JiraIssue, b: JiraIssue) => compareKeys(a.key, b.key);

  const comparators: Record<TaskSort, (a: JiraIssue, b: JiraIssue) => number> = {
    'priority-desc': (a, b) =>
      priorityRank(a.priority, priorityOrder) - priorityRank(b.priority, priorityOrder) ||
      byRecency(a, b) ||
      byKey(a, b),
    // Unranked issues stay at the bottom either way — "lowest first" is about
    // the priorities that exist, not about promoting the ones that are missing.
    'priority-asc': (a, b) => {
      const rankA = priorityRank(a.priority, priorityOrder);
      const rankB = priorityRank(b.priority, priorityOrder);
      if (rankA === UNRANKED || rankB === UNRANKED) {
        return rankA - rankB || byRecency(a, b) || byKey(a, b);
      }
      return rankB - rankA || byRecency(a, b) || byKey(a, b);
    },
    'updated-desc': (a, b) => byRecency(a, b) || byKey(a, b),
    key: (a, b) => byKey(a, b)
  };

  return [...issues].sort(comparators[sort]);
}

/** An empty selection means "no filter", not "match nothing". */
export function applyStatusFilter(issues: readonly JiraIssue[], statuses: readonly string[]): JiraIssue[] {
  if (statuses.length === 0) {
    return [...issues];
  }
  const wanted = new Set(statuses.map((s) => s.toLowerCase()));
  return issues.filter((issue) => wanted.has(issue.status.toLowerCase()));
}

export interface StatusFacet {
  name: string;
  category: string;
  count: number;
}

const CATEGORY_RANK: Record<string, number> = {
  new: 0,
  indeterminate: 1,
  done: 2
};

/**
 * The statuses actually present in the fetched tasks, in workflow order. Built
 * from the data rather than from a settings list so the filter can never offer
 * a status that would match nothing.
 */
export function statusFacets(issues: readonly JiraIssue[]): StatusFacet[] {
  const facets = new Map<string, StatusFacet>();
  for (const issue of issues) {
    const existing = facets.get(issue.status.toLowerCase());
    if (existing) {
      existing.count++;
    } else {
      facets.set(issue.status.toLowerCase(), {
        name: issue.status,
        category: issue.statusCategory,
        count: 1
      });
    }
  }
  return [...facets.values()].sort(
    (a, b) =>
      (CATEGORY_RANK[a.category] ?? 1) - (CATEGORY_RANK[b.category] ?? 1) ||
      a.name.localeCompare(b.name)
  );
}

export type PriorityTier = 'high' | 'medium' | 'low' | 'none';

/**
 * Buckets a priority into three tiers by where it sits in the scheme, rather
 * than by name. A site with three priorities and a site with eight both end up
 * with a sensible spread, which is what the row icons need.
 */
export function priorityTier(name: string | undefined, order: string[] = []): PriorityTier {
  const table = order.length > 0 ? order : FALLBACK_PRIORITY_ORDER;
  const rank = priorityRank(name, order);
  if (rank >= table.length) {
    return 'none';
  }
  if (table.length < 3) {
    return rank === 0 ? 'high' : 'low';
  }
  const position = rank / (table.length - 1);
  if (position <= 1 / 3) {
    return 'high';
  }
  return position >= 2 / 3 ? 'low' : 'medium';
}
