import * as vscode from 'vscode';
import { config } from '../infra/Config';
import { log } from '../infra/Logger';
import { hostFor } from '../providers/github/endpoints';
import { dedupeRepos, parseGitHubRemote, repoSlug, type RepoRef } from '../providers/github/remoteUrl';
import { findTicketKey } from './ticketKeyResolver';

/** The single source of truth every view subscribes to. */
export interface WorkContext {
  ticketKey?: string;
  branch?: string;
  repoRoot?: string;
  /** Files changed against the merge-base with the default branch. */
  changedFiles: string[];
  pinned: boolean;
  /** The GitHub repository the active repo's origin points at. */
  githubRepo?: RepoRef;
  /**
   * Every GitHub repository open in the workspace, deduplicated. This is what
   * scopes the pull request queues: the user asked for their PRs across the
   * folders they actually have open, not across their whole account.
   */
  repos: RepoRef[];
}

const PIN_KEY = 'devhub.pins';

/** Stands in for the branch name when HEAD is detached. */
const DETACHED = '__detached__';

type Pins = Record<string, string>;

// Minimal shape of the built-in Git extension's API. Using it beats shelling
// out to `git`: no process spawn, and we get change events for free.
interface GitChange {
  uri: vscode.Uri;
}
interface GitRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}
interface GitRepositoryState {
  HEAD?: { name?: string; commit?: string };
  remotes: GitRemote[];
  workingTreeChanges: GitChange[];
  indexChanges: GitChange[];
  onDidChange: vscode.Event<void>;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
  getCommit(ref: string): Promise<{ message: string }>;
  getBranchBase?(name: string): Promise<{ commit?: string } | undefined>;
  diffWith(ref: string): Promise<GitChange[]>;
  createBranch(name: string, checkout: boolean): Promise<void>;
}
interface GitAPI {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}
interface GitExtension {
  getAPI(version: 1): GitAPI;
}

