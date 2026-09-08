import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { WorkContextService } from './context/WorkContextService';
import { AuthManager } from './infra/AuthManager';
import { CacheStore } from './infra/CacheStore';
import { log } from './infra/Logger';
import { Hub } from './providers/Hub';
import { registerMcpProvider } from './ai/mcpProvider';
import { registerTools } from './ai/tools';
import { DesignPanel } from './ui/DesignPanel';
import { ErrorTree } from './ui/ErrorTree';
import { ProviderTree } from './ui/ProviderTree';
import { ReviewDiagnostics } from './ui/ReviewDiagnostics';
import { PullRequestTree } from './ui/PullRequestTree';
import { SentryDiagnostics } from './ui/SentryDiagnostics';
import { StatusBar } from './ui/StatusBar';
import { TaskTree } from './ui/TaskTree';
import { TicketTree } from './ui/TicketTree';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.info('DevHub activating');

  const auth = new AuthManager(context.secrets);
  const cache = new CacheStore(context);
  const workContext = new WorkContextService(context.workspaceState);
  const hub = new Hub(auth, cache, workContext);

  const ticketTree = new TicketTree(hub);
  const taskTree = new TaskTree(hub, context.globalState);
  const errorTree = new ErrorTree(hub);
  const providerTree = new ProviderTree(hub, auth);
  const designPanel = new DesignPanel(hub, cache);
  const pullRequestTree = new PullRequestTree(hub, context.globalState);

  // Created up front so the provider can write the filter and sort summary into
  // the view header.
  const tasksView = vscode.window.createTreeView('devhub.tasks', {
    treeDataProvider: taskTree,
    showCollapseAll: true
  });
  taskTree.attach(tasksView);

  // Same reason, plus the review-request badge, which VS Code rolls up onto the
  // DevHub icon in the activity bar.
  const pullRequestsView = vscode.window.createTreeView('devhub.pullRequests', {
    treeDataProvider: pullRequestTree,
    showCollapseAll: true
  });
  pullRequestTree.attach(pullRequestsView);

  context.subscriptions.push(
    log,
    auth,
    hub,
    workContext,
    ticketTree,
    taskTree,
    errorTree,
    providerTree,
    designPanel,
    pullRequestTree,

    vscode.window.createTreeView('devhub.ticket', {
      treeDataProvider: ticketTree,
      showCollapseAll: true
    }),
    tasksView,
    pullRequestsView,
    vscode.window.createTreeView('devhub.errors', { treeDataProvider: errorTree }),
    vscode.window.createTreeView('devhub.providers', { treeDataProvider: providerTree }),
    vscode.window.registerWebviewViewProvider(DesignPanel.viewType, designPanel, {
      webviewOptions: { retainContextWhenHidden: true }
    }),

    new StatusBar(hub),
    new SentryDiagnostics(hub),
    new ReviewDiagnostics(hub),

    ...registerCommands({ hub, auth, cache, workContext, providerTree, taskTree, pullRequestTree }),
    ...registerTools(hub),
    registerMcpProvider(),

    // Refresh on window focus. Nothing polls on a schedule — polling is what
    // gets you rate limited — so this and a branch change are what keep the
    // sidebar current. Staleness is decided by the cache TTLs rather than here,
    // so a focus refresh usually costs no requests and shows no spinner.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void hub.refresh();
      }
    })
  );

  await workContext.activate();
  await hub.refresh();

  log.info('DevHub ready');
}

export function deactivate(): void {
  log.info('DevHub deactivated');
}
