import type * as vscode from 'vscode';
import { http } from '../../infra/HttpClient';
import { graphqlEndpoint } from './endpoints';
import type { RepoRef } from './remoteUrl';
import {
  checkRunStatus,
  reviewDecisionFrom,
  summaryFromApi,
  type ApiPullNode,
  type PullSummary,
  type ReviewDecision
} from './pullStatus';
import { buildPullSearch, withinScope } from './searchQuery';

/** The pull request for the checked-out branch, with its review detail. */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged' | 'draft';
  author: string;
  headSha: string;
  reviewDecision: ReviewDecision;
  reviewComments: number;
  checks: { name: string; status: 'pending' | 'success' | 'failure' | 'neutral'; url: string }[];
  comments: {
    id: number;
    author: string;
    body: string;
    path?: string;
    line?: number;
    url: string;
    createdAt: string;
  }[];
  updatedAt: string;
}

export interface PullQueues {
  viewer: string;
  mine: PullSummary[];
  reviewRequested: PullSummary[];
  /** True when a repo scope had to be applied to the response instead of the query. */
  filteredClientSide: boolean;
}

interface RawPull {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  user?: { login?: string } | null;
  head: { sha: string };
  review_comments?: number;
  updated_at: string;
}

const PULL_FIELDS = `
  number
  title
  url
  isDraft
  createdAt
  updatedAt
  additions
  deletions
  mergeable
  reviewDecision
  author { login }
  repository { nameWithOwner }
  viewerLatestReview { state }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

const QUEUES_QUERY = `
query DevHubPullQueues($mine: String!, $review: String!, $first: Int!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: $first) {
    nodes { ... on PullRequest { ${PULL_FIELDS} } }
  }
  review: search(query: $review, type: ISSUE, first: $first) {
    nodes { ... on PullRequest { ${PULL_FIELDS} } }
  }
}`;

interface GraphResponse {
  data?: {
    viewer?: { login?: string };
    mine?: { nodes?: (ApiPullNode | null)[] | null };
    review?: { nodes?: (ApiPullNode | null)[] | null };
  };
  errors?: { message: string }[];
}

export class GitHubClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  /**
   * The pull request for one branch. `state=all` because a just-merged PR is
   * still the thing the user is looking at, and an open one is preferred when
   * the branch has been reused.
   */
  async findPullForBranch(
    owner: string,
    repo: string,
    branch: string,
    token?: vscode.CancellationToken
  ): Promise<PullRequest | undefined> {
    const pulls = await http.json<RawPull[]>(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(
        `${owner}:${branch}`
      )}&state=all&per_page=5`,
      { headers: this.headers, token }
    );
    const pull = pulls?.find((p) => p.state === 'open') ?? pulls?.[0];
    if (!pull) {
      return undefined;
    }

    // One slow call per aspect, but they are independent: a repo with checks
    // disabled shouldn't cost us the reviews.
    const [reviews, checks, comments] = await Promise.all([
      http
        .json<{ state: string; submitted_at: string; user?: { login?: string } }[]>(
          `${this.baseUrl}/repos/${owner}/${repo}/pulls/${pull.number}/reviews?per_page=100`,
          { headers: this.headers, token }
        )
        .catch(() => []),
      http
        .json<{ check_runs?: { name: string; status: string; conclusion?: string | null; html_url: string }[] }>(
          `${this.baseUrl}/repos/${owner}/${repo}/commits/${pull.head.sha}/check-runs?per_page=50`,
          { headers: this.headers, token }
        )
        .catch(() => ({ check_runs: [] })),
      http
        .json<
          {
            id: number;
            user?: { login?: string };
            body: string;
            path?: string;
            line?: number | null;
            html_url: string;
            created_at: string;
          }[]
        >(`${this.baseUrl}/repos/${owner}/${repo}/pulls/${pull.number}/comments?per_page=100`, {
          headers: this.headers,
          token
        })
        .catch(() => [])
    ]);

    return {
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      state: pull.merged_at ? 'merged' : pull.draft ? 'draft' : (pull.state as 'open' | 'closed'),
      author: pull.user?.login ?? 'unknown',
      headSha: pull.head.sha,
      reviewDecision: reviewDecisionFrom(reviews ?? []),
      reviewComments: pull.review_comments ?? 0,
      checks: (checks.check_runs ?? []).map((run) => ({
        name: run.name,
        status: checkRunStatus(run),
        url: run.html_url
      })),
      comments: (comments ?? []).map((c) => ({
        id: c.id,
        author: c.user?.login ?? 'unknown',
        body: c.body,
        path: c.path,
        line: c.line ?? undefined,
        url: c.html_url,
        createdAt: c.created_at
      })),
      updatedAt: pull.updated_at
    };
  }

  /**
   * Both queues in a single GraphQL request.
   *
   * REST can't do this: its search results carry neither `mergeable` nor
   * `reviewDecision`, so a conflict badge would cost one extra request per pull
   * request and still be wrong until GitHub finished computing mergeability.
   */
  async pullQueues(
    repos: readonly RepoRef[],
    limit: number,
    token?: vscode.CancellationToken
  ): Promise<PullQueues> {
    const mineSearch = buildPullSearch('is:pr is:open author:@me', repos);
    const reviewSearch = buildPullSearch('is:pr is:open review-requested:@me', repos);

    const response = await http.json<GraphResponse>(graphqlEndpoint(this.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json'
      },
      body: {
        query: QUEUES_QUERY,
        variables: { mine: mineSearch.query, review: reviewSearch.query, first: limit }
      },
      token
    });

    // GraphQL answers 200 with an `errors` array, so a bad token or a missing
    // scope arrives looking like success unless it is checked here.
    if (response.errors?.length) {
      throw new Error(response.errors.map((e) => e.message).join('; '));
    }

    const read = (nodes: (ApiPullNode | null)[] | null | undefined): PullSummary[] =>
      (nodes ?? []).filter((n): n is ApiPullNode => Boolean(n?.number)).map(summaryFromApi);

    return {
      viewer: response.data?.viewer?.login ?? '',
      mine: withinScope(read(response.data?.mine?.nodes), mineSearch.allow),
      reviewRequested: withinScope(read(response.data?.review?.nodes), reviewSearch.allow),
      filteredClientSide: mineSearch.filteredClientSide || reviewSearch.filteredClientSide
    };
  }

  async verify(token?: vscode.CancellationToken): Promise<string> {
    const user = await http.json<{ login: string }>(`${this.baseUrl}/user`, {
      headers: this.headers,
      token
    });
    return user.login;
  }
}
