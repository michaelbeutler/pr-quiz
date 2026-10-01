export interface Actor {
  login: string;
  type: string; // 'User' | 'Bot' | 'Organization' | ...
}

export interface PullRequest {
  number: number;
  state: 'open' | 'closed';
  merged?: boolean;
  draft?: boolean;
  title: string;
  body: string | null;
  html_url: string;
  user: Actor | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string; id: number } };
}

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export interface Review {
  id: number;
  user: Actor | null;
  state: ReviewState;
  body: string | null;
  commit_id: string | null;
  submitted_at?: string | null;
  author_association?: string;
}

export interface IssueComment {
  id: number;
  node_id: string;
  user: Actor | null;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  author_association?: string;
}

export interface PullFile {
  filename: string;
  status: string; // added | removed | modified | renamed | copied | changed | unchanged
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
  sha?: string;
}

export interface ContentEdit {
  /** Login without the `[bot]` suffix, null for deleted accounts. */
  editor: string | null;
  isBot: boolean;
  editedAt: string;
  /** Full comment body of this revision; null when the revision's content was deleted. */
  body: string | null;
}

export type CommitState = 'pending' | 'success' | 'failure' | 'error';

export interface CommitStatus {
  state: CommitState;
  context: string;
  description: string;
  target_url?: string;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/** The GitHub operations the bot needs, scoped to one repository. */
export interface GitHubApi {
  getPull(pr: number): Promise<PullRequest>;
  listReviews(pr: number): Promise<Review[]>;
  listComments(pr: number): Promise<IssueComment[]>;
  listFiles(pr: number): Promise<PullFile[]>;
  getFileText(path: string, ref: string): Promise<string | null>;
  createComment(pr: number, body: string): Promise<IssueComment>;
  updateComment(commentId: number, body: string): Promise<IssueComment>;
  createReview(pr: number, event: ReviewEvent, body: string, commitId: string): Promise<Review>;
  dismissReview(pr: number, reviewId: number, message: string): Promise<void>;
  requestReviewers(pr: number, logins: string[]): Promise<void>;
  setStatus(sha: string, status: CommitStatus): Promise<void>;
  /** Most recent status with this context on the commit, if any. */
  getStatus(sha: string, context: string): Promise<CommitStatus | null>;
  /** Edit history of an issue comment, newest first (GitHub's order). */
  getCommentEdits(commentNodeId: string): Promise<CommentHistory>;
  /** Whether the user can push to the repository (admin, maintain, write or a custom role based on them). */
  hasWriteAccess(login: string): Promise<boolean>;
  /** GitHub users who authored or committed any non-merge commit of the pull request. */
  listCommitters(pr: number): Promise<string[]>;
  addReaction(commentId: number, content: '+1' | 'eyes' | 'confused' | 'rocket'): Promise<void>;
}

export interface CommentHistory {
  edits: ContentEdit[];
  /** False when the history was too long to read completely. */
  complete: boolean;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly responseBody?: string;

  constructor(message: string, status: number, responseBody?: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

export function loginsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.replace(/\[bot\]$/i, '').toLowerCase();
  return norm(a) === norm(b);
}