export class WorkContextService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<WorkContext>();
  readonly onDidChange = this._onDidChange.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoSubscriptions = new Map<string, vscode.Disposable>();
  private git?: GitAPI;
  private timer?: NodeJS.Timeout;

  private current: WorkContext = { changedFiles: [], pinned: false, repos: [] };

  constructor(private readonly memento: vscode.Memento) {}

  get context(): WorkContext {
    return this.current;
  }

  async activate(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) {
      log.warn('Built-in Git extension not found; ticket detection is limited to pinning');
      await this.recompute();
      return;
    }

    const exports = extension.isActive ? extension.exports : await extension.activate();
    this.git = exports.getAPI(1);

    for (const repo of this.git.repositories) {
      this.watch(repo);
    }
    this.disposables.push(
      this.git.onDidOpenRepository((repo) => {
        this.watch(repo);
        this.schedule();
      }),
      this.git.onDidCloseRepository((repo) => {
        this.repoSubscriptions.get(repo.rootUri.toString())?.dispose();
        this.repoSubscriptions.delete(repo.rootUri.toString());
        this.schedule();
      }),
      config.onDidChange(() => this.schedule())
    );

    await this.recompute();
  }

  /** Debounced: checking out a branch fires several state events in a row. */
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.recompute(), 500);
  }

  private watch(repo: GitRepository): void {
    const key = repo.rootUri.toString();
    if (this.repoSubscriptions.has(key)) {
      return;
    }
    this.repoSubscriptions.set(key, repo.state.onDidChange(() => this.schedule()));
  }

  async refresh(): Promise<void> {
    await this.recompute();
  }

  /**
   * Pins are per repository *and* per branch, not per workspace.
   *
   * One pin for the whole workspace goes wrong the moment you switch branches:
   * the ticket you pinned on the branch you left keeps overriding detection on
   * the branch you arrived at, and it wins over the branch name, so the wrong
   * ticket is sticky until you notice and unpin it.
   */
  private pinKeyFor(branch: string | undefined): string {
    return `${this.activeRepository?.rootUri.fsPath ?? ''}#${branch ?? DETACHED}`;
  }

  private pins(): Pins {
    return this.memento.get<Pins>(PIN_KEY, {});
  }

  async pin(key: string): Promise<void> {
    const pins = this.pins();
    pins[this.pinKeyFor(this.current.branch)] = key.toUpperCase();
    await this.memento.update(PIN_KEY, pins);
    await this.recompute();
  }

  async unpin(): Promise<void> {
    const pins = this.pins();
    delete pins[this.pinKeyFor(this.current.branch)];
    await this.memento.update(PIN_KEY, pins);
    await this.recompute();
  }

  get activeRepository(): GitRepository | undefined {
    if (!this.git || this.git.repositories.length === 0) {
      return undefined;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const match = this.git.repositories
        .filter((r) => active.fsPath.startsWith(r.rootUri.fsPath))
        .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
      if (match) {
        return match;
      }
    }
    return this.git.repositories[0];
  }

  async createBranch(name: string): Promise<void> {
    const repo = this.activeRepository;
    if (!repo) {
      throw new Error('No Git repository is open.');
    }
    await repo.createBranch(name, true);
    await this.recompute();
  }

  private async recompute(): Promise<void> {
    const repo = this.activeRepository;
    const branch = repo?.state.HEAD?.name;
    const pinnedKey = this.pins()[this.pinKeyFor(branch)];

    // Resolution order: pin wins, then branch name, then the last commit message.
    let ticketKey: string | undefined = pinnedKey;
    if (!ticketKey) {
      ticketKey = findTicketKey(branch);
    }
    if (!ticketKey && repo?.state.HEAD?.commit) {
      try {
        const commit = await repo.getCommit(repo.state.HEAD.commit);
        ticketKey = findTicketKey(commit.message);
      } catch {
        // Shallow clone or detached HEAD — not worth surfacing.
      }
    }

    const next: WorkContext = {
      ticketKey,
      branch,
      repoRoot: repo?.rootUri.fsPath,
      changedFiles: await this.collectChangedFiles(repo),
      pinned: Boolean(pinnedKey),
      githubRepo: this.detectGitHub(repo),
      repos: this.workspaceRepos()
    };

    const changed =
      next.ticketKey !== this.current.ticketKey ||
      next.branch !== this.current.branch ||
      next.repoRoot !== this.current.repoRoot ||
      next.pinned !== this.current.pinned ||
      next.changedFiles.join('|') !== this.current.changedFiles.join('|') ||
      this.repoList(next.repos) !== this.repoList(this.current.repos);

    this.current = next;
    await vscode.commands.executeCommand('setContext', 'devhub.pinned', next.pinned);
    await vscode.commands.executeCommand('setContext', 'devhub.hasTicket', Boolean(next.ticketKey));

    if (changed) {
      log.info(`Work context: ${next.ticketKey ?? 'no ticket'} on ${next.branch ?? 'no branch'}`);
      this._onDidChange.fire(next);
    }
  }

  /** `origin` if there is one, otherwise whatever remote the repo does have. */
  private detectGitHub(
    repo: GitRepository | undefined,
    hosts: string[] = this.hosts()
  ): RepoRef | undefined {
    const remotes = repo?.state.remotes ?? [];
    const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    return parseGitHubRemote(origin?.fetchUrl ?? origin?.pushUrl, hosts);
  }

  /**
   * Read from the Git extension rather than from `workspace.workspaceFolders`,
   * because the two are not the same list: a folder can contain several
   * repositories, a repository can be opened above or below its folder root,
   * and worktrees appear as their own entries. The Git extension has already
   * resolved all of that.
   */
  private workspaceRepos(): RepoRef[] {
    const hosts = this.hosts();
    const found = (this.git?.repositories ?? [])
      .map((repo) => this.detectGitHub(repo, hosts))
      .filter((ref): ref is RepoRef => Boolean(ref));
    return dedupeRepos(found);
  }

  private hosts(): string[] {
    return [hostFor(config.github.baseUrl())];
  }

  private repoList(repos: readonly RepoRef[]): string {
    return repos.map(repoSlug).join('|');
  }

  private async collectChangedFiles(repo: GitRepository | undefined): Promise<string[]> {
    if (!repo) {
      return [];
    }
    const files = new Set<string>();
    for (const change of [...repo.state.workingTreeChanges, ...repo.state.indexChanges]) {
      files.add(change.uri.fsPath);
    }

    // Committed-but-unmerged work matters just as much as the dirty tree.
    try {
      const base = await repo.getBranchBase?.(repo.state.HEAD?.name ?? '');
      if (base?.commit) {
        for (const change of await repo.diffWith(base.commit)) {
          files.add(change.uri.fsPath);
        }
      }
    } catch {
      // getBranchBase is unavailable on older Git extension versions.
    }

    return [...files];
  }

  dispose(): void {
    clearTimeout(this.timer);
    this._onDidChange.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.repoSubscriptions.forEach((d) => d.dispose());
  }
}
