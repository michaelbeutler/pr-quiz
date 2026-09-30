// In-memory stand-ins for GitHub and Claude, used by the tests and by scripts/simulate.ts.
import { createHash } from 'node:crypto';
import { DEFAULT_IGNORE_PATHS, type Config } from '../src/config.ts';
import {
  GitHubError,
  loginsEqual,
  type CommentHistory,
  type CommitStatus,
  type ContentEdit,
  type GitHubApi,
  type IssueComment,
  type PullFile,
  type PullRequest,
  type Review,
  type ReviewEvent,
} from '../src/github/types.ts';
import type { LlmBackend, StructuredRequest, StructuredResponse } from '../src/llm/backend.ts';
import { GENERATION_SCHEMA } from '../src/llm/generator.ts';

export const REPO = 'acme/shop';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    githubToken: 'test-token',
    anthropicApiKey: 'test-key',
    model: 'fake-model',
    effort: 'high',
    questionCount: 3,
    optionCount: 4,
    verifyQuestions: true,
    requireAllApprovers: true,
    maxAttempts: 5,
    submitReviews: true,
    statusContext: 'pr-quiz',
    command: '/pr-quiz',
    ignorePaths: [...DEFAULT_IGNORE_PATHS],
    maxDiffChars: 200_000,
    includeFileContext: true,
    extraInstructions: '',
    stateSecret: 'test-secret',
    claudeCodeVersion: 'stable',
    ...overrides,
  };
}

interface StoredComment extends IssueComment {
  /** Newest first, like GitHub's userContentEdits. */
  edits: ContentEdit[];
}

export const sampleFiles = (variant = 1): PullFile[] => [
  {
    filename: 'src/cart.ts',
    status: 'modified',
    additions: 12,
    deletions: 3,
    changes: 15,
    patch: `@@ -10,6 +10,15 @@ export function total(items: Item[]) {\n-  return items.reduce((s, i) => s + i.price, 0);\n+  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);\n+  return applyDiscount(subtotal, ${variant * 10});\n`,
  },
  {
    filename: 'package-lock.json',
    status: 'modified',
    additions: 400,
    deletions: 380,
    changes: 780,
    patch: '@@ -1 +1 @@\n-"lockfileVersion": 2\n+"lockfileVersion": 3\n',
  },
];

export class FakeGitHub implements GitHubApi {
  readonly botLogin: string;
  pr: PullRequest;
  reviews: Review[] = [];
  comments: StoredComment[] = [];
  files: PullFile[];
  statuses: Array<CommitStatus & { sha: string }> = [];
  requested: string[] = [];
  reactions: Array<{ commentId: number; content: string }> = [];
  permissions = new Map<string, string>();
  /** GitHub users who authored or committed commits of the pull request. */
  committers = new Set<string>(['author']);
  fileContents = new Map<string, string>();
  /** Mirrors "Allow GitHub Actions to create and approve pull requests". */
  botMayApprove = true;
  /** Mirrors "Restrict who can dismiss pull request reviews" excluding the bot. */
  botMayDismiss = true;
  failEditHistory = false;
  private nextId = 100;
  private tick = 0;

