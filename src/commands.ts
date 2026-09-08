import * as vscode from 'vscode';
import { findTicketKey, renderBranchName } from './context/ticketKeyResolver';
import type { WorkContextService } from './context/WorkContextService';
import { AuthManager, ProviderId, TokenValidator } from './infra/AuthManager';
import type { CacheStore } from './infra/CacheStore';
import { config } from './infra/Config';
import { log } from './infra/Logger';
import {
  isCustomised,
  promptActions,
  scopeFor,
  type PromptSettingId,
  type SettingScope
} from './infra/promptSettings';
import type { Hub } from './providers/Hub';
import type { JiraIssue } from './providers/jira/JiraClient';
import type { PullSummary } from './providers/github/pullStatus';
import { renderReviewPrompt } from './providers/github/reviewPrompt';
import { renderPrompt } from './providers/jira/promptTemplate';
import { findInProgressTransition } from './providers/jira/transitions';
import type { ProviderTree } from './ui/ProviderTree';
import type { PullRequestTree } from './ui/PullRequestTree';
import type { TaskTree } from './ui/TaskTree';

interface Deps {
  hub: Hub;
  auth: AuthManager;
  cache: CacheStore;
  workContext: WorkContextService;
  providerTree: ProviderTree;
  taskTree: TaskTree;
  pullRequestTree: PullRequestTree;
}

const CONFIG_TARGETS: Record<SettingScope, vscode.ConfigurationTarget> = {
  workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
  workspace: vscode.ConfigurationTarget.Workspace,
  global: vscode.ConfigurationTarget.Global
};

/**
 * Commands invoked from a tree row arrive with the node as their argument;
 * the palette, the status bar and the view title pass nothing and mean
 * "whatever the current branch is".
 */
function providerFrom(arg: unknown): ProviderId | undefined {
  if (AuthManager.isProviderId(arg)) {
    return arg;
  }
  const node = arg as { id?: unknown } | undefined;
  return AuthManager.isProviderId(node?.id) ? node.id : undefined;
}

/** The issue behind a tree row, for commands that need more than its key. */
function issueFrom(arg: unknown): JiraIssue | undefined {
  const node = arg as { issue?: JiraIssue } | undefined;
  return node?.issue?.key ? node.issue : undefined;
}

/** The pull request behind a row in the Pull requests view. */
function pullFrom(arg: unknown): PullSummary | undefined {
  const node = arg as { pull?: PullSummary } | undefined;
  return node?.pull?.url ? node.pull : undefined;
}

function keyFrom(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  const node = arg as { issue?: { key?: string } } | undefined;
  return node?.issue?.key;
}

async function pickProvider(prompt: string): Promise<ProviderId | undefined> {
  const picked = await vscode.window.showQuickPick(
    AuthManager.all().map((id) => ({ label: AuthManager.label(id), id })),
    { title: prompt, placeHolder: 'Choose a service' }
  );
  return picked?.id;
}

function reportError(err: unknown, fallback: string): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(fallback, err);
  void vscode.window
    .showErrorMessage(`DevHub: ${message}`, 'Show logs')
    .then((choice) => choice === 'Show logs' && log.show());
}

