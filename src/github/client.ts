import { setTimeout as sleep } from 'node:timers/promises';
import {
  GitHubError,
  type CommentHistory,
  type CommitStatus,
  type ContentEdit,
  type GitHubApi,
  type IssueComment,
  type PullFile,
  type PullRequest,
  type Review,
  type ReviewEvent,
} from './types.ts';

export interface RestGitHubOptions {
  token: string;
  owner: string;
  repo: string;
  apiUrl?: string;
  graphqlUrl?: string;
  fetchImpl?: typeof fetch;
  /** Used between retries; injectable for tests. */
  sleepImpl?: (ms: number) => Promise<unknown>;
}

const MAX_RETRIES = 3;
/** 20 pages of 50 revisions; longer histories are reported as incomplete. */
const MAX_EDIT_PAGES = 20;

/** Small fetch-based GitHub client (REST + GraphQL) with pagination and retries for transient errors. */
export class RestGitHub implements GitHubApi {
  private readonly opts: RestGitHubOptions;
  private readonly apiUrl: string;
  private readonly graphqlUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<unknown>;

  constructor(opts: RestGitHubOptions) {
    this.opts = opts;
    this.apiUrl = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.graphqlUrl = opts.graphqlUrl ?? `${this.apiUrl}/graphql`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
  }

  private get repoPath(): string {
    return `/repos/${encodeURIComponent(this.opts.owner)}/${encodeURIComponent(this.opts.repo)}`;
  }

