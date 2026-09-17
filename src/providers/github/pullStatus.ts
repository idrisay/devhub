/**
 * Everything about how a pull request's state is derived and presented, kept
 * free of both `vscode` and the network so it can be unit tested.
 */

export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'none';
export type CheckRollup = 'success' | 'failure' | 'pending' | 'neutral' | 'none';

/** A pull request as it appears in the "mine" and "awaiting my review" lists. */
export interface PullSummary {
  number: number;
  title: string;
  url: string;
  /** `owner/name`. */
  repo: string;
  author: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergeable: Mergeable;
  reviewDecision: ReviewDecision;
  checks: CheckRollup;
  unresolvedThreads: number;
  additions: number;
  deletions: number;
  /** True when the viewer has already submitted a review on this PR. */
  viewerReviewed: boolean;
}

export type PullFlagId =
  | 'conflict'
  | 'changes-requested'
  | 'checks-failing'
  | 'unresolved'
  | 'approved'
  | 'checks-pending'
  | 'awaiting-review'
  | 'draft';

export interface PullFlag {
  id: PullFlagId;
  label: string;
  icon: string;
  color?: string;
}

/**
 * Just the fields the flags are derived from. Everything that reasons about a
 * pull request's state takes this rather than a whole `PullSummary`, so the
 * prompt renderers can ask for the state of a pull request without pretending
 * to hold one.
 */
export type PullState = Pick<
  PullSummary,
  'mergeable' | 'reviewDecision' | 'checks' | 'unresolvedThreads' | 'isDraft'
>;

/**
 * The flags that stop a pull request merging, as opposed to the ones that
 * merely describe where it has got to. A row may drop "3 unresolved" or "Draft"
 * when it runs out of space; it may never drop one of these, because they are
 * the reason you would go and look at the pull request at all.
 */
const BLOCKING: ReadonlySet<PullFlagId> = new Set<PullFlagId>([
  'conflict',
  'changes-requested',
  'checks-failing'
]);

function isBlocking(flag: PullFlag): boolean {
  return BLOCKING.has(flag.id);
}

/** Whether the pull request needs work before it can merge. */
export function isBlocked(pull: PullState): boolean {
  return pullFlags(pull).some(isBlocking);
}

/**
 * The states a pull request is in, most actionable first.
 *
 * Order is the whole point: a PR is usually in several of these at once, and
 * the first one decides the row's icon. Conflicts lead because they block
 * every other outcome — an approved PR that won't merge still needs a rebase
 * before anything else can happen to it.
 */
export function pullFlags(pull: PullState): PullFlag[] {
  const flags: PullFlag[] = [];

  if (pull.mergeable === 'conflicting') {
    flags.push({ id: 'conflict', label: 'Conflicts', icon: 'git-merge', color: 'charts.red' });
  }
  if (pull.reviewDecision === 'changes_requested') {
    flags.push({
      id: 'changes-requested',
      label: 'Changes requested',
      icon: 'request-changes',
      color: 'charts.orange'
    });
  }
  if (pull.checks === 'failure') {
    flags.push({ id: 'checks-failing', label: 'Checks failing', icon: 'error', color: 'charts.red' });
  }
  if (pull.unresolvedThreads > 0) {
    flags.push({
      id: 'unresolved',
      label: `${pull.unresolvedThreads} unresolved`,
      icon: 'comment-unresolved',
      color: 'charts.orange'
    });
  }
  if (pull.reviewDecision === 'approved') {
    flags.push({ id: 'approved', label: 'Approved', icon: 'check', color: 'charts.green' });
  }
  if (pull.checks === 'pending') {
    flags.push({ id: 'checks-pending', label: 'Checks running', icon: 'sync~spin' });
  }
  // A draft isn't waiting on anyone, so "awaiting review" would be a lie.
  if (pull.reviewDecision === 'review_required' && !pull.isDraft) {
    flags.push({ id: 'awaiting-review', label: 'Awaiting review', icon: 'eye', color: 'charts.blue' });
  }
  if (pull.isDraft) {
    flags.push({
      id: 'draft',
      label: 'Draft',
      icon: 'git-pull-request-draft',
      color: 'descriptionForeground'
    });
  }

  return flags;
}