  constructor(options: { author?: string; botLogin?: string; files?: PullFile[] } = {}) {
    this.botLogin = options.botLogin ?? 'github-actions[bot]';
    this.files = options.files ?? sampleFiles();
    this.pr = {
      number: 7,
      state: 'open',
      title: 'Apply quantity and discount in cart total',
      body: 'Cart totals now respect item quantity and the 10% discount.',
      html_url: `https://github.com/${REPO}/pull/7`,
      user: { login: options.author ?? 'author', type: 'User' },
      head: { sha: 'a'.repeat(40), ref: 'feature/discount', repo: { full_name: REPO } },
      base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: REPO, id: 4242 } },
    };
  }

  private time(): string {
    return new Date(Date.UTC(2026, 8, 30, 12, 0, this.tick++)).toISOString();
  }

  private botActor() {
    return { login: this.botLogin, type: 'Bot' };
  }

  private comment(id: number): StoredComment {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) throw new GitHubError(`comment ${id} not found`, 404);
    return comment;
  }

  /** Replaces a comment body the way GitHub does, recording the revision (with its full body) in the history. */
  private edit(comment: StoredComment, body: string, editor: string, isBot: boolean): void {
    if (comment.edits.length === 0) {
      // GitHub records the original version as the oldest entry on the first edit.
      comment.edits.unshift({
        editor: comment.user!.login.replace(/\[bot\]$/, ''),
        isBot: comment.user!.type === 'Bot',
        editedAt: comment.created_at,
        body: comment.body,
      });
    }
    comment.body = body;
    comment.updated_at = this.time();
    comment.edits.unshift({ editor: editor.replace(/\[bot\]$/, ''), isBot, editedAt: comment.updated_at, body });
  }

  // --- GitHubApi -------------------------------------------------------------------------------------------------

  async getPull(): Promise<PullRequest> {
    return structuredClone(this.pr);
  }
  async listReviews(): Promise<Review[]> {
    return structuredClone(this.reviews);
  }
  async listComments(): Promise<IssueComment[]> {
    return structuredClone(this.comments.map(({ edits: _edits, ...c }) => c));
  }
  async listFiles(): Promise<PullFile[]> {
    return structuredClone(this.files);
  }
  async getFileText(path: string): Promise<string | null> {
    return this.fileContents.get(path) ?? null;
  }
  async createComment(_pr: number, body: string): Promise<IssueComment> {
    const id = this.nextId++;
    const now = this.time();
    const comment: StoredComment = {
      id,
      node_id: `IC_${id}`,
      user: this.botActor(),
      body,
      html_url: `${this.pr.html_url}#issuecomment-${id}`,
      created_at: now,
      updated_at: now,
      edits: [],
    };
    this.comments.push(comment);
    return structuredClone({ ...comment, edits: undefined }) as IssueComment;
  }
  async updateComment(commentId: number, body: string): Promise<IssueComment> {
    const comment = this.comment(commentId);
    this.edit(comment, body, this.botLogin, true);
    return structuredClone({ ...comment, edits: undefined }) as IssueComment;
  }
  async createReview(_pr: number, event: ReviewEvent, body: string, commitId: string): Promise<Review> {
    if (event === 'APPROVE' && !this.botMayApprove) {
      throw new GitHubError('GitHub Actions is not permitted to approve pull requests.', 422);
    }
    const state = event === 'APPROVE' ? 'APPROVED' : event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED';
    const review: Review = { id: this.nextId++, user: this.botActor(), state, body, commit_id: commitId, submitted_at: this.time() };
    this.reviews.push(review);
    return structuredClone(review);
  }
  async dismissReview(_pr: number, reviewId: number): Promise<void> {
    if (!this.botMayDismiss) throw new GitHubError('Must have admin rights to dismiss reviews.', 403);
    const review = this.reviews.find((r) => r.id === reviewId);
    if (!review) throw new GitHubError('review not found', 404);
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED') throw new GitHubError('cannot dismiss', 422);
    review.state = 'DISMISSED';
  }
  async requestReviewers(_pr: number, logins: string[]): Promise<void> {
    this.requested.push(...logins);
  }
  async setStatus(sha: string, status: CommitStatus): Promise<void> {
    this.statuses.push({ sha, ...status });
  }
  async getStatus(sha: string, context: string): Promise<CommitStatus | null> {
    return this.statuses.filter((s) => s.sha === sha && s.context === context).at(-1) ?? null;
  }
  async getCommentEdits(nodeId: string): Promise<CommentHistory> {
    if (this.failEditHistory) throw new GitHubError('GraphQL unavailable', 502);
    const comment = this.comments.find((c) => c.node_id === nodeId);
    return { edits: structuredClone(comment?.edits ?? []), complete: true };
  }
  async hasWriteAccess(login: string): Promise<boolean> {
    // Unknown users are collaborators with write access; custom roles based on write can push too.
    return !['read', 'triage', 'none'].includes(this.permissions.get(login) ?? 'write');
  }
  async listCommitters(): Promise<string[]> {
    return [...this.committers];
  }
  async addReaction(commentId: number, content: '+1' | 'eyes' | 'confused' | 'rocket'): Promise<void> {
    this.reactions.push({ commentId, content });
  }

  // --- Simulated humans ---------------------------------------------------------------------------------------

  approve(login: string, association = 'COLLABORATOR'): Review {
    const review: Review = {
      id: this.nextId++,
      user: { login, type: 'User' },
      state: 'APPROVED',
      body: 'LGTM',
      commit_id: this.pr.head.sha,
      submitted_at: this.time(),
      author_association: association,
    };
    this.reviews.push(review);
    return review;
  }

  requestChanges(login: string): Review {
    const review: Review = {
      id: this.nextId++,
      user: { login, type: 'User' },
      state: 'CHANGES_REQUESTED',
      body: 'Wait, this breaks refunds.',
      commit_id: this.pr.head.sha,
      submitted_at: this.time(),
      author_association: 'COLLABORATOR',
    };
    this.reviews.push(review);
    return review;
  }

  /** A human posts a comment (e.g. the /pr-quiz command). */
  say(login: string, body: string): IssueComment {
    const id = this.nextId++;
    const now = this.time();
    const comment: StoredComment = {
      id,
      node_id: `IC_${id}`,
      user: { login, type: 'User' },
      body,
      html_url: `${this.pr.html_url}#issuecomment-${id}`,
      created_at: now,
      updated_at: now,
      edits: [],
    };
    this.comments.push(comment);
    return comment;
  }

  /** Toggles the n-th checkbox of a comment like GitHub's task list UI does, as the given user. */
  toggleCheckbox(login: string, commentId: number, index: number): void {
    const comment = this.comment(commentId);
    const lines = comment.body.split(/\r?\n/);
    let seen = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*[-*+]\s+\[[ xX]\]/.test(lines[i]!)) continue;
      if (++seen !== index) continue;
      lines[i] = lines[i]!.includes('[ ]') ? lines[i]!.replace('[ ]', '[x]') : lines[i]!.replace(/\[[xX]\]/, '[ ]');
      // The web UI saves with CRLF line endings.
      this.edit(comment, lines.join('\r\n'), login, false);
      return;
    }
    throw new Error(`checkbox ${index} not found in comment ${commentId}`);
  }

  /** Someone with write access edits the raw markdown of a comment (the "Edit" menu). */
  editBody(login: string, commentId: number, body: string, isBot = false): void {
    this.edit(this.comment(commentId), body, login, isBot);
  }

  /** Someone with write access deletes a revision's content from the edit history. */
  pruneRevision(commentId: number, which: (edit: ContentEdit, index: number) => boolean): void {
    for (const [index, edit] of this.comment(commentId).edits.entries()) if (which(edit, index)) edit.body = null;
  }

  /** Any workflow using GITHUB_TOKEN posts as github-actions[bot], just like the quiz bot. */
  postAsBot(body: string): StoredComment {
    const id = this.nextId++;
    const now = this.time();
    const comment: StoredComment = {
      id,
      node_id: `IC_${id}`,
      user: this.botActor(),
      body,
      html_url: `${this.pr.html_url}#issuecomment-${id}`,
      created_at: now,
      updated_at: now,
      edits: [],
    };
    this.comments.push(comment);
    return comment;
  }

  bodyOf(commentId: number): string {
    return this.comment(commentId).body;
  }

  /** Changes what the pull request contains without a new head commit (e.g. retargeting the base branch). */
  retarget(files: PullFile[], base: string): void {
    this.files = files;
    this.pr.base.ref = base;
  }

  /** Answers a quiz as `login`. `pick(questionIndex, optionTexts)` returns the option index to tick. */
  answerQuiz(login: string, commentId: number, pick: (q: number, options: string[]) => number, submit = true): void {
    const questions = parseQuestions(this.comment(commentId).body);
    let offset = 0;
    questions.forEach((options, q) => {
      this.toggleCheckbox(login, commentId, offset + pick(q, options));
      offset += options.length;
    });
    if (submit) this.toggleCheckbox(login, commentId, offset);
  }

  push(files: PullFile[], by = 'author'): void {
    this.files = files;
    this.committers.add(by);
    this.pr.head.sha = createHash('sha1').update(JSON.stringify(files) + this.tick++).digest('hex');
  }

  /** Most recent quiz comment (any status) for the reviewer. */
  latestQuizFor(login: string): StoredComment | undefined {
    const heading = new RegExp(`^## .*@${login}\\b`, 'm');
    return this.comments
      .filter((c) => c.user?.type === 'Bot' && c.body.includes('<!-- pr-quiz:quiz -->') && heading.test(c.body))
      .at(-1);
  }

  latestStatus(): (CommitStatus & { sha: string }) | undefined {
    return this.statuses.filter((s) => s.sha === this.pr.head.sha).at(-1);
  }

  botReviewState(): string | undefined {
    return this.reviews.filter((r) => r.user?.type === 'Bot').at(-1)?.state;
  }

  reviewStateOf(login: string): string | undefined {
    return this.reviews.filter((r) => loginsEqual(r.user?.login, login)).at(-1)?.state;
  }
}

