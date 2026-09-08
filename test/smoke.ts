import { adfToMarkdown } from '../src/providers/jira/adf';
import { diagnoseJiraFailure } from '../src/providers/jira/diagnose';
import { extractFigmaRefs, parseFigmaUrl } from '../src/providers/figma/urlParser';
import { applyMappings, resolveFrame } from '../src/providers/sentry/pathMapper';
import { normaliseOrgSlug } from '../src/providers/sentry/orgSlug';
import type { JiraIssue } from '../src/providers/jira/JiraClient';
import {
  applyStatusFilter,
  compareKeys,
  priorityRank,
  priorityTier,
  sortTasks,
  statusFacets,
  taskRowLabel
} from '../src/providers/jira/taskSort';
import { findInProgressTransition } from '../src/providers/jira/transitions';
import {
  repoWorkFingerprint,
  sortRepoWork,
  ticketKeysOf,
  withTickets,
  type RepoWork
} from '../src/context/repoWork';
import { DEFAULT_PROMPT_TEMPLATE, renderPrompt } from '../src/providers/jira/promptTemplate';
import {
  DEFAULT_REVIEW_PROMPT_TEMPLATE,
  renderReviewPrompt
} from '../src/providers/github/reviewPrompt';
import { dedupeRepos, parseGitHubRemote } from '../src/providers/github/remoteUrl';
import { graphqlEndpoint, hostFor } from '../src/providers/github/endpoints';
import { buildPullSearch, withinScope } from '../src/providers/github/searchQuery';
import {
  checkRunStatus,
  checksFromRollup,
  describePull,
  formatAge,
  mergeableFromApi,
  primaryFlag,
  pullFlags,
  reviewDecisionFrom,
  reviewDecisionFromApi,
  rollUpChecks,
  sortPulls,
  summaryFromApi,
  type PullSummary
} from '../src/providers/github/pullStatus';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`); failures++; }
}

console.log('adf');
check('heading + bullets', adfToMarkdown({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Redirect preserves query string' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'No loop on expired session' }] }] }
    ] }
  ]
}), '## Acceptance criteria\n\n- Redirect preserves query string\n- No loop on expired session');

check('marks', adfToMarkdown({ type: 'doc', content: [{ type: 'paragraph', content: [
  { type: 'text', text: 'call ' },
  { type: 'text', text: 'getSession', marks: [{ type: 'code' }] },
  { type: 'text', text: ' first', marks: [{ type: 'strong' }] }
] }] }), 'call `getSession` **first**');

check('link mark', adfToMarkdown({ type: 'doc', content: [{ type: 'paragraph', content: [
  { type: 'text', text: 'design', marks: [{ type: 'link', attrs: { href: 'https://figma.com/design/abc' } }] }
] }] }), '[design](https://figma.com/design/abc)');

check('unknown node recurses', adfToMarkdown({ type: 'doc', content: [
  { type: 'someFutureNode', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'still readable' }] }] }
] }), 'still readable');

console.log('figma urls');
check('node id dash to colon', parseFigmaUrl('https://www.figma.com/design/AbC123/Checkout?node-id=42-1337&t=x')?.nodeId, '42:1337');
check('file key', parseFigmaUrl('https://figma.com/file/XyZ9/Old-File?node-id=1-2')?.fileKey, 'XyZ9');
check('no node id', parseFigmaUrl('https://figma.com/design/AbC123/Checkout')?.nodeId, undefined);
check('non-figma url', parseFigmaUrl('https://example.com/design/abc'), undefined);
check('dedupes refs', extractFigmaRefs(
  'see https://figma.com/design/K1/Flow?node-id=1-2 and https://figma.com/design/K1/Flow?node-id=1-2 and https://figma.com/design/K1/Flow?node-id=3-4'
).length, 2);

console.log('sentry paths');
check('app prefix', applyMappings('app:///src/auth/login.ts', []), 'src/auth/login.ts');
check('webpack prefix', applyMappings('webpack://myapp/./src/a.ts', [{ from: 'webpack://myapp/', to: '' }]), 'src/a.ts');
check('resolves relative', resolveFrame('app:///src/auth/login.ts', { repoRoot: '/repo', mappings: [] }), '/repo/src/auth/login.ts');
check('rejects outside repo', resolveFrame('/other/place/x.ts', { repoRoot: '/repo', mappings: [] }), undefined);
check('ambiguous suffix dropped', resolveFrame('login.ts', {
  repoRoot: '/repo', mappings: [], knownFiles: ['/repo/a/login.ts', '/repo/b/login.ts']
}), undefined);
check('unambiguous suffix kept', resolveFrame('auth/login.ts', {
  repoRoot: '/repo', mappings: [], knownFiles: ['/repo/src/auth/login.ts', '/repo/b/other.ts']
}), '/repo/src/auth/login.ts');

console.log('jira diagnosis');
const target = { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.com' };
const health = (err: unknown) => diagnoseJiraFailure(err, target).health;
const says = (err: unknown, needle: string) =>
  diagnoseJiraFailure(err, target).message.includes(needle);

check('401 is an auth failure', health({ name: 'HttpError', status: 401 }), 'auth-expired');
check('401 names the email setting', says({ name: 'HttpError', status: 401 }, 'me@acme.com'), true);
check('403 is an auth failure', health({ name: 'HttpError', status: 403 }), 'auth-expired');
check('403 mentions scopes', says({ name: 'HttpError', status: 403 }, 'scopes'), true);
check('403 with denial header calls out the CAPTCHA',
  diagnoseJiraFailure({ name: 'HttpError', status: 403, deniedReason: 'CAPTCHA_CHALLENGE' }, target).summary,
  'CAPTCHA required (403)');
check('404 mentions the base URL setting', says({ name: 'HttpError', status: 404 }, 'devhub.jira.baseUrl'), true);
check('404 mentions Server/Data Center', says({ name: 'HttpError', status: 404 }, 'Data Center'), true);
check('429 is rate limiting', health({ name: 'HttpError', status: 429 }), 'rate-limited');
check('500 is not blamed on auth', health({ name: 'HttpError', status: 503 }), 'error');
check('timeout reports the wait',
  says({ name: 'TimeoutError', ms: 15000 }, 'within 15s'), true);
check('non-JSON blames the URL',
  says({ name: 'NonJsonResponseError', contentType: 'text/html' }, 'SSO or login page'), true);
check('unknown error still says something',
  diagnoseJiraFailure(new Error('socket hang up'), target).summary, 'Request failed');

console.log('task sort');
const task = (
  key: string,
  status: string,
  priority: string | undefined,
  updated: string,
  statusCategory = 'new'
): JiraIssue => ({
  key,
  summary: key,
  description: '',
  status,
  statusCategory,
  issueType: 'Task',
  priority,
  updated,
  url: `https://acme.atlassian.net/browse/${key}`,
  subtasks: [],
  comments: [],
  links: []
});

