/**
 * What one repository in the workspace is currently working on.
 *
 * A multi-root workspace has no single answer to "what am I working on": the
 * frontend can sit on one ticket's branch while the backend sits on another.
 * Deriving the whole sidebar from whichever repository the focused editor
 * happens to be in makes the other branches invisible, so the context carries
 * one of these per repository.
 */
export interface RepoWork {
  /** Absolute path of the repository root. */
  root: string;
  /** Basename of the root, which is what the user recognises it by. */
  name: string;
  branch?: string;
  ticketKey?: string;
  /** True when a pin supplied the key rather than the branch or a commit. */
  pinned: boolean;
  /** The repository the active editor is in. */
  active: boolean;
}

/**
 * Active repository first, then alphabetically.
 *
 * Stable rather than clever: the list must not reorder itself as data arrives,
 * or rows move under the cursor mid-click.
 */
export function sortRepoWork(work: readonly RepoWork[]): RepoWork[] {
  return [...work].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)
  );
}

/** Only the repositories that have a ticket to show. */
export function withTickets(work: readonly RepoWork[]): RepoWork[] {
  return work.filter((entry) => Boolean(entry.ticketKey));
}

/**
 * The distinct ticket keys across the workspace, in list order.
 *
 * Distinct matters: two repositories on branches for the same ticket are the
 * normal case for a frontend/backend pair, and it should cost one fetch.
 */
export function ticketKeysOf(work: readonly RepoWork[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const entry of work) {
    if (entry.ticketKey && !seen.has(entry.ticketKey)) {
      seen.add(entry.ticketKey);
      keys.push(entry.ticketKey);
    }
  }
  return keys;
}

/** A fingerprint for change detection, so an identical recompute stays quiet. */
export function repoWorkFingerprint(work: readonly RepoWork[]): string {
  return work
    .map((e) => `${e.root}@${e.branch ?? ''}:${e.ticketKey ?? ''}:${e.pinned}:${e.active}`)
    .join('|');
}