const PLAIN_OPEN: PullFlag = {
  id: 'awaiting-review',
  label: 'Open',
  icon: 'git-pull-request',
  color: 'charts.green'
};

/** The flag that drives the row icon. Never undefined, so callers stay simple. */
export function primaryFlag(pull: PullState): PullFlag {
  return pullFlags(pull)[0] ?? PLAIN_OPEN;
}

/**
 * The pull request's state as words.
 *
 * `max` caps how many flags are named, for the row description — five of them
 * at once is more than the row can show, and they are pushed in order of what
 * you would want to know first.
 *
 * The cap is a budget for the *informational* flags only. A blocking one —
 * conflicts, changes requested, failing checks — is never dropped to stay
 * under it, because a row that says "Conflicts · Changes requested" while
 * quietly omitting that the tests are also failing is worse than a row that
 * runs long: it reads as a complete account and isn't one.
 *
 * What survives is chosen first and then read back off `pullFlags` in its
 * order, rather than being concatenated blocking-first. Today those two are
 * the same list, because the blocking flags are also the first three pushed —
 * but that is a coincidence of the current order, and a fourth blocking flag
 * added further down would otherwise jump the queue silently.
 */
export function describePull(pull: PullState, max = Number.POSITIVE_INFINITY): string {
  const flags = pullFlags(pull);
  const blocking = flags.filter(isBlocking);
  const budget = Math.max(max - blocking.length, blocking.length > 0 ? 0 : 1);
  const keep = new Set([...blocking, ...flags.filter((f) => !isBlocking(f)).slice(0, budget)]);
  const kept = flags.filter((flag) => keep.has(flag));
  return kept.length > 0 ? kept.map((f) => f.label).join(' · ') : 'Open';
}

/**
 * Row form of an age: "14m ago". "just now" is already a phrase and stays as
 * one.
 */
export function ageLabel(iso: string, now?: number): string | undefined {
  const age = formatAge(iso, now);
  return age === undefined || age === 'just now' ? age : `${age} ago`;
}

/**
 * Compact age, for showing how long a review request has been sitting there.
 * Anything under a minute reads as "just now" rather than "0m".
 */
export function formatAge(iso: string, now: number = Date.now()): string | undefined {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return undefined;
  }
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return days < 365 ? `${days}d` : `${Math.floor(days / 365)}y`;
}

export type PullSort = 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc';

export const DEFAULT_PULL_SORT: PullSort = 'updated-desc';

export const PULL_SORTS: {
  key: PullSort;
  label: string;
  description: string;
  short: string;
}[] = [
  {
    key: 'updated-desc',
    label: 'Recently updated',
    description: 'Newest activity first',
    short: 'Updated'
  },
  {
    key: 'updated-asc',
    label: 'Least recently updated',
    description: 'Stalest first',
    short: 'Stalest'
  },
  { key: 'created-desc', label: 'Newest', description: 'Most recently opened first', short: 'Newest' },
  { key: 'created-asc', label: 'Oldest', description: 'Open the longest first', short: 'Oldest' }
];

export function isPullSort(value: unknown): value is PullSort {
  return PULL_SORTS.some((s) => s.key === value);
}

export function pullSortLabel(sort: PullSort): string {
  const match = PULL_SORTS.find((s) => s.key === sort);
  return match ? `${match.label} · ${match.description}` : sort;
}

/** Terse form for the view header, where there is only room for a word. */
export function pullSortShortLabel(sort: PullSort): string {
  return PULL_SORTS.find((s) => s.key === sort)?.short ?? sort;
}

