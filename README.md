# DevHub

Jira, Figma and Sentry in one VS Code sidebar, keyed off the branch you're on.

Check out `feature/PROJ-1234-fix-login` and DevHub shows the Jira issue, the Figma frames linked from it, the Sentry errors touching the files you changed, and a status bar line that summarises all of it. **My tasks** sits alongside it with everything else assigned to you.

## Run it

```bash
npm install
npm run compile
```

Then press **F5** in VS Code (or run `code --extensionDevelopmentPath=$PWD`). A second window opens with DevHub loaded.

To install permanently:

```bash
npm run package        # produces devhub-0.1.0.vsix
code --install-extension devhub-0.1.0.vsix
```

## Connect services

Run **DevHub: Connect a service…** from the command palette. Each one asks for the settings it needs and then a token, which is stored in VS Code's secret storage — never in `settings.json`.

| Service | What you need |
|---|---|
| Jira | Site URL, account email, an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| Figma | A [personal access token](https://www.figma.com/developers/api#access-tokens) |
| Sentry | Organization slug, an [auth token](https://sentry.io/settings/account/api/auth-tokens/) with `project:read` and `event:read` |
| GitHub | A [token](https://github.com/settings/tokens) with `repo`, plus `read:org` for organization repositories |

The **Connections** view in the sidebar shows the health of each. Right-click a row to act on it: a connected service offers **Clear credentials**, one that isn't offers **Connect a service…**.

Clearing asks for confirmation, then offers to reconnect straight away. Where a service also needs plain settings — the Jira site URL and email, the Sentry organization — you get a second button, **Clear token and settings**, which resets those too so you're asked for them again. Tokens live in secret storage and deleting one can't be undone.

## How ticket detection works

1. A pinned ticket (**DevHub: Pin ticket…**) always wins. Pins are stored per repository *and* per branch — one pin for the whole workspace would keep overriding detection on every branch you moved to, and it outranks the branch name, so the wrong ticket would stay sticky until you noticed.
2. Otherwise the branch name is searched for `[A-Z][A-Z0-9]+-\d+` (configurable via `devhub.ticketKeyPattern`).
3. Otherwise the last commit message is searched.

If none match, the sidebar shows a welcome screen with a pin button and **Start work on issue…**, which picks from your Jira queue and creates a correctly named branch.

## My tasks

Everything assigned to you, independent of the branch you're on. Each row shows the status and how long ago it changed; the icon is the priority — a red chevron up for the urgent end of your Jira priority scheme, a blue chevron down for the quiet end. Click a row to open it in Jira, expand it for its subtasks, right-click for **Change ticket status…**.

Two controls in the view header:

- **Filter tasks by status…** — a multi-select list of the statuses actually present in your tasks, each with a count. Selecting none (or all of them) shows everything.
- **Sort tasks…** — priority highest first (the default), priority lowest first, recently updated, or issue key.

Both are remembered across sessions, and the view header shows where you are: `12 · Priority ↓`, or `5/12 · Priority ↓` when a filter is on.

Priority order comes from your site's own priority scheme (`/rest/api/3/priority`), so a `Blocker → Trivial` scheme sorts as correctly as the default `Highest → Lowest` one. If that call fails, DevHub falls back to ranking the well-known names. Tasks with no priority set always sort last, in both directions.

The list is what this JQL returns:

```jsonc
{
  // open tasks, plus anything you finished in the last fortnight
  "devhub.jira.tasksJql": "assignee = currentUser() AND (statusCategory != Done OR resolutiondate >= -14d) ORDER BY updated DESC",
  "devhub.jira.tasksLimit": 100
}
```

The status filter can only offer statuses that this query returned, so widen it if you want to filter over more. Its `ORDER BY` doesn't matter — sorting happens in the view.

Results are cached for two minutes and revalidated in the background, so switching branches costs no requests. **DevHub: Refresh** always refetches.

### Copying a task as a prompt

Every row has a clipboard button that copies the ticket as a ready-to-paste instruction — useful for handing a ticket to a coding agent without retyping the same preamble. It defaults to a two-stage *investigate, report a confidence score, wait for a green flag, then implement* prompt.

Override it with `devhub.tasks.promptTemplate`:

```jsonc
{ "devhub.tasks.promptTemplate": "Read ${url} and summarise the acceptance criteria." }
```

`${url}`, `${key}`, `${summary}`, `${type}` and `${status}` are filled in from the row. An unrecognised placeholder is left as written, so a typo shows up in the pasted text rather than silently deleting a line. Leave the setting empty for the built-in default.

The same command works from the palette as **DevHub: Copy prompt for task**, where it uses the current branch's ticket.

## Pull requests

Three groups, all scoped to the GitHub repositories open in your workspace:

- **Current branch** — the pull request for the branch you're on, expandable for its CI checks.
- **My open pull requests** — everything you have open, minus the branch one above.
- **Awaiting my review** — where someone has requested your review.

Each row reads `#2671  Title` with the repo, the state, and an age:

```
2 unresolved · Approved · Draft    6d
Checks failing                     47d
Awaiting review                    152d
```

The states, in the order they take precedence — the first one applicable is the row's icon, and every one of them shows in the description:

| State | Means |
|---|---|
| **Conflicts** | won't merge without a rebase |
| **Changes requested** | a reviewer asked for work |
| **Checks failing** | CI is red |
| **_n_ unresolved** | open review threads, resolved ones excluded |
| **Approved** | ready to merge |
| **Checks running** | CI hasn't finished |
| **Awaiting review** | waiting on someone else |
| **Draft** | not asking for review yet |

Conflicts lead because they block every other outcome: an approved pull request that won't merge still needs a rebase before anything else can happen to it. A draft never shows as "awaiting review".

**Sort pull requests…** in the view header offers recently updated (the default), least recently updated, newest and oldest, applied to both queues and remembered across sessions. Rows show the timestamp the sort is keyed on, so the order you picked is legible. The header reads `13 · Updated`, and the count of pull requests awaiting your review appears as a badge on the DevHub icon in the activity bar.

### How the scope works

Repositories come from the built-in Git extension's list, not from `workspace.workspaceFolders` — a folder can hold several repositories, a repository can be opened above or below its folder root, and worktrees appear as their own entries. Worktrees of the same repository are collapsed, so a repo with three worktrees is queried once.

Only `github.com` remotes are matched by default. For GitHub Enterprise set `devhub.github.baseUrl` to `https://your-host/api/v3`; the GraphQL endpoint and the remote host to match are both derived from it.

Both queues come back in **one GraphQL request**. REST can't do this: its search results carry neither `mergeable` nor `reviewDecision`, so the conflict state alone would cost an extra request per pull request. The repository scope is applied twice — as `repo:` qualifiers in the search when they fit inside GitHub's 256-character query limit, and always against the response — so adding a seventh repository degrades to a slightly larger response rather than to a rejected query.

### Why "conflict" sometimes takes a moment

GitHub computes mergeability lazily: the first request for a pull request it hasn't recently merge-tested returns `UNKNOWN` and *starts* the calculation, so the answer only exists once you ask twice. DevHub re-asks a few seconds later, at most twice, and only while some pull request still has no answer — there's no timer running once they all do. Until then the row simply shows no conflict state, and the tooltip says why.

### Copying a review as a prompt

Rows under **Awaiting my review** have a clipboard button that copies the pull request as a ready-to-paste instruction — the counterpart to the one in My tasks. It defaults to a prompt that reviews the PR, gathers independent findings, folds them into one review and submits it as yours.

Override it with `devhub.github.reviewPromptTemplate`:

```jsonc
{ "devhub.github.reviewPromptTemplate": "Summarise the risk in ${url} in three bullets." }
```

`${url}`, `${repo}`, `${number}`, `${title}`, `${author}` and `${key}` are filled in from the row. `${key}` is the ticket key found in the pull request title, falling back to the current branch's; it renders empty when there is none, whereas an unrecognised placeholder is left as written. Leave the setting empty for the built-in default.

The button is on the review queue only — your own pull requests don't get it — and it needs a row, so it isn't offered in the command palette.

Review comments on the current branch's pull request also appear in the Problems panel, on the lines they were left on, at Information severity — Sentry's production errors are warnings, so the two stay tellable apart. Clicking a comment row jumps to the line in your working tree; if the comment isn't on a line, it opens on GitHub instead.

Results are cached for a minute and revalidated in the background. **DevHub: Refresh** always refetches; nothing polls on a schedule.

```jsonc
{
  "devhub.github.enabled": true,
  "devhub.github.baseUrl": "https://api.github.com",
  "devhub.github.limit": 50   // per queue
}
```

The token needs `repo` (and `read:org` for organization repositories).

## When it refreshes

Nothing polls on a schedule. A refresh happens on window focus, on a branch or changed-file change (debounced 500 ms), when credentials change, on activation, and on **DevHub: Refresh**.

Whether a refresh reaches the network is decided by the cache, not by the trigger:

| Data | Cached for |
|---|---|
| Branch pull request | 45 s |
| Pull request queues | 60 s |
| Jira issue | 60 s |
| My tasks | 2 min |
| Sentry issues | 2 min |
| Sentry event frames | 5 min |
| Figma file | 5 min |
| Jira transitions | 1 h |
| Jira priorities | 24 h |

So alt-tabbing back into the editor usually costs no requests at all. The loading state is only announced if a refresh is still running after 150 ms, so those cached refreshes are invisible rather than flashing a spinner across the sidebar; anything that genuinely has to fetch still shows progress.

**DevHub: Refresh** re-reads through the same TTLs. **DevHub: Clear cache** is the way to force a full refetch.

## Sentry path mapping

Stack frames arrive as `app:///src/x.ts` or `webpack://app/./src/x.ts`. DevHub strips the common prefixes automatically; for anything else, add rewrites:

```jsonc
"devhub.sentry.pathMappings": [
  { "from": "webpack://acme/./", "to": "" }
]
```

Frames that can't be resolved to a real file are dropped rather than guessed. If errors show in the tree but no squiggles appear, the mapping is wrong — check **DevHub: Show logs**.

### Narrowing to one environment

`devhub.sentry.environment` restricts every query to a single environment:

```jsonc
{ "devhub.sentry.environment": "production" }
```

Empty (the default) means all environments.

### When a frame won't resolve

Frames are resolved against an index of the workspace's source files, not just the files you changed — a production error usually lives in code your branch never touched. The index is capped at 5000 files and cached for five minutes.

If an error still shows up with no clickable location, **DevHub: Diagnose Sentry path mapping…** writes a frame-by-frame account to the log:

```
ACME-4  TypeError: cannot read property 'id' of undefined
repoRoot: /Users/you/code/acme-web

app  app:///src/auth/login.ts:42  →  /Users/you/code/acme-web/src/auth/login.ts
app  app:///src/lib/session.ts:8  →  unresolved
lib  node_modules/react/index.js:1  →  skipped (not app code)
```

It uses the same inputs as the real resolution, so it explains what actually happened rather than what would happen under different settings. An `unresolved` app frame means `devhub.sentry.pathMappings` needs a rewrite for that prefix.

## Using it with agent mode

DevHub registers three language model tools: `#ticket`, `#errors` and `#design`. Reference them in chat, or let agent mode call them on its own:

> Implement the acceptance criteria in #ticket, matching the colours in #design.

If the Figma desktop app is running with its MCP server enabled, DevHub registers it automatically — no `mcp.json` editing.
