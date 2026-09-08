# DevHub — reviewed plan

The original design proposed six phases. Having built the first five, here is what changed and what to do next, in order.

## What exists now

| Area | State |
|---|---|
| Branch → ticket resolution (pin / branch / commit) | Done |
| Status bar with ticket, status, error count, design count | Done |
| Jira: read issue, JQL queue, transitions, comments, start-work flow | Done |
| Sentry: issue list, diff correlation, Problems-panel diagnostics, CodeLens | Done |
| Figma: link mining from ticket, node metadata, cached PNG renders, swatches | Done |
| Connections view with per-provider health | Done |
| Language model tools (`#ticket`, `#errors`, `#design`) | Done |
| Figma MCP auto-registration | Done |
| Caching (TTL, stale-while-revalidate, single-flight, blob store) | Done |
| Auth in SecretStorage, log redaction | Done |
| Git host / PR panel | Not started |
| Chat participant (`/standup`, `/triage`) | Dropped — see below |
| Hover provider for ticket keys | Not started |
| Automated tests | Not started |

## What building it changed about the plan

**Validate before extending.** The design was written before touching real APIs. The right next step is not phase 6 — it is running this against your actual Jira site, branch naming and Sentry projects, because the three assumptions most likely to be wrong are all environment-specific:

1. Your branch names contain a ticket key. If your team uses `jd/fix-login`, detection falls through to pinning every time, and a per-branch pin map becomes the priority.
2. Your Sentry frames map to workspace paths. Nothing else in the Sentry integration matters until the squiggles land on the right line.
3. Your Jira workflow's transition names contain "In progress" or "Start". The start-work flow searches for those; a workflow with "Doing" needs a setting.

**Add a diagnose command early.** A `DevHub: Diagnose path mapping` command that takes one Sentry issue, prints every frame, what it mapped to, and why it was dropped, will save more time than any feature. It's about forty lines and belongs at the top of the next-steps list.

**Tests for the pure modules are not optional.** The smoke test during the build caught an infinite loop in the Figma URL parser — a shared global regex whose `lastIndex` was reset by a nested call. `adf.ts`, `urlParser.ts`, `pathMapper.ts` and `ticketKeyResolver.ts` have no `vscode` dependency on purpose. Give them a Vitest suite.

**Drop the chat participant.** The language model tools already work in agent mode and in any chat surface that consumes tools. `/standup` is a prompt that calls `#ticket` and `#errors`; it doesn't need its own participant. Removing it saves a phase.

**Frame resolution is currently narrowed to changed files.** `resolveFrame` only suffix-matches against `ctx.changedFiles`, so an issue found via the ticket key whose stack trace lives in an unchanged file gets no locations. That was a safe default for v1, but for the ticket-keyed path it should fall back to a workspace-wide file index (`workspace.findFiles`, cached per session).

## Next steps, in order

### 1. First real run (an afternoon)

- `npm install && npm run compile`, press F5.
- Connect Jira. Check that the ticket for your current branch appears and that the status transition list looks right for your workflow.
- Connect Sentry. Open **DevHub: Show logs** and confirm issues are being fetched for the right projects.
- Connect Figma. Paste a frame URL into a ticket comment, refresh, confirm the thumbnail renders.

Write down which of the three assumptions above held.

### 2. Make Sentry mapping debuggable (half a day)

- Add `devhub.diagnosePathMapping`: pick an issue, print frame → mapped path → resolution outcome to the output channel.
- Add the workspace-wide file index fallback for ticket-keyed issues.
- Add `devhub.sentry.environment` (e.g. `production`) to the query so staging noise is excluded.

### 3. Tests (half a day)

- Vitest on the four pure modules. Fixtures: three real ADF documents from your Jira, five real Sentry frame filenames from your projects, ten branch names from your repo history.

### 4. Ergonomics you'll notice daily (one to two days)

- Hover provider: hovering `PROJ-1234` in any file shows the summary and status.
- Per-branch pin map so pins survive branch switches on repos without keyed branches.
- `devhub.jira.inProgressTransition` setting for workflows that don't use the words "In progress".
- Auto-refresh the Jira issue when the Jira tab regains focus is already there; add a five-minute idle refresh for Sentry only.

### 5. Git host panel (two days)

PR for the current branch: state, review comments count, CI status. Use the GitHub Pull Requests extension's exported API if installed, else the REST API with a token via the same AuthManager. This was phase 6 in the original plan and it stays last because it's the one you can get from another extension today.

### 6. Only if it's shared with the team

- OAuth 2.0 (3LO) for Jira instead of API tokens, via `registerUriHandler` and `env.asExternalUri`.
- Publish to a private registry or the marketplace under a real publisher id.
- `walkthrough` contribution for first-run setup.

## Things deliberately left out

- Polling. Refresh happens on context change, window focus and manual refresh. Adding a timer is the fastest way to get rate-limited by Atlassian.
- A large webview. Tree views and the status bar are keyboard-navigable and theme-aware for free; the one webview is the frame renderer, which needs pixels.
- Reimplementing Figma's design-to-code. Their MCP server does it and DevHub registers it.