  private async request<T>(
    method: string,
    pathOrUrl: string,
    body?: unknown,
    accept = 'application/vnd.github+json',
  ): Promise<{ data: T; headers: Headers }> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.apiUrl}${pathOrUrl}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            accept,
            authorization: `Bearer ${this.opts.token}`,
            'x-github-api-version': '2022-11-28',
            'user-agent': 'pr-quiz-action',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt < MAX_RETRIES) {
          await this.sleepImpl(1000 * 2 ** attempt);
          continue;
        }
        throw error;
      }

      if (res.ok) {
        if (res.status === 204) return { data: undefined as T, headers: res.headers };
        const text = await res.text();
        const isJson = (res.headers.get('content-type') ?? '').includes('json') && !accept.includes('raw');
        return { data: (isJson && text ? JSON.parse(text) : text) as T, headers: res.headers };
      }

      const text = await res.text();
      const waitMs = this.retryDelay(res, attempt);
      if (waitMs !== null && attempt < MAX_RETRIES) {
        await this.sleepImpl(waitMs);
        continue;
      }
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; errors?: unknown };
        message = [parsed.message, parsed.errors ? JSON.stringify(parsed.errors) : ''].filter(Boolean).join(' ');
      } catch {
        // keep raw text
      }
      throw new GitHubError(`GitHub ${method} ${url.replace(this.apiUrl, '')} failed with ${res.status}: ${message}`, res.status, text);
    }
  }

  /** Delay before retrying, or null when the failure is not transient. */
  private retryDelay(res: Response, attempt: number): number | null {
    const retryAfter = Number(res.headers.get('retry-after'));
    if (res.status === 429 || (res.status === 403 && (retryAfter > 0 || res.headers.get('x-ratelimit-remaining') === '0'))) {
      if (retryAfter > 0) return retryAfter <= 60 ? retryAfter * 1000 : null;
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
      if (reset > 0 && reset <= 60_000) return reset + 1000;
      return res.status === 429 ? 2000 * 2 ** attempt : null;
    }
    if (res.status >= 500) return 1000 * 2 ** attempt;
    return null;
  }

  private async paginate<T>(path: string, maxPages = 50): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    for (let page = 0; next && page < maxPages; page++) {
      const { data, headers }: { data: T[]; headers: Headers } = await this.request<T[]>('GET', next);
      items.push(...data);
      next = /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') ?? '')?.[1] ?? null;
    }
    return items;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { data } = await this.request<{ data?: T; errors?: Array<{ message: string }> }>('POST', this.graphqlUrl, {
      query,
      variables,
    });
    if (data.errors?.length) throw new GitHubError(`GitHub GraphQL error: ${data.errors.map((e) => e.message).join('; ')}`, 200);
    return data.data as T;
  }

  async getPull(pr: number): Promise<PullRequest> {
    return (await this.request<PullRequest>('GET', `${this.repoPath}/pulls/${pr}`)).data;
  }

  listReviews(pr: number): Promise<Review[]> {
    return this.paginate<Review>(`${this.repoPath}/pulls/${pr}/reviews`);
  }

  listComments(pr: number): Promise<IssueComment[]> {
    return this.paginate<IssueComment>(`${this.repoPath}/issues/${pr}/comments`);
  }

  listFiles(pr: number): Promise<PullFile[]> {
    return this.paginate<PullFile>(`${this.repoPath}/pulls/${pr}/files`, 30);
  }

  async getFileText(path: string, ref: string): Promise<string | null> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    try {
      const { data } = await this.request<string>(
        'GET',
        `${this.repoPath}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
        undefined,
        'application/vnd.github.raw+json',
      );
      return typeof data === 'string' ? data : null;
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 404 || error.status === 403)) return null;
      throw error;
    }
  }

  async createComment(pr: number, body: string): Promise<IssueComment> {
    return (await this.request<IssueComment>('POST', `${this.repoPath}/issues/${pr}/comments`, { body })).data;
  }

  async updateComment(commentId: number, body: string): Promise<IssueComment> {
    return (await this.request<IssueComment>('PATCH', `${this.repoPath}/issues/comments/${commentId}`, { body })).data;
  }

  async createReview(pr: number, event: ReviewEvent, body: string, commitId: string): Promise<Review> {
    return (
      await this.request<Review>('POST', `${this.repoPath}/pulls/${pr}/reviews`, { event, body, commit_id: commitId })
    ).data;
  }

  async dismissReview(pr: number, reviewId: number, message: string): Promise<void> {
    await this.request('PUT', `${this.repoPath}/pulls/${pr}/reviews/${reviewId}/dismissals`, {
      message,
      event: 'DISMISS',
    });
  }

  async requestReviewers(pr: number, logins: string[]): Promise<void> {
    await this.request('POST', `${this.repoPath}/pulls/${pr}/requested_reviewers`, { reviewers: logins });
  }

  async setStatus(sha: string, status: CommitStatus): Promise<void> {
    await this.request('POST', `${this.repoPath}/statuses/${sha}`, {
      ...status,
      description: status.description.length > 140 ? status.description.slice(0, 139) + '…' : status.description,
    });
  }

  async getStatus(sha: string, context: string): Promise<CommitStatus | null> {
    // Newest first; one page is plenty because GitHub keeps every status ever posted but we only need the latest.
    const { data } = await this.request<Array<CommitStatus & { target_url: string | null }>>(
      'GET',
      `${this.repoPath}/commits/${sha}/statuses?per_page=100`,
    );
    const latest = data.find((s) => s.context === context);
    return latest
      ? { state: latest.state, context: latest.context, description: latest.description ?? '', target_url: latest.target_url ?? undefined }
      : null;
  }

  async getCommentEdits(commentNodeId: string): Promise<CommentHistory> {
    // `diff` holds the full body of each revision (verified against GitHub), `deletedAt` marks pruned revisions.
    const query = `query($id: ID!, $after: String) {
      node(id: $id) {
        ... on IssueComment {
          userContentEdits(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { editedAt deletedAt diff editor { login __typename } }
          }
        }
      }
    }`;
    type Page = {
      node: {
        userContentEdits?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            editedAt: string;
            deletedAt: string | null;
            diff: string | null;
            editor: { login: string; __typename: string } | null;
          } | null>;
        };
      } | null;
    };
    const edits: ContentEdit[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_EDIT_PAGES; page++) {
      const data: Page = await this.graphql<Page>(query, { id: commentNodeId, after });
      const connection = data.node?.userContentEdits;
      if (!connection) return { edits, complete: true };
      for (const node of connection.nodes) {
        if (!node) continue;
        edits.push({
          editor: node.editor ? node.editor.login.replace(/\[bot\]$/i, '') : null,
          isBot: node.editor?.__typename === 'Bot',
          editedAt: node.editedAt,
          body: node.deletedAt ? null : node.diff,
        });
      }
      if (!connection.pageInfo.hasNextPage) return { edits, complete: true };
      after = connection.pageInfo.endCursor;
    }
    return { edits, complete: false };
  }

  async hasWriteAccess(login: string): Promise<boolean> {
    try {
      const { data } = await this.request<{ permission?: string; user?: { permissions?: { push?: boolean } } }>(
        'GET',
        `${this.repoPath}/collaborators/${encodeURIComponent(login)}/permission`,
      );
      // `role_name` can be a custom role; `permission` / `permissions.push` reflect its base role.
      return data.user?.permissions?.push ?? (data.permission === 'admin' || data.permission === 'write');
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  }

  async listCommitters(pr: number): Promise<string[]> {
    const commits = await this.paginate<{
      author: { login: string } | null;
      committer: { login: string } | null;
      parents?: unknown[];
    }>(`${this.repoPath}/pulls/${pr}/commits`, 3);
    const logins = new Set<string>();
    for (const commit of commits) {
      // Merging the base branch in (e.g. "Update branch") brings in other people's work, not your own.
      if ((commit.parents?.length ?? 1) > 1) continue;
      if (commit.author?.login) logins.add(commit.author.login);
      if (commit.committer?.login) logins.add(commit.committer.login);
    }
    return [...logins];
  }

  async addReaction(commentId: number, content: '+1' | 'eyes' | 'confused' | 'rocket'): Promise<void> {
    await this.request('POST', `${this.repoPath}/issues/comments/${commentId}/reactions`, { content });
  }
}
