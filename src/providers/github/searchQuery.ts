import { repoSlug, type RepoRef } from './remoteUrl';

export interface PullSearch {
  /** The search string to send. */
  query: string;
  /**
   * `owner/name`, lowercased, of every repository the caller will accept.
   * Applied to the response regardless of what went into `query`.
   */
  allow: Set<string>;
  /** True when the repositories did not fit in `query` and only `allow` scopes the result. */
  filteredClientSide: boolean;
}

/**
 * GitHub rejects a search query over 256 characters, and `repo:` qualifiers are
 * what push it over: six repositories already cost about 170 of them. So the
 * scope is enforced twice — narrowed in the query when it fits, and always
 * checked against `allow` on the way back.
 *
 * That redundancy is deliberate. Correctness never depends on the query string,
 * which means adding a seventh repository degrades to a slightly larger
 * response rather than to a 422 or, worse, to someone else's pull requests
 * appearing in the list.
 */
export function buildPullSearch(
  base: string,
  repos: readonly RepoRef[],
  budget = 250
): PullSearch {
  const allow = new Set(repos.map((repo) => repoSlug(repo).toLowerCase()));
  const qualifiers = repos.map((repo) => `repo:${repoSlug(repo)}`);
  const full = [base, ...qualifiers].join(' ');

  if (repos.length > 0 && full.length <= budget) {
    return { query: full, allow, filteredClientSide: false };
  }
  return { query: base, allow, filteredClientSide: repos.length > 0 };
}

/** Drops anything outside the workspace's repositories. */
export function withinScope<T extends { repo: string }>(
  items: readonly T[],
  allow: ReadonlySet<string>
): T[] {
  if (allow.size === 0) {
    return [];
  }
  return items.filter((item) => allow.has(item.repo.toLowerCase()));
}