export function registerCommands(deps: Deps): vscode.Disposable[] {
  const { hub, auth, cache, workContext, providerTree, taskTree, pullRequestTree } = deps;

  // Jira tokens are checked against /rest/api/3/myself before they are stored,
  // so a token that cannot work never becomes saved state.
  const validators: Partial<Record<ProviderId, TokenValidator>> = {
    jira: (token) => hub.jira.verifyToken(token),
    github: (token) => hub.github.verifyToken(token)
  };

  const signIn = async (preselected?: ProviderId) => {
    const id = preselected ?? (await pickProvider('Connect a service'));
    if (!id) {
      return;
    }
    const result = await auth.connect(id, validators[id]);
    if (!result.stored) {
      return;
    }
    const verifier = { jira: hub.jira, figma: hub.figma, sentry: hub.sentry, github: hub.github }[id];
    const identity = result.identity ?? (await verifier.verify());
    providerTree.refresh();
    if (identity) {
      void vscode.window.showInformationMessage(
        `DevHub: connected to ${AuthManager.label(id)} as ${identity}.`
      );
    } else {
      void vscode.window.showWarningMessage(
        `DevHub: stored the ${AuthManager.label(id)} token, but the test call failed. Check the Connections view.`
      );
    }
    await hub.refresh();
  };

  /**
   * Deletes a provider's stored token, optionally along with the settings that
   * go with it, then offers to reconnect straight away — clearing credentials
   * is almost always the first half of replacing them.
   */
  const clearCredentials = async (arg?: unknown) => {
    const id =
      providerFrom(arg) ?? (await pickProvider('Clear stored credentials'));
    if (!id) {
      return;
    }
    const label = AuthManager.label(id);

    if (!(await auth.hasToken(id))) {
      const choice = await vscode.window.showInformationMessage(
        `DevHub: no ${label} credentials are stored.`,
        'Connect'
      );
      if (choice === 'Connect') {
        await signIn(id);
      }
      return;
    }

    const settingLabels = AuthManager.requiredSettingLabels(id);
    const CLEAR_TOKEN = 'Clear token';
    const CLEAR_ALL = 'Clear token and settings';
    const buttons = settingLabels.length > 0 ? [CLEAR_TOKEN, CLEAR_ALL] : [CLEAR_TOKEN];

    const detail = [
      `The ${label} token is deleted from VS Code's secret storage. This cannot be undone — you will need to enter a new one to reconnect.`,
      settingLabels.length > 0
        ? `"${CLEAR_ALL}" also resets ${settingLabels.join(' and ')}, so you are asked for them again.`
        : undefined
    ]
      .filter(Boolean)
      .join('\n\n');

    // Modal: deleting a secret is not undoable, so it should not be possible to
    // dismiss the confirmation by accident.
    const choice = await vscode.window.showWarningMessage(
      `Clear the stored ${label} credentials?`,
      { modal: true, detail },
      ...buttons
    );
    if (choice !== CLEAR_TOKEN && choice !== CLEAR_ALL) {
      return;
    }

    try {
      await auth.disconnect(id);
      if (choice === CLEAR_ALL) {
        await auth.clearRequiredSettings(id);
      }
    } catch (err) {
      reportError(err, `Could not clear the ${label} credentials`);
      return;
    }

    providerTree.refresh();
    await hub.refresh();

    const next = await vscode.window.showInformationMessage(
      `DevHub: cleared the ${label} credentials.`,
      'Connect again'
    );
    if (next === 'Connect again') {
      await signIn(id);
    }
  };

  const transitionIssue = async (arg?: unknown) => {
    const key = keyFrom(arg) ?? hub.current.context.ticketKey;
    if (!key) {
      void vscode.window.showInformationMessage('DevHub: no ticket detected for this branch.');
      return;
    }
    try {
      const transitions = await hub.jira.getTransitions(key);
      if (transitions.length === 0) {
        void vscode.window.showInformationMessage(`DevHub: no transitions available on ${key}.`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        transitions.map((t) => ({ label: t.name, description: `→ ${t.to}`, id: t.id })),
        { title: `Move ${key} to…` }
      );
      if (!picked) {
        return;
      }
      await hub.jira.transition(key, picked.id);
      await hub.refresh();
      void vscode.window.showInformationMessage(`DevHub: ${key} moved to ${picked.label}.`);
    } catch (err) {
      reportError(err, 'Transition failed');
    }
  };

  const startWork = async () => {
    let issues;
    try {
      issues = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'DevHub: loading your issues…' },
        () => hub.jira.forMe()
      );
    } catch (err) {
      reportError(err, 'Could not load your issues');
      providerTree.refresh();
      return;
    }

    // Reaching here means Jira answered, so an empty list is the query's doing.
    if (issues.length === 0) {
      void vscode.window.showInformationMessage(
        'DevHub: Jira returned no issues for devhub.jira.jql. The query matched nothing.'
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      issues.map((issue) => ({
        label: `${issue.key}  ${issue.summary}`,
        description: issue.status,
        detail: issue.issueType + (issue.priority ? ` · ${issue.priority}` : ''),
        issue
      })),
      { title: 'Start work on issue', matchOnDescription: true, matchOnDetail: true }
    );
    if (!picked) {
      return;
    }

    const { issue } = picked;
    const suggested = renderBranchName(
      config.branchTemplate(),
      issue.key,
      issue.summary,
      issue.issueType
    );
    const branch = await vscode.window.showInputBox({
      title: `Branch for ${issue.key}`,
      value: suggested,
      prompt: 'Press Enter to create and check out this branch'
    });
    if (!branch) {
      return;
    }

    try {
      await workContext.createBranch(branch.trim());
    } catch (err) {
      reportError(err, 'Could not create branch');
      return;
    }

    // Offer the transition rather than doing it silently — workflows differ and
    // moving someone's ticket without asking is a bad surprise.
    const transitions = await hub.jira.getTransitions(issue.key);
    const inProgress = findInProgressTransition(transitions, config.jira.inProgressTransition());
    if (inProgress) {
      const choice = await vscode.window.showInformationMessage(
        `Branch created. Move ${issue.key} to ${inProgress.to}?`,
        'Yes',
        'No'
      );
      if (choice === 'Yes') {
        try {
          await hub.jira.transition(issue.key, inProgress.id);
        } catch (err) {
          reportError(err, 'Transition failed');
        }
      }
    }

    await hub.refresh();
  };

  const pinTicket = async () => {
    const key = await vscode.window.showInputBox({
      title: 'Pin a ticket to this workspace',
      prompt: 'Issue key, for example PROJ-1234',
      value: hub.current.context.ticketKey ?? '',
      validateInput: (value) =>
        /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(value.trim()) ? undefined : 'Expected a key like PROJ-1234'
    });
    if (key) {
      await workContext.pin(key.trim());
      await hub.refresh();
    }
  };

  const addComment = async () => {
    const key = hub.current.context.ticketKey;
    if (!key) {
      void vscode.window.showInformationMessage('DevHub: no ticket detected for this branch.');
      return;
    }
    const body = await vscode.window.showInputBox({
      title: `Comment on ${key}`,
      prompt: 'Your comment',
      ignoreFocusOut: true
    });
    if (!body?.trim()) {
      return;
    }
    try {
      await hub.jira.addComment(key, body.trim());
      await hub.refresh();
      void vscode.window.showInformationMessage(`DevHub: commented on ${key}.`);
    } catch (err) {
      reportError(err, 'Comment failed');
    }
  };

  const openTicket = async (arg?: unknown) => {
    const key = keyFrom(arg) ?? hub.current.context.ticketKey;
    if (!key) {
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(hub.jira.browseUrl(key)));
  };

  const openDesign = async () => {
    const designs = hub.current.designs;
    if (designs.length === 0) {
      void vscode.window.showInformationMessage('DevHub: no designs linked from the current ticket.');
      return;
    }
    if (designs.length === 1) {
      await vscode.env.openExternal(vscode.Uri.parse(designs[0].url));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      designs.map((d) => ({ label: d.name, description: d.type, url: d.url })),
      { title: 'Open design' }
    );
    if (picked) {
      await vscode.env.openExternal(vscode.Uri.parse(picked.url));
    }
  };

  /**
   * The branch name for the current ticket, without creating the branch —
   * for when the branch already exists elsewhere, or belongs in a commit
   * message or a chat message.
   */
  const copyBranchName = async () => {
    const { context, issue } = hub.current;
    if (!context.ticketKey) {
      void vscode.window.showInformationMessage('DevHub: no ticket detected for this branch.');
      return;
    }
    const name = renderBranchName(
      config.branchTemplate(),
      context.ticketKey,
      issue?.summary ?? '',
      issue?.issueType ?? 'task'
    );
    await vscode.env.clipboard.writeText(name);
    void vscode.window.showInformationMessage(`DevHub: copied ${name}`);
  };

  /**
   * Why an error has no clickable location. Writes the frame-by-frame
   * resolution to the log rather than a notification: it is a wall of paths,
   * and the answer is usually visible by comparing two of them.
   */
  const diagnosePathMapping = async () => {
    const { errors } = hub.current;
    if (errors.length === 0) {
      void vscode.window.showInformationMessage('DevHub: no Sentry issues loaded to diagnose.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      errors.map((issue) => ({
        label: issue.title,
        description: `${issue.locations.length} resolved frames`,
        issue
      })),
      { title: 'Diagnose path mapping for…' }
    );
    if (!picked) {
      return;
    }
    const lines = await hub.sentry.explain(picked.issue, hub.current.context);
    log.info('--- Path mapping diagnosis ---');
    lines.forEach((line) => log.info(line));
    log.info(`mappings: ${JSON.stringify(config.sentry.pathMappings())}`);
    log.show();
  };

  /**
   * The task's ticket as a ready-to-paste instruction, from
   * `devhub.tasks.promptTemplate`.
   *
   * Invoked from a row it uses that row's issue; from the palette it falls back
   * to the branch's ticket, which is what the other ticket commands do.
   */
  const copyTaskPrompt = async (arg?: unknown) => {
    const issue = issueFrom(arg) ?? hub.current.issue;
    if (!issue) {
      void vscode.window.showInformationMessage(
        'DevHub: no ticket for this row or branch, so there is nothing to copy.'
      );
      return;
    }
    const text = renderPrompt(config.tasks.promptTemplate(), issue);
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(`DevHub: copied the prompt for ${issue.key}.`);
  };

  /**
   * A pull request awaiting review, as a ready-to-paste instruction, from
   * `devhub.github.reviewPromptTemplate`.
   *
   * The ticket key is resolved here rather than in the renderer because the
   * pattern is a setting; the PR title is where it usually lives, with the
   * branch-derived key as the fallback.
   */
  const copyReviewPrompt = async (arg?: unknown) => {
    const pull = pullFrom(arg);
    if (!pull) {
      void vscode.window.showInformationMessage(
        'DevHub: run this from a row in Awaiting my review.'
      );
      return;
    }
    const ticketKey = findTicketKey(pull.title) ?? hub.current.context.ticketKey ?? '';
    const text = renderReviewPrompt(config.github.reviewPromptTemplate(), pull, ticketKey);
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(
      `DevHub: copied the review prompt for ${pull.repo}#${pull.number}.`
    );
  };

  /**
   * Opens one of the copy-button prompts for editing.
   *
   * Both settings default to empty meaning "use the built-in text", so the
   * Settings UI would otherwise open on a blank box and changing one sentence
   * would mean retyping the whole prompt. Writing the text that is actually in
   * use into the setting first turns that into an edit, and the reset entries
   * put the built-in default back.
   */
  const editCopyPrompt = async () => {
    const section = () => vscode.workspace.getConfiguration('devhub');
    const raw: Record<PromptSettingId, string> = {
      tasks: section().get<string>('tasks.promptTemplate', ''),
      review: section().get<string>('github.reviewPromptTemplate', '')
    };

    const picked = await vscode.window.showQuickPick(
      promptActions(raw).map((action) => ({ ...action, alwaysShow: true })),
      { placeHolder: 'Which copy button?', matchOnDetail: true }
    );
    if (!picked) {
      return;
    }

    const { setting, action } = picked;
    const target = CONFIG_TARGETS[scopeFor(section().inspect<string>(setting.key))];

    if (action === 'reset') {
      try {
        await section().update(setting.key, undefined, target);
      } catch (error) {
        log.error(`could not reset ${setting.setting}`, error);
        void vscode.window.showErrorMessage(`DevHub: could not reset ${setting.setting}.`);
        return;
      }
      void vscode.window.showInformationMessage(
        `DevHub: ${setting.view} is back to the built-in prompt.`
      );
      return;
    }

    // An existing override is already the text the box will show, so only an
    // untouched setting needs seeding.
    let seeded = false;
    if (!isCustomised(raw[setting.id])) {
      const effective =
        setting.id === 'tasks'
          ? config.tasks.promptTemplate()
          : config.github.reviewPromptTemplate();
      try {
        await section().update(setting.key, effective, target);
        seeded = true;
      } catch (error) {
        // The box will open blank, so say so rather than claiming otherwise.
        log.error(`could not seed ${setting.setting}`, error);
        void vscode.window.showWarningMessage(
          `DevHub: could not fill ${setting.setting} in, so it will open empty.`
        );
      }
    }

    await vscode.commands.executeCommand('workbench.action.openSettings', setting.setting);
    if (seeded) {
      void vscode.window.showInformationMessage(
        `DevHub: filled ${setting.view} in with the prompt in use — edit it in place, or run this command again to reset it.`
      );
    }
  };

  const showActions = async () => {
    const { context, issue } = hub.current;
    const actions: { label: string; command: string; description?: string }[] = [];

    if (context.ticketKey) {
      actions.push(
        { label: '$(link-external) Open ticket in browser', command: 'devhub.openTicket' },
        {
          label: '$(arrow-right) Change status',
          command: 'devhub.transitionIssue',
          description: issue?.status
        },
        { label: '$(comment) Add a comment', command: 'devhub.addComment' }
      );
    }
    actions.push(
      { label: '$(rocket) Start work on issue…', command: 'devhub.startWork' },
      { label: '$(pin) Pin a ticket…', command: 'devhub.pinTicket' },
      { label: '$(copy) Copy branch name', command: 'devhub.copyBranchName' }
    );
    if (context.pinned) {
      actions.push({ label: '$(pinned) Unpin ticket', command: 'devhub.unpinTicket' });
    }
    if (hub.current.designs.length > 0) {
      actions.push({ label: '$(symbol-color) Open design', command: 'devhub.openDesign' });
    }
    if (hub.current.tasks.length > 0) {
      actions.push(
        {
          label: '$(filter) Filter tasks by status…',
          command: 'devhub.tasks.filterByStatus',
          description: `${hub.current.tasks.length} assigned`
        },
        { label: '$(sort-precedence) Sort tasks…', command: 'devhub.tasks.setSort' }
      );
    }
    actions.push(
      { label: '$(refresh) Refresh', command: 'devhub.refresh' },
      { label: '$(plug) Connect a service…', command: 'devhub.signIn' },
      { label: '$(edit) Edit copy prompt…', command: 'devhub.editCopyPrompt' },
      { label: '$(output) Show logs', command: 'devhub.showLogs' }
    );

    const picked = await vscode.window.showQuickPick(actions, {
      title: context.ticketKey ? `${context.ticketKey} — ${issue?.summary ?? ''}` : 'DevHub'
    });
    if (picked) {
      await vscode.commands.executeCommand(picked.command);
    }
  };

  return [
    vscode.commands.registerCommand('devhub.signIn', signIn),
    vscode.commands.registerCommand('devhub.signOut', clearCredentials),
    vscode.commands.registerCommand('devhub.clearCredentials', clearCredentials),
    vscode.commands.registerCommand('devhub.refresh', async () => {
      await workContext.refresh();
      // An explicit refresh should mean it, so drop the cached task list first.
      await hub.jira.invalidateTasks();
      await hub.refresh();
      providerTree.refresh();
    }),
    vscode.commands.registerCommand('devhub.pinTicket', pinTicket),
    vscode.commands.registerCommand('devhub.unpinTicket', async () => {
      await workContext.unpin();
      await hub.refresh();
    }),
    vscode.commands.registerCommand('devhub.startWork', startWork),
    vscode.commands.registerCommand('devhub.transitionIssue', transitionIssue),
    vscode.commands.registerCommand('devhub.addComment', addComment),
    vscode.commands.registerCommand('devhub.openTicket', openTicket),
    vscode.commands.registerCommand('devhub.openDesign', openDesign),
    vscode.commands.registerCommand('devhub.showActions', showActions),
    vscode.commands.registerCommand('devhub.tasks.filterByStatus', () =>
      taskTree.pickStatusFilter()
    ),
    vscode.commands.registerCommand('devhub.tasks.clearFilter', () => taskTree.clearStatusFilter()),
    vscode.commands.registerCommand('devhub.tasks.setSort', () => taskTree.pickSort()),
    vscode.commands.registerCommand('devhub.pullRequests.setSort', () => pullRequestTree.pickSort()),
    vscode.commands.registerCommand('devhub.copyBranchName', copyBranchName),
    vscode.commands.registerCommand('devhub.tasks.copyPrompt', copyTaskPrompt),
    vscode.commands.registerCommand('devhub.pullRequests.copyReviewPrompt', copyReviewPrompt),
    vscode.commands.registerCommand('devhub.editCopyPrompt', editCopyPrompt),
    vscode.commands.registerCommand('devhub.diagnosePathMapping', diagnosePathMapping),
    vscode.commands.registerCommand('devhub.showLogs', () => log.show()),
    vscode.commands.registerCommand('devhub.clearCache', async () => {
      await cache.clear();
      await hub.refresh();
      void vscode.window.showInformationMessage('DevHub: cache cleared.');
    })
  ];
}