const SITE_ORDER = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];

check('site order beats the fallback', priorityRank('High', ['Low', 'High']), 1);
check('fallback ranks the default scheme', priorityRank('Highest') < priorityRank('Low'), true);
check('fallback ranks the severity scheme', priorityRank('Blocker') < priorityRank('Trivial'), true);
check('priority names are case insensitive', priorityRank('hiGH', SITE_ORDER), 1);
check('a name the site omits still ranks', priorityRank('Blocker', SITE_ORDER) < Number.MAX_SAFE_INTEGER, true);
check('no priority ranks last', priorityRank(undefined, SITE_ORDER), Number.MAX_SAFE_INTEGER);
check('blank priority ranks last', priorityRank('  ', SITE_ORDER), Number.MAX_SAFE_INTEGER);

check('tiers spread across the scheme', SITE_ORDER.map((p) => priorityTier(p, SITE_ORDER)),
  ['high', 'high', 'medium', 'low', 'low']);
check('unknown priority has no tier', priorityTier(undefined, SITE_ORDER), 'none');

const backlog = [
  task('P-3', 'To Do', 'Low', '2026-09-05T10:00:00.000Z'),
  task('P-1', 'In Progress', 'Highest', '2026-09-01T10:00:00.000Z'),
  task('P-2', 'To Do', undefined, '2026-09-06T10:00:00.000Z'),
  task('P-10', 'To Do', 'Low', '2026-09-07T10:00:00.000Z')
];