function millis(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortPulls(pulls: readonly PullSummary[], sort: PullSort): PullSummary[] {
  // Repo then number as the tie-break, so equal timestamps produce a stable
  // order instead of shuffling between refreshes.
  const stable = (a: PullSummary, b: PullSummary) =>
    a.repo.localeCompare(b.repo) || a.number - b.number;

  const comparators: Record<PullSort, (a: PullSummary, b: PullSummary) => number> = {
    'updated-desc': (a, b) => millis(b.updatedAt) - millis(a.updatedAt) || stable(a, b),
    'updated-asc': (a, b) => millis(a.updatedAt) - millis(b.updatedAt) || stable(a, b),
    'created-desc': (a, b) => millis(b.createdAt) - millis(a.createdAt) || stable(a, b),
    'created-asc': (a, b) => millis(a.createdAt) - millis(b.createdAt) || stable(a, b)
  };

  return [...pulls].sort(comparators[sort]);
}

// --- Wire-format translation -------------------------------------------------

export function mergeableFromApi(value: string | null | undefined): Mergeable {
  switch (value) {
    case 'MERGEABLE':
      return 'mergeable';
    case 'CONFLICTING':
      return 'conflicting';
    default:
      // Includes 'UNKNOWN': GitHub computes mergeability lazily and reports
      // UNKNOWN on the first ask while it works it out.
      return 'unknown';
  }
}

export function reviewDecisionFromApi(value: string | null | undefined): ReviewDecision {
  switch (value) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
    default:
      return 'none';
  }
}

