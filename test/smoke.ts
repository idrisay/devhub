import { adfToMarkdown } from '../src/providers/jira/adf';
import { diagnoseJiraFailure } from '../src/providers/jira/diagnose';
import { extractFigmaRefs, parseFigmaUrl } from '../src/providers/figma/urlParser';
import { applyMappings, resolveFrame } from '../src/providers/sentry/pathMapper';
import { normaliseOrgSlug } from '../src/providers/sentry/orgSlug';
import type { JiraIssue } from '../src/providers/jira/JiraClient';
import { clampTitle, rowLabel, rowMeta } from '../src/ui/rowText';
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
  describePromptSetting,
  isCustomised,
  placeholderHint,
  promptActions,
  PROMPT_SETTINGS,
  scopeFor
} from '../src/infra/promptSettings';
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
import {
  DEFAULT_UPDATE_PROMPT_TEMPLATE,
  renderUpdatePrompt
} from '../src/providers/github/updatePrompt';
import { dedupeRepos, parseGitHubRemote } from '../src/providers/github/remoteUrl';
import {
  answered,
  contextFingerprint,
  NO_PROVIDERS,
  planRefresh,
  providerFlags,
  sectionState,
  viewFingerprint,
  type RefreshWindow
} from '../src/providers/refreshPlan';
import type { WorkContext } from '../src/context/WorkContextService';
import { graphqlEndpoint, hostFor } from '../src/providers/github/endpoints';
import { buildPullSearch, withinScope } from '../src/providers/github/searchQuery';
import {
  ageLabel,
  checkRunStatus,
  checksFromRollup,
  describePull,
  formatAge,
  isBlocked,
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

import {
  alertMatchesScope,
  mentionsTicket,
  parseSelector,
  repoAliases,
  scopeForRepo,
  toPromSelector
} from '../src/providers/grafana/serviceScope';
import {
  buildLatencyQuery,
  DEFAULT_LATENCY_QUERY,
  endpointLabel,
  formatDuration,
  latencyCandidates,
  rankGroupLabels,
  rankMetrics,
  renderLatencyQuery
} from '../src/providers/grafana/latencyQuery';

import {
  buildLokiLatencyQuery,
  detectFormat,
  fieldsFrom,
  guessUnit,
  isNumeric,
  rankDurationFields,
  rankRouteFields
} from '../src/providers/grafana/logFields';

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

console.log('update prompt template');
const blocked = {
  url: 'https://github.com/evulpo/evulpo-frontend/pull/2725',
  repo: 'evulpo/evulpo-frontend',
  number: 2725,
  title: 'EV-118 sticky player chrome',
  mergeable: 'conflicting' as const,
  reviewDecision: 'changes_requested' as const,
  checks: 'failure' as const,
  unresolvedThreads: 2,
  isDraft: false
};
check('url', renderUpdatePrompt('Update ${url}', blocked),
  'Update https://github.com/evulpo/evulpo-frontend/pull/2725');
check('every placeholder', renderUpdatePrompt('${repo}#${number} ${title}', blocked),
  'evulpo/evulpo-frontend#2725 EV-118 sticky player chrome');
// The prompt says what the row said, so pasting it carries the state you were
// looking at when you clicked the button.
check('state is the row\'s own words', renderUpdatePrompt('${state}', blocked),
  'Conflicts · Changes requested · Checks failing · 2 unresolved');
check('a clean PR still reads', renderUpdatePrompt('${state}', { ...blocked, mergeable: 'mergeable', reviewDecision: 'none', checks: 'success', unresolvedThreads: 0 }),
  'nothing — check whether it is ready to merge');
check('ticket key comes from the caller', renderUpdatePrompt('${key}', blocked, 'EV-118'), 'EV-118');
check('no ticket key renders empty', renderUpdatePrompt('[${key}]', blocked), '[]');
check('unknown placeholder is left alone', renderUpdatePrompt('${nope} ${repo}', blocked),
  '${nope} evulpo/evulpo-frontend');

const update = renderUpdatePrompt(DEFAULT_UPDATE_PROMPT_TEMPLATE, blocked);
check('default template substitutes the url', update.includes(blocked.url), true);
check('default template leaves no placeholders', /\$\{\w+\}/.test(update), false);
check('default template names what is blocking it', update.includes('Conflicts · Changes requested'), true);
check('default template goes and reads the review threads', update.includes('--comments'), true);
check('default template checks the failing jobs', update.includes('gh pr checks'), true);
check('default template forbids naming the tools in the replies', update.includes('Do not mention'), true);

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
check('key, then summary', taskRowLabel({ key: 'ACME-2393', summary: 'Dashboard check-in height' }),
  'ACME-2393 · Dashboard check-in height');
// A row that takes the whole width leaves the description — the status and the
// age — nowhere to render, so the summary is what gives way.
check('a long summary is clamped to the budget',
  taskRowLabel({ key: 'ACME-1', summary: 'Align the learning path performance page with its Figma spec' }, 40),
  'ACME-1 · Align the learning path…');
check('the key always survives',
  taskRowLabel({ key: 'ACME-1', summary: 'x'.repeat(200) }, 40).startsWith('ACME-1 · '), true);
check('a key that eats the budget still leaves room for words',
  taskRowLabel({ key: 'VERYLONGPROJECT-12345678', summary: 'Fix the broken redirect' }, 26),
  'VERYLONGPROJECT-12345678 · Fix the broken…');
check('a short summary is left alone',
  taskRowLabel({ key: 'ACME-1', summary: 'Fix login' }, 40), 'ACME-1 · Fix login');
check('a budget of zero clamps nothing',
  taskRowLabel({ key: 'ACME-1', summary: 'x'.repeat(80) }, 0), `ACME-1 · ${'x'.repeat(80)}`);

console.log('\nrow text');

check('short titles are untouched', clampTitle('Fix login', 40), 'Fix login');
check('long ones break on a word', clampTitle('Align the learning path performance page', 24), 'Align the learning path…');
check('whitespace is collapsed first', clampTitle('Fix   the\n  login', 40), 'Fix the login');
// Breaking on the word would leave "A…" here, which says less than the cut.
check('one long word is cut mid-word', clampTitle('Supercalifragilisticexpialidocious', 12), 'Supercalifra…');
check('an exact fit is not clamped', clampTitle('123456', 6), '123456');
check('a leading part is kept whole',
  rowLabel({ lead: '#2712', title: 'Align the learning path performance page', separator: '  ', budget: 40 }),
  '#2712  Align the learning path…');
check('no lead is just the clamped title',
  rowLabel({ title: 'Align the learning path performance page', budget: 24 }),
  'Align the learning path…');
check('meta joins what it has', rowMeta('Approved', '14m ago', undefined, 'acme/app'),
  'Approved · 14m ago · acme/app');
check('meta drops blanks', rowMeta(undefined, '', '   ', 'Approved'), 'Approved');
check('nothing to say is undefined', rowMeta(undefined, false, ''), undefined);

console.log('\npull request row text');

check('an age reads as a phrase', ageLabel('2026-09-10T09:46:00Z', Date.parse('2026-09-10T10:00:00Z')), '14m ago');
check('under a minute stays "just now"', ageLabel('2026-09-10T09:59:40Z', Date.parse('2026-09-10T10:00:00Z')), 'just now');
check('an unparseable date has no age', ageLabel('not a date'), undefined);
check('a row spends its budget on two flags',
  describePull(pull({ mergeable: 'conflicting', checks: 'failure', unresolvedThreads: 3 }), 2),
  'Conflicts · Checks failing');
check('a tooltip names them all',
  describePull(pull({ mergeable: 'conflicting', checks: 'failure', unresolvedThreads: 3 })),
  'Conflicts · Checks failing · 3 unresolved');
// The budget is for the informational flags. Dropping "Checks failing" to stay
// under it would leave the row reading as a complete account of a pull request
// while omitting the reason its build is red.
check('a third blocker is not dropped to stay under the budget',
  describePull(pull({ mergeable: 'conflicting', reviewDecision: 'changes_requested', checks: 'failure' }), 2),
  'Conflicts · Changes requested · Checks failing');
check('and the informational flags still give way',
  describePull(pull({ mergeable: 'conflicting', reviewDecision: 'changes_requested', checks: 'failure', unresolvedThreads: 4, isDraft: true }), 2),
  'Conflicts · Changes requested · Checks failing');
check('an unblocked row is still capped',
  describePull(pull({ reviewDecision: 'approved', checks: 'pending', unresolvedThreads: 2 }), 2),
  '2 unresolved · Approved');
check('blocked when anything blocks it', isBlocked(pull({ checks: 'failure' })), true);
check('unresolved threads alone do not block', isBlocked(pull({ unresolvedThreads: 3 })), false);
check('an approved clean PR is not blocked', isBlocked(pull({ reviewDecision: 'approved' })), false);
check('nothing flagged reads as open', describePull(pull(), 2), 'Open');
check('one awaiting review says so', describePull(pull({ reviewDecision: 'review_required' }), 2), 'Awaiting review');

console.log('copy prompt settings');
check('one entry per copy button', PROMPT_SETTINGS.map((s) => s.setting),
  ['devhub.tasks.promptTemplate', 'devhub.github.reviewPromptTemplate',
   'devhub.github.updatePromptTemplate']);
// The key Config reads must be the setting id minus the section, or seeding
// would write somewhere the extension never looks.
check('keys match the setting ids', PROMPT_SETTINGS.every((s) => `devhub.${s.key}` === s.setting), true);
check('placeholders read as they are typed', placeholderHint(PROMPT_SETTINGS[0]),
  '${url} ${key} ${summary} ${type} ${status}');

check('empty is the built-in text', isCustomised(''), false);
check('unset is the built-in text', isCustomised(undefined), false);
// Config trims before deciding, so whitespace must not count here either.
check('whitespace is the built-in text', isCustomised('   \n  '), false);
check('text is an override', isCustomised('Review ${url}'), true);
check('describes an untouched setting', describePromptSetting(''), 'Built-in default');
check('describes an override', describePromptSetting('hello'), 'Customised');

check('nothing to reset when untouched', promptActions({ tasks: '', review: '', update: '' }).map((a) => a.action),
  ['edit', 'edit', 'edit']);
check('a reset appears once overridden', promptActions({ tasks: 'mine', review: '', update: '' }).map((a) => a.action),
  ['edit', 'edit', 'edit', 'reset']);
check('the reset targets the overridden prompt', promptActions({ tasks: '', review: 'mine', update: '' })[3].setting.id, 'review');
check('the update prompt resets too', promptActions({ tasks: '', review: '', update: 'mine' })[3].setting.id, 'update');
check('resets come after every edit', promptActions({ tasks: 'a', review: 'b', update: 'c' }).map((a) => a.action),
  ['edit', 'edit', 'edit', 'reset', 'reset', 'reset']);
check('the state is on the entry', promptActions({ tasks: 'mine', review: '', update: '' })[0].description, 'Customised');

check('an untouched setting goes to user settings', scopeFor(undefined), 'global');
check('no override goes to user settings', scopeFor({}), 'global');
// An override is edited where it lives, so seeding never promotes a
// workspace value into a user-wide one.
check('a workspace value stays in the workspace', scopeFor({ workspaceValue: 'mine' }), 'workspace');
check('a folder value stays in the folder', scopeFor({ workspaceFolderValue: 'mine' }), 'workspaceFolder');
check('the narrowest scope wins', scopeFor({ workspaceValue: 'a', workspaceFolderValue: 'b' }), 'workspaceFolder');
check('an empty override still counts as present', scopeFor({ workspaceValue: '' }), 'workspace');


console.log('grafana service scope');
check('parses a bare selector', parseSelector('service=web'), [{ label: 'service', value: 'web' }]);
check('parses quotes and spacing', parseSelector(' service = "web" , env=prod '),
  [{ label: 'service', value: 'web' }, { label: 'env', value: 'prod' }]);
// Coercing "not web" into "web" would scope the view to exactly the alerts
// the user excluded, so an unsupported matcher is dropped instead.
check('drops a negative matcher', parseSelector('service!=web'), []);
check('drops a regex matcher', parseSelector('service=~web.*'), []);
check('drops junk', parseSelector('=web,service,,'), []);
check('renders back to PromQL', toPromSelector([{ label: 'service', value: 'web' }, { label: 'env', value: 'prod' }]),
  'service="web",env="prod"');
check('escapes a quote in a value', toPromSelector([{ label: 'a', value: 'b"c' }]), 'a="b\\"c"');

check('a configured mapping wins', scopeForRepo('acme-web', { 'acme-web': 'service=web' }, ['service']),
  { matchers: [{ label: 'service', value: 'web' }], source: 'configured' });
check('an unmapped repo guesses from its name', scopeForRepo('acme-api', {}, ['service', 'app']),
  { matchers: [{ label: 'service', value: 'acme-api' }], source: 'repo-name' });
// A mapping that parses to nothing is a typo, not an instruction to match
// everything, so it falls through to the guess rather than scoping to none.
check('an unparseable mapping falls back', scopeForRepo('acme-api', { 'acme-api': 'service!=web' }, ['service']).source,
  'repo-name');
check('no repository means no scope', scopeForRepo(undefined, {}, ['service']),
  { matchers: [], source: 'none' });
check('name variants are tried', repoAliases('Acme_Web'), ['acme_web', 'acme-web']);

const configured = scopeForRepo('acme-web', { 'acme-web': 'service=web, env=prod' }, ['service']);
check('a configured scope needs every matcher',
  alertMatchesScope({ service: 'web', env: 'prod' }, configured, ['service'], 'acme-web'), true);
check('a configured scope rejects a partial match',
  alertMatchesScope({ service: 'web' }, configured, ['service'], 'acme-web'), false);

const guessed = scopeForRepo('acme-web', {}, ['service', 'app', 'job']);
check('a guessed scope matches any of the labels',
  alertMatchesScope({ job: 'acme-web' }, guessed, ['service', 'app', 'job'], 'acme-web'), true);
check('a guessed scope matches an underscore spelling',
  alertMatchesScope({ app: 'acme_web' }, guessed, ['service', 'app', 'job'], 'acme-web'), true);
check('a guessed scope rejects another service',
  alertMatchesScope({ app: 'acme-api' }, guessed, ['service', 'app', 'job'], 'acme-web'), false);

check('a ticket key in an annotation counts',
  mentionsTicket({ labels: {}, annotations: { summary: 'Regression from PROJ-1234' } }, 'PROJ-1234'), true);
check('the match ignores case',
  mentionsTicket({ labels: { runbook: 'proj-1234' }, annotations: {} }, 'PROJ-1234'), true);
check('no ticket means no match', mentionsTicket({ labels: {}, annotations: {} }, undefined), false);

console.log('grafana latency query');
check('the default query fills in', renderLatencyQuery(DEFAULT_LATENCY_QUERY,
  { selector: 'service="web"', window: '1h', limit: 5, service: 'web' }),
  'topk(5, histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_seconds_bucket{service="web"}[1h]))))');
check('an empty selector is still valid PromQL', renderLatencyQuery('m{${selector}}[${window}]',
  { selector: '', window: '5m', limit: 1, service: '' }), 'm{}[5m]');
// A typo should surface as a query Grafana rejects, not as a silently
// emptied one, so an unknown placeholder is left alone.
check('an unknown placeholder survives', renderLatencyQuery('${servcie}', { selector: '', window: '1h', limit: 5, service: 'web' }),
  '${servcie}');

check('a well-known label names the row', endpointLabel({ route: '/checkout', le: '0.5' }), '/checkout');
check('the most specific label wins', endpointLabel({ job: 'api', route: '/checkout' }), '/checkout');
check('an unknown shape falls back to the labels', endpointLabel({ __name__: 'x', code: '500' }), 'code=500');
check('nothing to go on still reads as something', endpointLabel({ __name__: 'x' }), 'x');

check('seconds keep two decimals', formatDuration(1.238), '1.24 s');
check('sub-second reads in ms', formatDuration(0.042), '42 ms');
check('a missing value says so', formatDuration(Number.NaN), 'no data');


// An explicit empty mapping is a repository saying "don't scope me", so it must
// not fall through to the guess that put the wrong scope there in the first place.
check('an empty mapping means no scoping', scopeForRepo('acme-web', { 'acme-web': '' }, ['service']),
  { matchers: [], source: 'configured' });
check('and then everything matches',
  alertMatchesScope({ service: 'anything' }, scopeForRepo('acme-web', { 'acme-web': '' }, ['service']), ['service'], 'acme-web'),
  true);

console.log('grafana latency setup');
check('request-duration metrics rank first', rankMetrics([
  'go_gc_duration_seconds_bucket',
  'db_query_seconds_bucket',
  'http_server_request_duration_seconds_bucket'
])[0], 'http_server_request_duration_seconds_bucket');
check('runtime noise ranks last', rankMetrics(['go_gc_duration_seconds_bucket', 'db_query_seconds_bucket']).pop(),
  'go_gc_duration_seconds_bucket');
check('the shorter of two equals wins', rankMetrics(['api_request_duration_bucket', 'request_duration_bucket'])[0],
  'request_duration_bucket');

check('endpoint labels rank first', rankGroupLabels(['pod', 'handler', 'route', 'le']), ['route', 'handler']);
// `le` and the service labels can never be the endpoint, and offering them
// produces a query that silently groups by the wrong thing.
check('le and service labels are dropped', rankGroupLabels(['le', 'service', 'namespace', '__name__']), []);
check('an unknown label is still offered', rankGroupLabels(['controller_action']), ['controller_action']);

check('a built query keeps its placeholders', buildLatencyQuery('m_bucket', 'path'),
  'topk(${limit}, histogram_quantile(0.95, sum by (le, path) (rate(m_bucket{${selector}}[${window}]))))');
check('and renders', renderLatencyQuery(buildLatencyQuery('m_bucket', 'path'),
  { selector: 'job="api"', window: '6h', limit: 3, service: 'api' }),
  'topk(3, histogram_quantile(0.95, sum by (le, path) (rate(m_bucket{job="api"}[6h]))))');


check('buckets are histogram candidates', latencyCandidates(['http_duration_seconds_bucket']),
  [{ metric: 'http_duration_seconds_bucket', kind: 'histogram' }]);
// A histogram already exports _sum and _count; offering those as an average
// too would list the same metric twice, worse the second time.
check('a histogram is not also offered as an average',
  latencyCandidates(['h_bucket', 'h_sum', 'h_count']), [{ metric: 'h_bucket', kind: 'histogram' }]);
check('a bare sum/count pair becomes an average',
  latencyCandidates(['req_seconds_sum', 'req_seconds_count']),
  [{ metric: 'req_seconds', kind: 'average' }]);
// The ratio needs both halves, so a lone _sum is not a candidate.
check('a sum without a count is not a candidate', latencyCandidates(['req_seconds_sum']), []);
check('an average query divides the rates', buildLatencyQuery('req_seconds', 'path', 'average'),
  'topk(${limit}, sum by (path) (rate(req_seconds_sum{${selector}}[${window}])) / sum by (path) (rate(req_seconds_count{${selector}}[${window}])))');


console.log('loki log fields');
const jsonLines = [
  '{"path":"/checkout","duration":0.412,"status":200}',
  '{"path":"/cart","duration":0.081,"status":200}'
];
const logfmtLines = [
  'path=/checkout duration=412 status=200',
  'path=/cart duration=81 status=200'
];
check('json is detected', detectFormat(jsonLines), 'json');
check('logfmt is detected', detectFormat(logfmtLines), 'logfmt');
check('prose is neither', detectFormat(['starting server on :8080', 'ready']), 'unknown');
// One stray line - a banner, a stack trace - should not pick the parser for
// the whole stream, so the format is a majority verdict.
check('a majority decides', detectFormat([...jsonLines, 'plain banner line']), 'json');

check('json fields are read', [...fieldsFrom(jsonLines, 'json').keys()], ['path', 'duration', 'status']);
// LogQL's json parser flattens nested objects with an underscore, so the field
// names offered have to match what the query will actually see.
check('nested json flattens the way LogQL does',
  [...fieldsFrom(['{"req":{"path":"/a"},"took":5}'], 'json').keys()], ['req_path', 'took']);
check('logfmt fields are read', [...fieldsFrom(logfmtLines, 'logfmt').keys()], ['path', 'duration', 'status']);
check('quoted logfmt values survive',
  fieldsFrom(['msg="hello world" took=3'], 'logfmt').get('msg'), ['hello world']);

check('numbers are numeric', isNumeric(['0.4', '12']), true);
check('a blank is not', isNumeric(['0.4', '']), false);
check('text is not', isNumeric(['/checkout']), false);

const fields = fieldsFrom(jsonLines, 'json');
check('duration fields are numeric only', rankDurationFields(fields), ['duration', 'status']);
check('route fields are textual only', rankRouteFields(fields), ['path']);
check('a known name outranks an unknown one',
  rankDurationFields(fieldsFrom(['{"elapsed":1,"zzz":2}'], 'json'))[0], 'elapsed');

check('small numbers read as seconds', guessUnit(['0.4', '0.08', '1.2']), 'seconds');
check('big ones read as milliseconds', guessUnit(['412', '81', '1200']), 'milliseconds');
check('nothing to go on defaults to seconds', guessUnit([]), 'seconds');

check('a loki query unwraps and groups', buildLokiLatencyQuery({
  selector: '{job="api"}', format: 'json', durationField: 'duration', routeField: 'path', unit: 'seconds'
}), 'topk(${limit}, quantile_over_time(0.95, {job="api"} | json | unwrap duration [${window}]) by (path))');
check('logfmt uses its own parser', buildLokiLatencyQuery({
  selector: '{job="api"}', format: 'logfmt', durationField: 'took', routeField: 'uri', unit: 'seconds'
}), 'topk(${limit}, quantile_over_time(0.95, {job="api"} | logfmt | unwrap took [${window}]) by (uri))');
// Rows are rendered as seconds, so a millisecond field has to be scaled or
// every endpoint reads as taking several minutes.
check('milliseconds are scaled to seconds', buildLokiLatencyQuery({
  selector: '{job="api"}', format: 'json', durationField: 'duration_ms', routeField: 'path', unit: 'milliseconds'
}), 'topk(${limit}, (quantile_over_time(0.95, {job="api"} | json | unwrap duration_ms [${window}]) by (path)) / 1000)');

console.log('\nrefresh planning');

function ctx(over: Partial<WorkContext> = {}): WorkContext {
  return {
    ticketKey: 'PROJ-1',
    branch: 'PROJ-1-thing',
    repoRoot: '/src/app',
    changedFiles: [],
    pinned: false,
    repos: [{ owner: 'acme', name: 'app' }],
    work: [{ root: '/src/app', name: 'app', branch: 'PROJ-1-thing', ticketKey: 'PROJ-1', pinned: false, active: true }],
    ...over
  };
}

// The whole point of the fingerprint: saving a file is not a reason to go and
// ask GitHub anything, but it is a reason to redraw the changed-file list.
check('a save leaves the fingerprint alone',
  contextFingerprint(ctx({ changedFiles: ['/src/app/a.ts'] })) === contextFingerprint(ctx()), true);
check('a save does change the view fingerprint',
  viewFingerprint(ctx({ changedFiles: ['/src/app/a.ts'] })) === viewFingerprint(ctx()), false);
check('a branch switch changes the fingerprint',
  contextFingerprint(ctx({ branch: 'PROJ-2-other', ticketKey: 'PROJ-2' })) === contextFingerprint(ctx()), false);
check('opening a second repo changes the fingerprint',
  contextFingerprint(ctx({ repos: [{ owner: 'acme', name: 'app' }, { owner: 'acme', name: 'api' }] })) ===
    contextFingerprint(ctx()), false);
check('repo order does not', contextFingerprint(ctx({ repos: [{ owner: 'acme', name: 'app' }] })) ===
  contextFingerprint(ctx()), true);

const window = (over: Partial<RefreshWindow> = {}): RefreshWindow => ({
  force: false,
  fingerprint: 'a',
  lastFingerprint: 'a',
  lastCompletedAt: 1_000,
  now: 1_000,
  minIntervalMs: 15_000,
  ...over
});

check('a repeat of the running context joins it',
  planRefresh(window({ inFlight: 'a' })), { run: 'join' });
// Cancelling and re-issuing is how a rate limit gets spent on data nobody sees.
check('a moved context supersedes the running one',
  planRefresh(window({ inFlight: 'b' })), { run: 'now' });
check('a moved context never waits',
  planRefresh(window({ fingerprint: 'b' })), { run: 'now' });
check('a repeat inside the interval waits out the remainder',
  planRefresh(window({ now: 5_000 })), { run: 'later', inMs: 11_000 });
check('a repeat after the interval runs',
  planRefresh(window({ now: 20_000 })), { run: 'now' });
check('the refresh command ignores the interval',
  planRefresh(window({ force: true, now: 1_001, inFlight: 'a' })), { run: 'now' });
check('the first ever refresh runs',
  planRefresh(window({ lastFingerprint: undefined, lastCompletedAt: undefined })), { run: 'now' });
check('a zero interval refreshes on every trigger',
  planRefresh(window({ minIntervalMs: 0, now: 1_000 })), { run: 'now' });

console.log('\nsection state');

check('rows win over everything', sectionState({ hasData: true, answered: false }), 'ready');
check('an answered empty section is empty', sectionState({ hasData: false, answered: true }), 'empty');
check('an unanswered empty section is still loading',
  sectionState({ hasData: false, answered: false }), 'first-load');

const loadedGitHub = { ...NO_PROVIDERS, github: true };
check('a provider that answered for this context has answered',
  answered({ loaded: loadedGitHub, contextLoaded: true }, 'github'), true);
// A branch switch: GitHub has answered before, but not about this branch.
check('a provider that answered for another context has not',
  answered({ loaded: loadedGitHub, contextLoaded: false }, 'github'), false);
check('a provider that never answered has not',
  answered({ loaded: NO_PROVIDERS, contextLoaded: true }, 'github'), false);
check('flags list only the providers given',
  providerFlags(new Set(['jira' as const])), { ...NO_PROVIDERS, jira: true });

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