check('priority desc puts the urgent one first',
  sortTasks(backlog, 'priority-desc', SITE_ORDER).map((i) => i.key), ['P-1', 'P-10', 'P-3', 'P-2']);
check('priority asc reverses the ranked ones only',
  sortTasks(backlog, 'priority-asc', SITE_ORDER).map((i) => i.key), ['P-10', 'P-3', 'P-1', 'P-2']);
check('equal priority falls back to recency',
  sortTasks(backlog, 'priority-desc', SITE_ORDER).slice(1, 3).map((i) => i.key), ['P-10', 'P-3']);
check('updated desc ignores priority',
  sortTasks(backlog, 'updated-desc', SITE_ORDER).map((i) => i.key), ['P-10', 'P-2', 'P-3', 'P-1']);
check('key sort is natural', sortTasks(backlog, 'key').map((i) => i.key),
  ['P-1', 'P-2', 'P-3', 'P-10']);
check('sort does not mutate', backlog.map((i) => i.key), ['P-3', 'P-1', 'P-2', 'P-10']);
check('natural key order across projects', compareKeys('AAA-1', 'ZZZ-1') < 0, true);
check('unparseable updated sorts last',
  sortTasks([task('P-1', 'To Do', 'Low', 'not a date'), task('P-2', 'To Do', 'Low', '2026-09-01T10:00:00.000Z')],
    'updated-desc').map((i) => i.key), ['P-2', 'P-1']);

console.log('task filter');
check('empty filter shows everything', applyStatusFilter(backlog, []).length, 4);
check('filter matches on status name',
  applyStatusFilter(backlog, ['To Do']).map((i) => i.key), ['P-3', 'P-2', 'P-10']);
check('filter is case insensitive', applyStatusFilter(backlog, ['to do']).length, 3);
check('filter that matches nothing is empty, not everything',
  applyStatusFilter(backlog, ['Blocked']).length, 0);

const mixed = [
  task('P-1', 'Done', 'Low', '2026-09-01T10:00:00.000Z', 'done'),
  task('P-2', 'To Do', 'Low', '2026-09-01T10:00:00.000Z', 'new'),
  task('P-3', 'In Review', 'Low', '2026-09-01T10:00:00.000Z', 'indeterminate'),
  task('P-4', 'To Do', 'Low', '2026-09-01T10:00:00.000Z', 'new')
];
check('facets are in workflow order', statusFacets(mixed).map((f) => f.name),
  ['To Do', 'In Review', 'Done']);
check('facets count duplicates', statusFacets(mixed).find((f) => f.name === 'To Do')?.count, 2);
check('facets of nothing', statusFacets([]).length, 0);

console.log('sentry org slug');
check('bare slug is left alone', normaliseOrgSlug('acme-eu'), 'acme-eu');
check('org subdomain', normaliseOrgSlug('https://acme-eu.sentry.io/'), 'acme-eu');
check('org subdomain without scheme', normaliseOrgSlug('acme-eu.sentry.io'), 'acme-eu');
check('organizations path', normaliseOrgSlug('https://sentry.io/organizations/acme-eu/issues/'), 'acme-eu');
check('regional host with path', normaliseOrgSlug('https://us.sentry.io/organizations/acme/'), 'acme');
check('path wins over host', normaliseOrgSlug('https://acme.sentry.io/organizations/other/'), 'other');
check('self-hosted path', normaliseOrgSlug('https://sentry.example.com/organizations/acme/projects/'), 'acme');
check('settings url', normaliseOrgSlug('https://acme.sentry.io/settings/acme/projects/'), 'acme');
check('whitespace and trailing slashes', normaliseOrgSlug('  acme-eu//  '), 'acme-eu');
check('empty stays empty', normaliseOrgSlug(''), '');
check('whitespace only stays empty', normaliseOrgSlug('   '), '');
check('a region host is not a slug', normaliseOrgSlug('https://de.sentry.io/'), 'de.sentry.io');
check('unparseable is passed through', normaliseOrgSlug('not a url'), 'not a url');

