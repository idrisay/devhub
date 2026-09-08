import * as vscode from 'vscode';
import { DEFAULT_PROMPT_TEMPLATE } from '../providers/jira/promptTemplate';
import { normaliseOrgSlug } from '../providers/sentry/orgSlug';

export interface PathMapping {
  from: string;
  to: string;
}

function section(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('devhub');
}

/** Typed reads of `devhub.*` settings. Secrets never live here — see AuthManager. */
export const config = {
  ticketKeyPattern: (): string => section().get<string>('ticketKeyPattern', '[A-Z][A-Z0-9]+-\\d+'),
  branchTemplate: (): string => section().get<string>('branchTemplate', '${key}-${slug}'),
  statusBarEnabled: (): boolean => section().get<boolean>('statusBar.enabled', true),

  jira: {
    baseUrl: (): string => section().get<string>('jira.baseUrl', '').replace(/\/+$/, ''),
    email: (): string => section().get<string>('jira.email', ''),
    jql: (): string =>
      section().get<string>(
        'jira.jql',
        'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
      ),
    tasksJql: (): string =>
      section().get<string>(
        'jira.tasksJql',
        'assignee = currentUser() AND (statusCategory != Done OR resolutiondate >= -14d) ORDER BY updated DESC'
      ),
    tasksLimit: (): number => {
      const value = section().get<number>('jira.tasksLimit', 100);
      return Math.min(Math.max(Math.trunc(value) || 100, 1), 200);
    },
    inProgressTransition: (): string => section().get<string>('jira.inProgressTransition', '')
  },

  sentry: {
    baseUrl: (): string => section().get<string>('sentry.baseUrl', 'https://sentry.io').replace(/\/+$/, ''),
    organization: (): string => normaliseOrgSlug(section().get<string>('sentry.organization', '')),
    projects: (): string[] => section().get<string[]>('sentry.projects', []),
    environment: (): string => section().get<string>('sentry.environment', ''),
    pathMappings: (): PathMapping[] => section().get<PathMapping[]>('sentry.pathMappings', []),
    diagnostics: (): boolean => section().get<boolean>('sentry.diagnostics', true),
    codeLens: (): boolean => section().get<boolean>('sentry.codeLens', true)
  },

  tasks: {
    // Empty means the built-in template, so an override is opt-in and the
    // default only exists in one place.
    promptTemplate: (): string =>
      section().get<string>('tasks.promptTemplate', '').trim() || DEFAULT_PROMPT_TEMPLATE
  },

  figma: {
    enabled: (): boolean => section().get<boolean>('figma.enabled', true)
  },

  github: {
    enabled: (): boolean => section().get<boolean>('github.enabled', true),
    baseUrl: (): string =>
      section().get<string>('github.baseUrl', 'https://api.github.com').replace(/\/+$/, ''),
    limit: (): number => {
      const value = section().get<number>('github.limit', 50);
      return Math.min(Math.max(Math.trunc(value) || 50, 1), 100);
    }
  },

  onDidChange(listener: (e: vscode.ConfigurationChangeEvent) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devhub')) {
        listener(e);
      }
    });
  }
};