/** GraphQL `statusCheckRollup.state`. */
export function checksFromRollup(value: string | null | undefined): CheckRollup {
  switch (value) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

/** One `PullRequest` node as the GraphQL query asks for it. */
export interface ApiPullNode {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  mergeable?: string | null;
  reviewDecision?: string | null;
  author?: { login?: string } | null;
  repository?: { nameWithOwner?: string } | null;
  viewerLatestReview?: { state?: string } | null;
  latestOpinionatedReviews?: {
    nodes?: ({ state?: string; author?: { login?: string } | null } | null)[] | null;
  } | null;
  reviewRequests?: {
    nodes?: ({ requestedReviewer?: { login?: string } | null } | null)[] | null;
  } | null;
  reviewThreads?: { nodes?: ({ isResolved?: boolean } | null)[] | null } | null;
  commits?: {
    nodes?: ({ commit?: { statusCheckRollup?: { state?: string } | null } } | null)[] | null;
  } | null;
}

export function summaryFromApi(node: ApiPullNode): PullSummary {
  const threads = node.reviewThreads?.nodes ?? [];
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;

  return {
    number: node.number,
    title: node.title,
    url: node.url,
    repo: node.repository?.nameWithOwner ?? '',
    author: node.author?.login ?? 'unknown',
    isDraft: Boolean(node.isDraft),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergeable: mergeableFromApi(node.mergeable),
    reviewDecision: decisionFromNode(node),
    checks: checksFromRollup(rollup),
    unresolvedThreads: threads.filter((t) => t && t.isResolved === false).length,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    viewerReviewed: Boolean(node.viewerLatestReview?.state)
  };
}

export interface ReviewLike {
  state: string;
  submitted_at: string;
  user?: { login?: string } | null;
}

/** GitHub logins differ only in case, so compare them folded. */
function sameLogin(login: string | null | undefined): string {
  return (login ?? '').toLowerCase();
}

/** The reviewers still being waited on, from either wire format. */
function pendingReviewersOf(node: ApiPullNode): string[] {
  return (node.reviewRequests?.nodes ?? [])
    .map((request) => request?.requestedReviewer?.login)
    .filter((login): login is string => Boolean(login));
}

/**
 * The verdicts that still stand, once the ones a re-request has superseded are
 * dropped.
 *
 * GitHub only lists a reviewer as requested while the request is outstanding —
 * it drops them the moment they submit — so a reviewer who has both a verdict
 * on record and a request outstanding has been asked again since, and their
 * old verdict is no longer what the pull request is waiting on.
 */
function standingVerdicts(
  verdicts: readonly { author: string; state: string }[],
  pendingReviewers: readonly string[]
): string[] {
  const pending = new Set(pendingReviewers.map(sameLogin));
  return verdicts.filter((v) => !pending.has(sameLogin(v.author))).map((v) => v.state);
}

/**
 * The pull request's decision, corrected for re-requested reviews.
 *
 * GitHub leaves `reviewDecision` at CHANGES_REQUESTED after the author
 * re-requests the reviewer who asked for the changes: it only clears when that
 * reviewer submits a new review, or the old one is dismissed outright. The ball
 * is back in the reviewer's court, though, so a row that still says "Changes
 * requested" is reporting work that has already been done.
 *
 * Only that one relaxation is applied. Every other decision is GitHub's own,
 * because it is the only side that knows the branch's protection rules — how
 * many approvals are required, and whose count.
 */
function decisionFromNode(node: ApiPullNode): ReviewDecision {
  const decision = reviewDecisionFromApi(node.reviewDecision);
  if (decision !== 'changes_requested') {
    return decision;
  }
  const verdicts = (node.latestOpinionatedReviews?.nodes ?? [])
    .filter((review): review is { state?: string; author?: { login?: string } | null } =>
      Boolean(review)
    )
    .map((review) => ({ author: review.author?.login ?? '', state: review.state ?? '' }));
  if (verdicts.length === 0) {
    // Either the query didn't ask for them or GitHub didn't say; with nothing
    // to reason from, its own decision stands.
    return decision;
  }
  const standing = standingVerdicts(verdicts, pendingReviewersOf(node));
  return standing.includes('CHANGES_REQUESTED') ? 'changes_requested' : 'review_required';
}

/**
 * Collapses a review list into one decision, the way GitHub's own branch rules
 * do: only a reviewer's latest review counts, and a bare comment is not a
 * verdict. Used for the current-branch PR, which comes from REST and so has no
 * `reviewDecision` field of its own.
 *
 * `pendingReviewers` are the logins with a review request outstanding; a
 * verdict from one of them has been superseded by a fresh request and no longer
 * counts, the same correction `decisionFromNode` makes on the GraphQL side.
 */
export function reviewDecisionFrom(
  reviews: readonly ReviewLike[],
  pendingReviewers: readonly string[] = []
): ReviewDecision {
  const latestByUser = new Map<string, string>();
  for (const review of [...reviews].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))) {
    if (review.state !== 'COMMENTED') {
      latestByUser.set(sameLogin(review.user?.login), review.state);
    }
  }
  const standing = standingVerdicts(
    [...latestByUser].map(([author, state]) => ({ author, state })),
    pendingReviewers
  );
  if (standing.includes('CHANGES_REQUESTED')) {
    return 'changes_requested';
  }
  if (standing.includes('APPROVED')) {
    return 'approved';
  }
  if (standing.length > 0) {
    return 'review_required';
  }
  // Nothing stands: either someone has been asked and not answered yet, or
  // every verdict on record has been superseded by a fresh request. Both are
  // the pull request waiting on a reviewer.
  return latestByUser.size > 0 || pendingReviewers.length > 0 ? 'review_required' : 'none';
}

export interface CheckRunLike {
  status: string;
  conclusion?: string | null;
}

/** REST check-run status, for the current-branch PR's per-check rows. */
export function checkRunStatus(run: CheckRunLike): 'pending' | 'success' | 'failure' | 'neutral' {
  if (run.status !== 'completed') {
    return 'pending';
  }
  switch (run.conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
      return 'failure';
    default:
      return 'neutral';
  }
}

/** Worst-case roll-up of individual check runs: one failure fails the set. */
export function rollUpChecks(
  states: readonly ('pending' | 'success' | 'failure' | 'neutral')[]
): CheckRollup {
  if (states.length === 0) {
    return 'none';
  }
  if (states.includes('failure')) {
    return 'failure';
  }
  if (states.includes('pending')) {
    return 'pending';
  }
  return states.includes('success') ? 'success' : 'neutral';
}