console.log('github remotes');
check('https remote', parseGitHubRemote('https://github.com/acme/acme-web.git'), { owner: 'acme', name: 'acme-web' });
check('https without .git', parseGitHubRemote('https://github.com/acme/acme-web'), { owner: 'acme', name: 'acme-web' });
check('ssh remote', parseGitHubRemote('git@github.com:acme/mobile.git'), { owner: 'acme', name: 'mobile' });
check('trailing slash', parseGitHubRemote('https://github.com/acme/platform/'), { owner: 'acme', name: 'platform' });
check('a gitlab remote is not GitHub', parseGitHubRemote('git@gitlab.com:acme/thing.git'), undefined);
check('enterprise host when configured', parseGitHubRemote('git@ghe.corp:team/app.git', ['ghe.corp']), { owner: 'team', name: 'app' });
check('enterprise host is not github.com', parseGitHubRemote('git@ghe.corp:team/app.git'), undefined);
check('no remote', parseGitHubRemote(undefined), undefined);

// A worktree is a second Git repository pointing at the same GitHub repo.
check('worktrees collapse to one repo', dedupeRepos([
  { owner: 'acme', name: 'acme-web' },
  { owner: 'acme', name: 'acme-web' },
  { owner: 'acme', name: 'mobile' }
]), [{ owner: 'acme', name: 'acme-web' }, { owner: 'acme', name: 'mobile' }]);
check('dedupe is case insensitive', dedupeRepos([
  { owner: 'acme', name: 'Acme-Web' },
  { owner: 'Acme', name: 'acme-web' }
]).length, 1);

console.log('github endpoints');
check('github.com graphql', graphqlEndpoint('https://api.github.com'), 'https://api.github.com/graphql');
check('enterprise graphql', graphqlEndpoint('https://ghe.corp/api/v3'), 'https://ghe.corp/api/graphql');
check('trailing slash', graphqlEndpoint('https://api.github.com/'), 'https://api.github.com/graphql');
check('api host maps to github.com', hostFor('https://api.github.com'), 'github.com');
check('enterprise host', hostFor('https://ghe.corp/api/v3'), 'ghe.corp');

console.log('github pull search');
const twoRepos = [
  { owner: 'acme', name: 'acme-web' },
  { owner: 'acme', name: 'mobile' }
];
check('repos go into the query', buildPullSearch('is:pr is:open author:@me', twoRepos).query,
  'is:pr is:open author:@me repo:acme/acme-web repo:acme/mobile');
check('and into the allow list', [...buildPullSearch('is:pr', twoRepos).allow],
  ['acme/acme-web', 'acme/mobile']);
check('a query that fits is not filtered client side', buildPullSearch('is:pr', twoRepos).filteredClientSide, false);
// Past the 256-character limit GitHub rejects, the scope moves to the response.
const manyRepos = Array.from({ length: 30 }, (_, i) => ({ owner: 'acme', name: `service-${i}` }));
check('too many repos drops the qualifiers', buildPullSearch('is:pr is:open author:@me', manyRepos).query, 'is:pr is:open author:@me');
check('and says so', buildPullSearch('is:pr', manyRepos).filteredClientSide, true);
check('but still allows all of them', buildPullSearch('is:pr', manyRepos).allow.size, 30);
check('no repos means no query scope', buildPullSearch('is:pr', []).query, 'is:pr');
check('and nothing is in scope', withinScope([{ repo: 'acme/x' }], buildPullSearch('is:pr', []).allow), []);
check('out-of-scope results are dropped', withinScope(
  [{ repo: 'acme/mobile' }, { repo: 'someone/side-project' }],
  new Set(['acme/mobile'])
), [{ repo: 'acme/mobile' }]);
check('scope check ignores case', withinScope([{ repo: 'Acme/Mobile' }], new Set(['acme/mobile'])), [{ repo: 'Acme/Mobile' }]);

