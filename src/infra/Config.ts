import * as vscode from 'vscode';
import { DEFAULT_REVIEW_PROMPT_TEMPLATE } from '../providers/github/reviewPrompt';
import { DEFAULT_UPDATE_PROMPT_TEMPLATE } from '../providers/github/updatePrompt';
import { DEFAULT_PROMPT_TEMPLATE } from '../providers/jira/promptTemplate';
import { DEFAULT_LATENCY_QUERY } from '../providers/grafana/latencyQuery';
import { normaliseOrgSlug } from '../providers/sentry/orgSlug';
import { DEFAULT_TITLE_LENGTH } from '../ui/rowText';

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

  rows: {
    /**
     * Characters a row's label may take. The rest of the row is the
     * description — the age, the repository, the review state — and a label
     * that takes the whole width leaves none of it visible. `0` turns the
     * clamping off for anyone running a very wide sidebar.
     */
    titleLength: (): number => {
      const value = section().get<number>('rows.titleLength', DEFAULT_TITLE_LENGTH);
      const length = Number.isFinite(value) ? Math.trunc(value) : DEFAULT_TITLE_LENGTH;
      return Math.min(Math.max(length, 0), 200);
    }
  },

  refresh: {
    /**
     * The shortest gap between two background rounds of provider requests.
     *
     * Nothing polls, but the triggers that do exist — window focus, a Git state
     * event, a save — fire far more often than the data changes, so this is the
     * floor. A branch switch and the refresh command both ignore it.
     */
    minIntervalMs: (): number => {
      const value = section().get<number>('refresh.minIntervalSeconds', 15);
      const seconds = Number.isFinite(value) ? Math.trunc(value) : 15;
      return Math.min(Math.max(seconds, 0), 600) * 1000;
    }
  },

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

  grafana: {
    enabled: (): boolean => section().get<boolean>('grafana.enabled', true),
    baseUrl: (): string => section().get<string>('grafana.baseUrl', '').replace(/\/+$/, ''),
    /** Repository name to PromQL label selector, e.g. `acme-web` -> `service=web`. */
    services: (): Record<string, string> =>
      section().get<Record<string, string>>('grafana.services', {}),
    /** Tried in order when a repository has no mapping of its own. */
    serviceLabels: (): string[] =>
      section()
        .get<string[]>('grafana.serviceLabels', ['service', 'app', 'job', 'namespace'])
        .filter((label) => Boolean(label?.trim())),
    latency: {
      datasourceUid: (): string => section().get<string>('grafana.latency.datasourceUid', ''),
      /** Which backend the query speaks: PromQL against Prometheus, or LogQL against Loki. */
      datasourceKind: (): 'prometheus' | 'loki' =>
        section().get<string>('grafana.latency.datasourceKind', 'prometheus') === 'loki'
          ? 'loki'
          : 'prometheus',
      // Empty means the built-in query, so the default only exists in one place.
      query: (): string =>
        section().get<string>('grafana.latency.query', '').trim() || DEFAULT_LATENCY_QUERY,
      window: (): string => section().get<string>('grafana.latency.window', '1h').trim() || '1h',
      limit: (): number => {
        const value = section().get<number>('grafana.latency.limit', 5);
        return Math.min(Math.max(Math.trunc(value) || 5, 1), 25);
      }
    }
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
    },
    reviewPromptTemplate: (): string =>
      section().get<string>('github.reviewPromptTemplate', '').trim() ||
      DEFAULT_REVIEW_PROMPT_TEMPLATE,
    updatePromptTemplate: (): string =>
      section().get<string>('github.updatePromptTemplate', '').trim() ||
      DEFAULT_UPDATE_PROMPT_TEMPLATE
  },

  onDidChange(listener: (e: vscode.ConfigurationChangeEvent) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devhub')) {
        listener(e);
      }
    });
  }
};
