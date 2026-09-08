import type * as vscode from 'vscode';
import { http } from '../../infra/HttpClient';

export interface SentryFrame {
  filename?: string;
  function?: string;
  lineNo?: number;
  colNo?: number;
  in_app?: boolean;
  context?: [number, string][];
}

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  count: number;
  userCount: number;
  permalink: string;
  project: string;
  lastSeen: string;
  /** Populated lazily from the latest event. */
  frames?: SentryFrame[];
}

interface RawIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  count: string | number;
  userCount: number;
  permalink: string;
  lastSeen: string;
  project?: { slug: string };
}

interface RawEvent {
  entries?: {
    type: string;
    data?: { values?: { stacktrace?: { frames?: SentryFrame[] } }[]; frames?: SentryFrame[] };
  }[];
}

export class SentryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly organization: string,
    private readonly token: string
  ) {}

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private api(path: string): string {
    return `${this.baseUrl}/api/0${path}`;
  }

  async listIssues(
    project: string,
    query: string,
    limit = 25,
    token?: vscode.CancellationToken
  ): Promise<SentryIssue[]> {
    const url = this.api(
      `/projects/${encodeURIComponent(this.organization)}/${encodeURIComponent(project)}/issues/` +
        `?query=${encodeURIComponent(query)}&limit=${limit}&statsPeriod=14d`
    );
    const raw = await http.json<RawIssue[]>(url, { headers: this.headers, token });
    return (raw ?? []).map((issue) => ({
      id: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      culprit: issue.culprit,
      level: issue.level,
      count: Number(issue.count) || 0,
      userCount: issue.userCount ?? 0,
      permalink: issue.permalink,
      project: issue.project?.slug ?? project,
      lastSeen: issue.lastSeen
    }));
  }

  /** The latest event is where the stack trace lives — the issue itself has none. */
  async getLatestFrames(issueId: string, token?: vscode.CancellationToken): Promise<SentryFrame[]> {
    const event = await http.json<RawEvent>(
      this.api(`/issues/${encodeURIComponent(issueId)}/events/latest/`),
      { headers: this.headers, token }
    );

    const entry = event.entries?.find((e) => e.type === 'exception' || e.type === 'stacktrace');
    if (!entry) {
      return [];
    }

    const frames =
      entry.data?.values?.flatMap((v) => v.stacktrace?.frames ?? []) ?? entry.data?.frames ?? [];

    // Sentry returns frames outermost-first; the throw site is last.
    return [...frames].reverse();
  }

  async verify(token?: vscode.CancellationToken): Promise<string> {
    const org = await http.json<{ name: string }>(
      this.api(`/organizations/${encodeURIComponent(this.organization)}/`),
      { headers: this.headers, token }
    );
    return org.name;
  }

  async listProjects(token?: vscode.CancellationToken): Promise<string[]> {
    const projects = await http.json<{ slug: string }[]>(
      this.api(`/organizations/${encodeURIComponent(this.organization)}/projects/`),
      { headers: this.headers, token }
    );
    return (projects ?? []).map((p) => p.slug);
  }
}
