/**
 * Behaviour tests: the real Hub and the real pull request view, driven under a
 * stubbed VS Code API (see `support/vscode.js`, injected by `support/run.js`).
 *
 * These exist because the bug they cover cannot be reached from a pure
 * function. The sidebar used to spend its time on "Loading…" and spend requests
 * on data nobody saw, and both came out of the wiring: which triggers earn a
 * fan-out, what a view renders while one is running, and whether a result that
 * changed nothing still rebuilds the tree.
 */
import * as vscode from 'vscode';
import type { WorkContext, WorkContextService } from '../src/context/WorkContextService';
import type { AuthManager } from '../src/infra/AuthManager';
import type { CacheStore } from '../src/infra/CacheStore';
import { Hub } from '../src/providers/Hub';
import type { PullQueues } from '../src/providers/github/GitHubClient';
import type { PullSummary } from '../src/providers/github/pullStatus';
import { PullRequestTree } from '../src/ui/PullRequestTree';
import { TaskTree } from '../src/ui/TaskTree';
import type { JiraIssue } from '../src/providers/jira/JiraClient';

const settings = (vscode as unknown as { settings: Record<string, unknown> }).settings;

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`); failures++; }
}

const auth = {
  onDidChange: () => ({ dispose: () => {} }),
  getToken: async () => 'token'
} as unknown as AuthManager;

/** In-memory stand-in for the globalState-backed cache. */
function memoryCache(): CacheStore {
  const store = new Map<string, unknown>();
  return {
    wrap: async <T>(key: string, _options: unknown, load: () => Promise<T>): Promise<T> => {
      if (!store.has(key)) {
        store.set(key, await load());
      }
      return store.get(key) as T;
    },
    set: async (key: string, value: unknown) => { store.set(key, value); },
    get: async (key: string) => store.get(key),
    invalidate: async () => { store.clear(); },
    clear: async () => { store.clear(); }
  } as unknown as CacheStore;
}

function context(over: Partial<WorkContext> = {}): WorkContext {
  return {
    ticketKey: 'PROJ-1',
    branch: 'PROJ-1-thing',
    repoRoot: '/src/app',
    changedFiles: [],
    pinned: false,
    githubRepo: { owner: 'acme', name: 'app' },
    repos: [{ owner: 'acme', name: 'app' }],
    work: [
      {
        root: '/src/app',
        name: 'app',
        branch: 'PROJ-1-thing',
        ticketKey: 'PROJ-1',
        pinned: false,
        active: true
      }
    ],
    ...over
  };
}

function summary(over: Partial<PullSummary> = {}): PullSummary {
  return {
    repo: 'acme/app',
    number: 7,
    title: 'Fix the thing',
    url: 'https://github.test/acme/app/pull/7',
    author: 'me',
    createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
    additions: 1,
    deletions: 1,
    mergeable: 'mergeable',
    reviewDecision: 'review_required',
    isDraft: false,
    checks: 'success',
    unresolved: 0,
    viewerReviewed: false,
    ...over
  } as PullSummary;
}

const queues = (mine: PullSummary[]): PullQueues => ({
  viewer: 'me',
  mine,
  reviewRequested: [],
  filteredClientSide: false
});

/**
 * A Hub whose GitHub provider is a counter, so a test can say exactly how many
 * requests a sequence of triggers cost. `gate` holds the answer open to make an
 * in-flight fan-out observable.
 */
function harness(current: () => WorkContext) {
  const state = { calls: 0, gate: undefined as Promise<void> | undefined, mine: [summary()] };
  const workContext = {
    get context() { return current(); },
    onDidChange: new vscode.EventEmitter<WorkContext>().event
  } as unknown as WorkContextService;

  const hub = new Hub(auth, memoryCache(), workContext);
  hub.github.isConfigured = () => true;
  hub.github.forContext = async () => [];
  hub.github.pullQueues = async () => {
    state.calls++;
    if (state.gate) { await state.gate; }
    return queues(state.mine);
  };
  return { hub, state };
}

async function refreshTriggers(): Promise<void> {
  console.log('\nhub: which triggers earn a request');

  let current = context();
  const { hub, state } = harness(() => current);

  await hub.refresh();
  check('activation fans out once', state.calls, 1);
  check('github is marked loaded', hub.current.loaded.github, true);
  check('the context counts as looked at', hub.current.contextLoaded, true);
  check('nothing is left refreshing', hub.current.refreshing.github, false);
  check('and nothing is left loading', hub.current.loading, false);

  // A save fires a Git state event, which used to cost a full fan-out — and, if
  // one was still running, cancelled it first.
  current = context({ changedFiles: ['/src/app/a.ts'] });
  await hub.refresh();
  current = context({ changedFiles: ['/src/app/a.ts', '/src/app/b.ts'] });
  await hub.refresh();
  check('saves inside the interval cost no requests', state.calls, 1);
  check('the changed files still reach the snapshot', hub.current.context.changedFiles.length, 2);
  check('and the rows stay current', hub.current.contextLoaded, true);

  current = context({ branch: 'PROJ-2-other', ticketKey: 'PROJ-2' });
  await hub.refresh();
  check('a branch switch refreshes immediately', state.calls, 2);

  await hub.refresh();
  check('a repeat within the interval is held back', state.calls, 2);
  await hub.refresh({ force: true });
  check('force ignores the interval', state.calls, 3);

  settings['refresh.minIntervalSeconds'] = 0;
  await hub.refresh();
  check('a zero interval refreshes on every trigger', state.calls, 4);
  delete settings['refresh.minIntervalSeconds'];

  hub.dispose();
}

async function burst(): Promise<void> {
  console.log('\nhub: a burst of triggers on one fan-out');

  const current = context();
  const { hub, state } = harness(() => current);

  let release = (): void => {};
  state.gate = new Promise<void>((resolve) => { release = () => resolve(); });

  const runs = Array.from({ length: 10 }, () => hub.refresh());
  check('ten triggers make one request', state.calls, 1);
  release();
  state.gate = undefined;
  await Promise.all(runs);
  check('and it is still one after they settle', state.calls, 1);

  hub.dispose();
}

async function trailingEdge(): Promise<void> {
  console.log('\nhub: the held trigger still runs');

  settings['refresh.minIntervalSeconds'] = 1;
  let current = context();
  const { hub, state } = harness(() => current);

  await hub.refresh();
  check('one round to begin with', state.calls, 1);
  current = context({ changedFiles: ['/src/app/c.ts'] });
  await hub.refresh();
  check('the next trigger is held', state.calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  check('and runs once the window closes', state.calls, 2);

  delete settings['refresh.minIntervalSeconds'];
  hub.dispose();
}

async function pullRequestView(): Promise<void> {
  console.log('\npull request view: what is on screen while it refreshes');

  const current = context();
  const { hub, state } = harness(() => current);

  const view = { description: undefined as string | undefined, badge: undefined };
  const tree = new PullRequestTree(hub, { get: () => undefined, update: async () => {} } as never);
  tree.attach(view as never);

  let rebuilds = 0;
  tree.onDidChangeTreeData(() => { rebuilds++; });

  type Row = { kind: string; label?: string; pull?: { number: number } };
  const rows = (id: 'branch' | 'mine'): (string | number)[] =>
    (tree.getChildren({ kind: 'group', id, label: '', icon: '', count: 0 } as never) as Row[]).map(
      (row) => (row.kind === 'message' ? (row.label as string) : (row.pull as { number: number }).number)
    );

  // Before GitHub has said anything, an empty queue is unknown, not empty.
  check('an unanswered queue says it is loading', rows('mine'), ['Loading…']);
  check('so does the branch section', rows('branch'), ['Loading…']);

  await hub.refresh();
  check('the queue shows its row', rows('mine'), [7]);
  check('an answered branch section is truthful', rows('branch'), [
    'No pull request for PROJ-1-thing'
  ]);
  check('the header counts the queue', view.description, '1 · Updated');

  // The symptom this all started from: a refresh in flight must not take the
  // rows off the screen.
  let release = (): void => {};
  state.gate = new Promise<void>((resolve) => { release = () => resolve(); });
  const before = rebuilds;
  const running = hub.refresh({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('the row survives a refresh in flight', rows('mine'), [7]);
  check('the branch section stays truthful too', rows('branch'), [
    'No pull request for PROJ-1-thing'
  ]);
  check('the header carries the hint instead', view.description, '1 · Updated · refreshing…');
  check('and the rows are not rebuilt', rebuilds - before, 0);

  release();
  state.gate = undefined;
  await running;
  check('a result that changed nothing rebuilds nothing', rebuilds - before, 0);
  check('and the hint is gone again', view.description, '1 · Updated');

  state.mine = [summary({ number: 9 })];
  await hub.refresh({ force: true });
  check('a queue that did change redraws once', rebuilds - before, 1);
  check('and shows the new row', rows('mine'), [9]);

  tree.dispose();
  hub.dispose();
}

/**
 * The row text, rendered by the real views.
 *
 * A row cannot wrap and the description is what gets pushed off the end of it,
 * so these check the two halves are actually sharing the width: the title
 * clamped to its budget, and everything worth scanning for still in the
 * description behind it.
 */
async function rowText(): Promise<void> {
  console.log('\nrow text: what fits on one row');

  const current = context();
  const { hub, state } = harness(() => current);
  const longTitle = 'Align the learning path performance page with its Figma spec';
  state.mine = [summary({ number: 2712, title: longTitle, reviewDecision: 'approved' })];

  const tree = new PullRequestTree(hub, { get: () => undefined, update: async () => {} } as never);
  tree.attach({ description: undefined, badge: undefined } as never);
  await hub.refresh();

  const [row] = tree.getChildren({
    kind: 'group',
    id: 'mine',
    label: '',
    icon: '',
    count: 0
  } as never) as never[];
  const item = tree.getTreeItem(row);

  check('the title is clamped to the budget', item.label, '#2712  Align the learning path…');
  check('the label leaves room for the rest', String(item.label).length <= 40, true);
  check('and the rest is all there', item.description, 'Approved · 14m ago · acme/app');
  check('the full title stays in the tooltip', String((item.tooltip as { value: string }).value).includes(longTitle), true);

  tree.dispose();
  hub.dispose();

  // Tasks: the status moved back into the description now that the summary
  // cannot crowd it out, so both it and the age have to be there.
  const { hub: taskHub } = harness(() => current);
  const issue = {
    key: 'EVULPO-2460',
    summary: longTitle,
    status: 'In Progress',
    statusCategory: 'indeterminate',
    issueType: 'Bug',
    priority: 'High',
    updated: new Date(Date.now() - 14 * 60_000).toISOString(),
    url: 'https://jira.test/EVULPO-2460',
    subtasks: []
  } as unknown as JiraIssue;
  taskHub.jira.isConfigured = () => true;
  taskHub.jira.assignedToMe = async () => [issue];
  taskHub.jira.priorityOrder = async () => ['High', 'Medium', 'Low'];
  taskHub.jira.forContext = async () => [];

  const tasks = new TaskTree(taskHub, {
    get: (_key: string, fallback: unknown) => fallback,
    update: async () => {}
  } as never);
  tasks.attach({ description: undefined } as never);
  await taskHub.refresh();

  const [taskRow] = tasks.getChildren() as never[];
  const taskItem = tasks.getTreeItem(taskRow);
  check('the summary is clamped', taskItem.label, 'EVULPO-2460 · Align the learning path…');
  check('the status is back in the description', taskItem.description, 'In Progress · 14m ago');

  tasks.dispose();
  taskHub.dispose();
}

void (async () => {
  await refreshTriggers();
  await burst();
  await trailingEdge();
  await pullRequestView();
  await rowText();
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