/** Option texts per question, read from a rendered open quiz. */
export function parseQuestions(body: string): string[][] {
  const questions: string[][] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('**Q')) questions.push([]);
    const option = /^- \[[ xX]\] [A-Z]\. (.*)$/.exec(line);
    if (option && questions.length) questions[questions.length - 1]!.push(option[1]!);
  }
  return questions;
}

export const pickRight = (_q: number, options: string[]) => options.findIndex((o) => o.includes('(right)'));
export const pickWrongFirst = (q: number, options: string[]) =>
  q === 0 ? options.findIndex((o) => !o.includes('(right)')) : pickRight(q, options);

/**
 * Deterministic stand-in for Claude. Correct answers contain "(right)", so simulated reviewers can answer
 * correctly or incorrectly on purpose. The verifier reproduces the key, except for questions whose text
 * contains "AMBIGUOUS", which it rejects.
 */
export class FakeLlm implements LlmBackend {
  readonly label = 'Fake Claude';
  readonly model = 'fake-model';
  readonly requests: StructuredRequest[] = [];
  generation = 0;
  failGeneration: Error | null = null;
  ambiguousFirst = false;

  async complete(request: StructuredRequest): Promise<StructuredResponse> {
    this.requests.push(request);
    if (request.schema === GENERATION_SCHEMA) {
      if (this.failGeneration) throw this.failGeneration;
      const count = Number(/Write (\d+) multiple-choice/.exec(request.task)?.[1] ?? 3);
      const set = ++this.generation;
      return {
        data: {
          questions: Array.from({ length: count }, (_, i) => ({
            question: `${this.ambiguousFirst && i === 0 ? 'AMBIGUOUS ' : ''}Set ${set}, question ${i + 1}: what does \`total()\` return for two items with qty 2?`,
            file: 'src/cart.ts',
            correct_answer: `Answer ${set}.${i + 1} (right)`,
            distractors: [`Answer ${set}.${i + 1} wrong A`, `Answer ${set}.${i + 1} wrong B`, `Answer ${set}.${i + 1} wrong C`],
            explanation: `Because subtotal multiplies price by qty before applyDiscount (set ${set}).`,
          })),
        },
      };
    }
    const questions = JSON.parse(/<pq_questions>\n([\s\S]*)\n<\/pq_questions>/.exec(request.task)![1]!) as Array<{
      id: number;
      question: string;
      options: string[];
    }>;
    return {
      data: {
        answers: questions.map((q) => ({
          id: q.id,
          choice: q.options.findIndex((o) => o.includes('(right)')),
          valid: !q.question.includes('AMBIGUOUS'),
          issue: q.question.includes('AMBIGUOUS') ? 'two options are defensible' : '',
        })),
      },
    };
  }
}
