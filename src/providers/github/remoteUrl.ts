/** A GitHub repository, as `owner` and `name`. */
export interface RepoRef {
  owner: string;
  name: string;
}

export function repoSlug(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pulls `owner/name` out of a git remote URL — the https and ssh forms, with or
 * without the `.git` suffix.
 *
 * `hosts` exists for GitHub Enterprise, whose remotes carry the company domain.
 * It is deliberately a whitelist rather than "any host": matching every domain
 * would read a GitLab or Bitbucket remote as a GitHub repository and then query
 * the wrong API for it.
 */
export function parseGitHubRemote(
  url: string | undefined,
  hosts: readonly string[] = ['github.com']
): RepoRef | undefined {
  if (!url) {
    return undefined;
  }
  for (const host of hosts) {
    const pattern = new RegExp(`${escapeForRegExp(host)}[/:]([^/]+)/([^/]+?)(?:\\.git)?/?$`, 'i');
    const match = url.match(pattern);
    if (match) {
      return { owner: match[1], name: match[2] };
    }
  }
  return undefined;
}

/**
 * One entry per repository, first occurrence winning.
 *
 * Worktrees are the reason this is not optional: a repository and its
 * `*.worktrees/*` siblings are separate entries in the Git extension's
 * repository list but the same GitHub repo, and querying it once per worktree
 * would return the same pull requests several times over.
 */
export function dedupeRepos(repos: readonly RepoRef[]): RepoRef[] {
  const seen = new Map<string, RepoRef>();
  for (const repo of repos) {
    const key = repoSlug(repo).toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, repo);
    }
  }
  return [...seen.values()];
}