console.log('github graphql node translation');
// Shaped exactly as the live API returns it.
check('a real node maps across', summaryFromApi({
  number: 103,
  title: 'fix: stop masking malformed validation output',
  url: 'https://github.com/acme/mobile/pull/103',
  isDraft: false,
  createdAt: '2026-09-01T10:16:35Z',
  updatedAt: '2026-09-01T11:45:06Z',
  additions: 20,
  deletions: 9,
  mergeable: 'MERGEABLE',
  reviewDecision: 'APPROVED',
  author: { login: 'ana' },
  repository: { nameWithOwner: 'acme/mobile' },
  viewerLatestReview: null,
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }
}), {
  number: 103,
  title: 'fix: stop masking malformed validation output',
  url: 'https://github.com/acme/mobile/pull/103',
  repo: 'acme/mobile',
  author: 'ana',
  isDraft: false,
  createdAt: '2026-09-01T10:16:35Z',
  updatedAt: '2026-09-01T11:45:06Z',
  mergeable: 'mergeable',
  reviewDecision: 'approved',
  checks: 'success',
  unresolvedThreads: 0,
  additions: 20,
  deletions: 9,
  viewerReviewed: false
});

// A repo with no CI, no reviewers and no threads reports all three as absent
// rather than throwing — every one of these nulls occurs in practice.
const bare = summaryFromApi({
  number: 1, title: 'wip', url: 'u', isDraft: true,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  additions: 0, deletions: 0,
  mergeable: 'UNKNOWN', reviewDecision: null,
  author: null, repository: null, viewerLatestReview: null,
  reviewThreads: null, commits: null
});
check('null review decision', bare.reviewDecision, 'none');
check('null check rollup', bare.checks, 'none');
check('null author', bare.author, 'unknown');
check('null repository', bare.repo, '');
check('null review threads', bare.unresolvedThreads, 0);
check('unknown mergeability survives', bare.mergeable, 'unknown');
check('a viewer review is noticed', summaryFromApi({
  ...({ number: 1, title: 't', url: 'u', isDraft: false, createdAt: 'x', updatedAt: 'x', additions: 0, deletions: 0 }),
  viewerLatestReview: { state: 'COMMENTED' }
}).viewerReviewed, true);
check('unresolved threads are counted, resolved ones ignored', summaryFromApi({
  number: 1, title: 't', url: 'u', isDraft: false, createdAt: 'x', updatedAt: 'x', additions: 0, deletions: 0,
  reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }, null] }
}).unresolvedThreads, 2);

console.log('github pull status');
function pull(overrides: Partial<PullSummary> = {}): PullSummary {
  return {
    number: 1, title: 'Fix login', url: 'https://github.com/acme/x/pull/1',
    repo: 'acme/x', author: 'ana', isDraft: false,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
    mergeable: 'mergeable', reviewDecision: 'none', checks: 'success',
    unresolvedThreads: 0, additions: 10, deletions: 2, viewerReviewed: false,
    ...overrides
  };
}
check('a clean PR has no flags', pullFlags(pull()), []);
check('and still gets an icon', primaryFlag(pull()).icon, 'git-pull-request');
check('and reads as open', describePull(pull()), 'Open');
check('conflict', describePull(pull({ mergeable: 'conflicting' })), 'Conflicts');
check('changes requested', describePull(pull({ reviewDecision: 'changes_requested' })), 'Changes requested');
check('failing checks', describePull(pull({ checks: 'failure' })), 'Checks failing');
check('unresolved threads are counted', describePull(pull({ unresolvedThreads: 3 })), '3 unresolved');
check('approved', describePull(pull({ reviewDecision: 'approved' })), 'Approved');
check('awaiting review', describePull(pull({ reviewDecision: 'review_required' })), 'Awaiting review');
check('draft', describePull(pull({ isDraft: true })), 'Draft');
// Conflicts outrank everything: an approved PR that will not merge still needs a rebase first.
check('conflict outranks approval', primaryFlag(pull({ mergeable: 'conflicting', reviewDecision: 'approved' })).id, 'conflict');
check('changes requested outranks failing checks', primaryFlag(pull({ reviewDecision: 'changes_requested', checks: 'failure' })).id, 'changes-requested');
check('every applicable flag is listed', describePull(pull({ mergeable: 'conflicting', reviewDecision: 'changes_requested', checks: 'failure', unresolvedThreads: 2, isDraft: true })),
  'Conflicts · Changes requested · Checks failing · 2 unresolved · Draft');
