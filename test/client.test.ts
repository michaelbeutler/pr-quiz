import { describe, expect, it } from 'vitest';
import { RestGitHub } from '../src/github/client.ts';

/** RestGitHub against canned responses keyed by path, recording every request. */
function client(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body });
    const route = Object.keys(routes).find((path) => url.includes(path));
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const value = routes[route];
    const data = typeof value === 'function' ? (value as (b: any) => unknown)(body) : value;
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { gh: new RestGitHub({ token: 't', owner: 'acme', repo: 'shop', fetchImpl, sleepImpl: async () => {} }), calls };
}

describe('RestGitHub', () => {
  it('reads comment edit history with revision bodies, pruned revisions and pagination', async () => {
    const pages = [
      {
        data: {
          node: {
            userContentEdits: {
              pageInfo: { hasNextPage: true, endCursor: 'c1' },
              nodes: [
                { editedAt: '2', deletedAt: null, diff: 'body v2', editor: { login: 'alice', __typename: 'User' } },
                { editedAt: '1', deletedAt: '3', diff: 'body v1', editor: { login: 'github-actions', __typename: 'Bot' } },
              ],
            },
          },
        },
      },
      {
        data: {
          node: {
            userContentEdits: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ editedAt: '0', deletedAt: null, diff: 'body v0', editor: null }],
            },
          },
        },
      },
    ];
    let page = 0;
    const { gh, calls } = client({ '/graphql': () => pages[page++] });
    const history = await gh.getCommentEdits('IC_1');
    expect(history.complete).toBe(true);
    expect(history.edits).toEqual([
      { editor: 'alice', isBot: false, editedAt: '2', body: 'body v2' },
      { editor: 'github-actions', isBot: true, editedAt: '1', body: null },
      { editor: null, isBot: false, editedAt: '0', body: 'body v0' },
    ]);
    expect(calls[1]!.body.variables).toEqual({ id: 'IC_1', after: 'c1' });
  });

  it('reports an edit history that is too long to read completely', async () => {
    const { gh } = client({
      '/graphql': {
        data: { node: { userContentEdits: { pageInfo: { hasNextPage: true, endCursor: 'x' }, nodes: [] } } },
      },
    });
    expect((await gh.getCommentEdits('IC_1')).complete).toBe(false);
  });

  it('reads the edit history of reviews like comments', async () => {
    const { gh, calls } = client({
      '/graphql': {
        data: {
          node: {
            userContentEdits: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ editedAt: '1', deletedAt: null, diff: 'review v1', editor: { login: 'alice', __typename: 'User' } }],
            },
          },
        },
      },
    });
    expect((await gh.getCommentEdits('PRR_1')).edits).toEqual([{ editor: 'alice', isBot: false, editedAt: '1', body: 'review v1' }]);
    expect(calls[0]!.body.query).toContain('... on IssueComment');
    expect(calls[0]!.body.query).toContain('... on PullRequestReview');
  });

  it('updates a review body', async () => {
    const { gh, calls } = client({ '/pulls/7/reviews/9': { id: 9, body: 'restored' } });
    expect((await gh.updateReview(7, 9, 'restored')).id).toBe(9);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'https://api.github.com/repos/acme/shop/pulls/7/reviews/9', body: { body: 'restored' } });
  });

  it('lists reviews edited after submission', async () => {
    const page = (hasNextPage: boolean, endCursor: string | null, nodes: unknown[]) => ({
      data: { repository: { pullRequest: { reviews: { pageInfo: { hasNextPage, endCursor }, nodes } } } },
    });
    const pages = [
      page(true, 'r1', [
        { databaseId: 11, lastEditedAt: '2026-09-30T12:00:00Z' },
        { databaseId: 12, lastEditedAt: null },
      ]),
      page(false, null, [{ databaseId: 13, lastEditedAt: '2026-09-30T12:01:00Z' }, null]),
    ];
    let n = 0;
    const { gh, calls } = client({ '/graphql': () => pages[n++] });
    expect(await gh.listEditedReviewIds(7)).toEqual(new Set([11, 13]));
    expect(calls[0]!.body.variables).toEqual({ owner: 'acme', repo: 'shop', pr: 7, after: null });
    expect(calls[1]!.body.variables).toEqual({ owner: 'acme', repo: 'shop', pr: 7, after: 'r1' });

    const missing = client({ '/graphql': { data: { repository: { pullRequest: null } } } });
    await expect(missing.gh.listEditedReviewIds(7)).rejects.toThrow(/no pull request #7/);
    const endless = client({ '/graphql': page(true, 'more', []) });
    await expect(endless.gh.listEditedReviewIds(7)).rejects.toThrow(/more than 5000 reviews/);
  });

  it('judges write access by push permission, so custom roles work', async () => {
    const { gh } = client({
      '/collaborators/senior/permission': { permission: 'write', role_name: 'senior-dev', user: { permissions: { push: true } } },
      '/collaborators/viewer/permission': { permission: 'read', role_name: 'viewer-plus', user: { permissions: { push: false } } },
      '/collaborators/legacy/permission': { permission: 'admin', role_name: 'admin' },
    });
    expect(await gh.hasWriteAccess('senior')).toBe(true);
    expect(await gh.hasWriteAccess('viewer')).toBe(false);
    expect(await gh.hasWriteAccess('legacy')).toBe(true);
    expect(await gh.hasWriteAccess('stranger')).toBe(false); // 404
  });

  it('lists commit authors and committers of a pull request', async () => {
    const { gh } = client({
      '/pulls/7/commits': [
        { author: { login: 'dev' }, committer: { login: 'web-flow' } },
        { author: null, committer: { login: 'bob' } },
        // "Update branch" merges the base branch in; that doesn't make the clicker an author.
        { author: { login: 'maintainer' }, committer: { login: 'web-flow' }, parents: [{ sha: 'a' }, { sha: 'b' }] },
      ],
    });
    expect((await gh.listCommitters(7)).sort()).toEqual(['bob', 'dev', 'web-flow']);
  });

  it('retries transient server errors', async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      return attempts < 3
        ? new Response('oops', { status: 502 })
        : new Response(JSON.stringify({ number: 7 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const gh = new RestGitHub({ token: 't', owner: 'acme', repo: 'shop', fetchImpl, sleepImpl: async () => {} });
    expect((await gh.getPull(7)).number).toBe(7);
    expect(attempts).toBe(3);
  });
});