check('a draft is not awaiting review', pullFlags(pull({ isDraft: true, reviewDecision: 'review_required' })).map((f) => f.id), ['draft']);

console.log('github pull sorting');
const a = pull({ number: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' });
const b = pull({ number: 2, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' });
check('recently updated first', sortPulls([b, a], 'updated-desc').map((p) => p.number), [1, 2]);
check('stalest first', sortPulls([a, b], 'updated-asc').map((p) => p.number), [2, 1]);
check('newest first', sortPulls([a, b], 'created-desc').map((p) => p.number), [2, 1]);
check('oldest first', sortPulls([b, a], 'created-asc').map((p) => p.number), [1, 2]);
check('sorting does not mutate', (() => { const input = [b, a]; sortPulls(input, 'created-asc'); return input.map((p) => p.number); })(), [2, 1]);
// Equal timestamps must not shuffle between refreshes.
const tie1 = pull({ number: 9, repo: 'acme/a', updatedAt: '2026-09-01T00:00:00Z' });
const tie2 = pull({ number: 4, repo: 'acme/b', updatedAt: '2026-09-01T00:00:00Z' });
check('ties break on repo then number', sortPulls([tie2, tie1], 'updated-desc').map((p) => p.repo), ['acme/a', 'acme/b']);

const now = Date.parse('2026-09-08T12:00:00Z');
check('age in minutes', formatAge('2026-09-08T11:30:00Z', now), '30m');
check('age in hours', formatAge('2026-09-08T04:00:00Z', now), '8h');
check('age in days', formatAge('2026-09-04T12:00:00Z', now), '4d');
check('just now', formatAge('2026-09-08T11:59:40Z', now), 'just now');
check('unparseable date', formatAge('not a date', now), undefined);

console.log('github api translation');
check('mergeable', mergeableFromApi('MERGEABLE'), 'mergeable');
check('conflicting', mergeableFromApi('CONFLICTING'), 'conflicting');
// GitHub computes mergeability lazily and says UNKNOWN until it has.
check('unknown mergeability', mergeableFromApi('UNKNOWN'), 'unknown');
check('missing mergeability', mergeableFromApi(null), 'unknown');
check('review decision', reviewDecisionFromApi('CHANGES_REQUESTED'), 'changes_requested');
check('no review decision', reviewDecisionFromApi(null), 'none');
check('check rollup success', checksFromRollup('SUCCESS'), 'success');
check('check rollup error counts as failure', checksFromRollup('ERROR'), 'failure');
check('check rollup expected counts as pending', checksFromRollup('EXPECTED'), 'pending');
check('no checks', checksFromRollup(undefined), 'none');

// Only a reviewer's latest review counts, and a bare comment is not a verdict.
check('latest review per user wins', reviewDecisionFrom([
  { state: 'CHANGES_REQUESTED', submitted_at: '2026-09-01T00:00:00Z', user: { login: 'ana' } },
  { state: 'APPROVED', submitted_at: '2026-09-02T00:00:00Z', user: { login: 'ana' } }
]), 'approved');
check('one rejection blocks', reviewDecisionFrom([
  { state: 'APPROVED', submitted_at: '2026-09-01T00:00:00Z', user: { login: 'ana' } },
  { state: 'CHANGES_REQUESTED', submitted_at: '2026-09-02T00:00:00Z', user: { login: 'bo' } }
]), 'changes_requested');
check('a comment is not a verdict', reviewDecisionFrom([
  { state: 'COMMENTED', submitted_at: '2026-09-01T00:00:00Z', user: { login: 'ana' } }
]), 'none');
check('no reviews', reviewDecisionFrom([]), 'none');
check('a dismissed review still counts as reviewed', reviewDecisionFrom([
  { state: 'DISMISSED', submitted_at: '2026-09-01T00:00:00Z', user: { login: 'ana' } }
]), 'review_required');

check('a running check is pending', checkRunStatus({ status: 'in_progress' }), 'pending');
check('a timed-out check is a failure', checkRunStatus({ status: 'completed', conclusion: 'timed_out' }), 'failure');
check('a skipped check is neutral', checkRunStatus({ status: 'completed', conclusion: 'skipped' }), 'neutral');
check('one failure fails the set', rollUpChecks(['success', 'failure', 'pending']), 'failure');
check('pending beats success', rollUpChecks(['success', 'pending']), 'pending');
check('all green', rollUpChecks(['success', 'neutral']), 'success');
check('no checks at all', rollUpChecks([]), 'none');

console.log('jira in-progress transition');
const workflow = [
  { id: '11', name: 'Start progress', to: 'In Progress' },
  { id: '21', name: 'Ready for review', to: 'In Review' },
  { id: '31', name: 'Done', to: 'Done' }
];
check('matches a conventional name', findInProgressTransition(workflow)?.id, '11');
// The configured value may name the transition or the status it lands on.
check('configured by transition name', findInProgressTransition(workflow, 'Ready for review')?.id, '21');
check('configured by target status', findInProgressTransition(workflow, 'In Review')?.id, '21');
check('configured match ignores case and padding', findInProgressTransition(workflow, '  in review  ')?.id, '21');
// An explicit setting must not silently fall back to guessing.
check('configured but absent matches nothing', findInProgressTransition(workflow, 'Nonexistent'), undefined);
check('doing is conventional too', findInProgressTransition([{ id: '5', name: 'Doing', to: 'Doing' }])?.id, '5');
check('no conventional name', findInProgressTransition([{ id: '9', name: 'Triage', to: 'Triage' }]), undefined);
check('no transitions', findInProgressTransition([]), undefined);

console.log('task prompt template');
const ticket = {
  key: 'ACME-2393',
  summary: 'Dashboard check-in height',
  issueType: 'Bug',
  status: 'In Progress',
  url: 'https://acme.atlassian.net/browse/ACME-2393'
};
check('url', renderPrompt('ticket ${url}', ticket), 'ticket https://acme.atlassian.net/browse/ACME-2393');
check('every placeholder', renderPrompt('${key}|${summary}|${type}|${status}', ticket),
  'ACME-2393|Dashboard check-in height|Bug|In Progress');
check('repeated placeholder', renderPrompt('${key} then ${key}', ticket), 'ACME-2393 then ACME-2393');
// A typo should be visible in the pasted text, not silently blanked.
check('unknown placeholder is left alone', renderPrompt('${nope} ${key}', ticket), '${nope} ACME-2393');
check('template without placeholders', renderPrompt('no placeholders here', ticket), 'no placeholders here');
check('empty template', renderPrompt('', ticket), '');

// The built-in default must actually substitute, and must not leak a placeholder.
const rendered = renderPrompt(DEFAULT_PROMPT_TEMPLATE, ticket);
check('default template substitutes the url', rendered.includes(ticket.url), true);
check('default template leaves no placeholders', /\$\{\w+\}/.test(rendered), false);
check('default template keeps its two stages', rendered.includes('Stage 1') && rendered.includes('Stage 2'), true);

console.log('review prompt template');
const reviewed = {
  url: 'https://github.com/acme/mobile/pull/103',
  repo: 'acme/mobile',
  number: 103,
  title: 'ACME-2393 fix login redirect',
  author: 'ana'
};
check('url', renderReviewPrompt('Review ${url}', reviewed), 'Review https://github.com/acme/mobile/pull/103');
check('every placeholder', renderReviewPrompt('${repo}#${number} ${title} by ${author}', reviewed),
  'acme/mobile#103 ACME-2393 fix login redirect by ana');
check('ticket key comes from the caller', renderReviewPrompt('${key}', reviewed, 'ACME-2393'), 'ACME-2393');
// A known-but-absent key renders empty; only a genuine typo is left as written.
check('no ticket key renders empty', renderReviewPrompt('[${key}]', reviewed), '[]');
check('unknown placeholder is left alone', renderReviewPrompt('${nope} ${repo}', reviewed), '${nope} acme/mobile');

const review = renderReviewPrompt(DEFAULT_REVIEW_PROMPT_TEMPLATE, reviewed);
check('default template substitutes the url', review.includes(reviewed.url), true);
check('default template leaves no placeholders', /\$\{\w+\}/.test(review), false);
check('default template asks for a single combined review', review.includes('single, concise review'), true);
check('default template forbids naming the tools in the review', review.includes('Do not mention'), true);

console.log('per-repository work');
function work(over: Partial<RepoWork> = {}): RepoWork {
  return { root: '/w/web', name: 'web', branch: 'main', pinned: false, active: false, ...over };
}
const web = work({ root: '/w/web', name: 'web', branch: 'ACME-1-x', ticketKey: 'ACME-1' });
const api = work({ root: '/w/api', name: 'api', branch: 'ACME-2-y', ticketKey: 'ACME-2', active: true });
const infra = work({ root: '/w/infra', name: 'infra', branch: 'develop' });

// Active first, then alphabetical — the order must not shift as data arrives.
check('active repo leads', sortRepoWork([web, infra, api]).map((w) => w.name), ['api', 'infra', 'web']);
check('alphabetical without an active repo', sortRepoWork([web, infra]).map((w) => w.name), ['infra', 'web']);
check('sorting does not mutate', (() => { const input = [web, api]; sortRepoWork(input); return input.map((w) => w.name); })(), ['web', 'api']);

check('only repos with a ticket', withTickets([web, api, infra]).map((w) => w.name), ['web', 'api']);
check('no tickets anywhere', withTickets([infra]), []);

check('distinct keys in list order', ticketKeysOf([web, api, infra]), ['ACME-1', 'ACME-2']);
// A frontend and a backend on the same ticket must cost one fetch, not two.
check('shared ticket is fetched once', ticketKeysOf([web, work({ name: 'api', root: '/w/api', ticketKey: 'ACME-1' })]), ['ACME-1']);
check('no keys', ticketKeysOf([infra]), []);

check('fingerprint is stable', repoWorkFingerprint([web, api]) === repoWorkFingerprint([web, api]), true);
check('fingerprint notices a branch change', repoWorkFingerprint([web]) === repoWorkFingerprint([work({ ...web, branch: 'other' })]), false);
check('fingerprint notices a new ticket', repoWorkFingerprint([infra]) === repoWorkFingerprint([work({ ...infra, ticketKey: 'ACME-9' })]), false);
check('fingerprint notices the active repo moving', repoWorkFingerprint([web]) === repoWorkFingerprint([work({ ...web, active: true })]), false);

console.log('task row label');
check('key, status, then summary', taskRowLabel({ key: 'ACME-2393', status: 'In Review', summary: 'Dashboard check-in height' }),
  'ACME-2393 · In Review · Dashboard check-in height');
// The status must survive truncation, so it goes before the long field.
check('status precedes a long summary', taskRowLabel({ key: 'ACME-1', status: 'In Progress', summary: 'x'.repeat(200) }).startsWith('ACME-1 · In Progress · '), true);
check('missing status is not a stray separator', taskRowLabel({ key: 'ACME-1', status: '', summary: 'Fix login' }), 'ACME-1 · Fix login');
check('whitespace status is dropped', taskRowLabel({ key: 'ACME-1', status: '   ', summary: 'Fix login' }), 'ACME-1 · Fix login');
check('status is trimmed', taskRowLabel({ key: 'ACME-1', status: '  In Review  ', summary: 'Fix login' }), 'ACME-1 · In Review · Fix login');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
