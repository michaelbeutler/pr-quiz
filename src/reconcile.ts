import { randomBytes } from 'node:crypto';
import type { Command } from './command.ts';
import type { Config } from './config.ts';
import { buildChangeSet, changedSince, contextCandidates, renderPullRequestContext, type ChangeSet } from './diff.ts';
import {
  loginsEqual,
  type CommentHistory,
  type CommitStatus,
  type GitHubApi,
  type IssueComment,
  type PullRequest,
  type Review,
} from './github/types.ts';
import type { LlmBackend } from './llm/backend.ts';
import { generateQuiz } from './llm/generator.ts';
import type { StateCodec } from './quiz/crypto.ts';
import { grade } from './quiz/grade.ts';
import { normalizeBody, parseOpenQuiz } from './quiz/parse.ts';
import {
  answerDuration,
  extractChallengeState,
  extractSealedState,
  formatDuration,
  isQuizBody,
  isWriting,
  joinList,
  listLogins,
  mention,
  pendingReviewer,
  renderChallengeRecord,
  renderPlaceholder,
  renderQuiz,
  renderReply,
  renderWriting,
  renderWritingFailed,
  renderWritingStopped,
  replyMarker,
  REVIEW_MARKER,
  skippedTargetLines,
  type ChallengeRecordInfo,
} from './quiz/render.ts';
import {
  quizKind,
  type AnswerTiming,
  type ChallengeRecord,
  type ChallengeRef,
  type QuizComment,
  type QuizKind,
  type QuizState,
} from './quiz/types.ts';
import { log } from './util/action.ts';

export type TriggerKind = 'approval' | 'review' | 'comment-edit' | 'command' | 'push' | 'manual';

export interface Trigger {
  kind: TriggerKind;
  /** User who caused the event (reviewer, commenter, ...). */
  actor?: string;
  /** Comment id of a `/pr-quiz` command. */
  commandCommentId?: number;
  /** Subcommand of a command comment; absent for a plain quiz request. */
  command?: Command;
}

export type Gate = 'passed' | 'pending' | 'error' | 'skipped';

export interface BotAction {
  type: string;
  detail: string;
}

export interface ReconcileResult {
  gate: Gate;
  description: string;
  actions: BotAction[];
}

export interface ReconcileDeps {
  gh: GitHubApi;
  codec: StateCodec;
  config: Config;
  llm: LlmBackend;
  now?: () => Date;
  /** The workflow run doing the work, linked while a quiz is being written. */
  runUrl?: string;
}

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
/** After a failed generation, only these triggers try again (not every checkbox tick). */
const RETRY_TRIGGERS = new Set<TriggerKind>(['approval', 'command', 'push', 'manual']);
const GENERATION_ERROR_PREFIX = 'Quiz error:';
const MAX_STORED_FILE_FINGERPRINTS = 300;
const MAX_ASKED_QUESTIONS = 30;
/** GitHub rejects comments longer than 65,536 characters. */
const MAX_COMMENT_CHARS = 65_000;
const MAX_CONTEXT_FILES = 15;
const MAX_CONTEXT_FILE_CHARS = 60_000;
/** Commit identities that are never a person: the web UI's committer and deleted accounts. */
const NON_HUMAN_LOGINS = new Set(['web-flow', 'ghost']);

const key = (login: string) => login.replace(/\[bot\]$/i, '').toLowerCase();

/** Each login once, in the spelling it first appears in. */
function uniqueLogins(logins: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const login of logins) if (!byKey.has(key(login))) byKey.set(key(login), login);
  return [...byKey.values()];
}

/** Why GitHub refused a review by the bot, in words that point at the fix. */
function reviewRefusal(error: unknown): string {
  const message = (error as Error).message;
  if (/own pull request/i.test(message)) return `${message}. GitHub does not let the bot review a pull request it opened itself.`;
  if (/not permitted/i.test(message)) {
    return `${message}. For GITHUB_TOKEN, enable "Allow GitHub Actions to create and approve pull requests" in the repository (and organization) settings.`;
  }
  return message;
}

/** ` in 1 min 12 s (first answer after 38 s)`, for logs and the job summary. */
function describeTiming(state: QuizState): string {
  const timing = state.result?.timing;
  const total = answerDuration(state);
  if (!timing || total === undefined) return '';
  const first = Date.parse(timing.firstAnswerAt) - Date.parse(timing.shownAt);
  return ` in ${formatDuration(total)} (first answer after ${formatDuration(first)})`;
}

type Integrity =
  | { ok: true }
  | { ok: false; restore?: QuizState; culprits: string[] };

type PassStatus = 'valid' | 'needs-approval' | 'none';

/** A challenge as its record review states it, or as a challenge quiz's copy does when the record is gone. */
interface Challenge {
  id: string;
  by: string;
  challengee: string;
  at: string;
  commandCommentId?: number;
  /** The record review; unknown when the challenge is only known from a quiz's copy. */
  reviewUrl?: string;
  withdrawn?: boolean;
}

/**
 * One reconciliation of a pull request. Every trigger runs the full loop against GitHub's current state, so
 * missed, duplicated or reordered webhook events cannot leave the quiz in an inconsistent state.
 */
class Reconciliation {
  readonly actions: BotAction[] = [];
  /** Question generation failures. */
  private readonly errors: string[] = [];
  /** Open quizzes that could not be verified this run (e.g. the edit history was unavailable). */
  private readonly verificationErrors: string[] = [];
  private readonly deps: ReconcileDeps;
  private readonly prNumber: number;
  private readonly trigger: Trigger;
  private readonly eligibility = new Map<string, boolean>();
  private readonly writeAccess = new Map<string, boolean>();
  private committers = new Set<string>();
  /** The commit authors and committers as GitHub spells them, which tells bots from people. */
  private committerLogins: string[] = [];
  private previousStatus: CommitStatus | null = null;
  /** Generation was skipped because an earlier attempt failed and this trigger is not a retry. */
  private generationPaused = false;
  private pr!: PullRequest;
  private reviews: Review[] = [];
  private comments: IssueComment[] = [];
  /** Placeholders of quizzes an earlier run did not finish, by reviewer; reused when the quiz is written again. */
  private readonly slots = new Map<string, IssueComment>();
  /** The status this run last published (to skip publishing the same status twice). */
  private published: CommitStatus | null = null;
  private quizzes: QuizComment[] = [];
  /** Every known challenge on the pull request, withdrawn ones included. */
  private challenges: Challenge[] = [];
  /** Command comments that already led to a withdraw record, so a re-run of an old event changes nothing. */
  private readonly withdrawCommands: Array<{ by: string; commandCommentId: number }> = [];
  /** A challenge record could not be verified while the pull request has challenges, so the gate can't pass. */
  private challengesUnverified = false;
  /** Open quizzes whose state this run checked against the bot's own revision, or posted itself. */
  private readonly verifiedQuizIds = new Set<number>();
  private changes!: ChangeSet;

  constructor(deps: ReconcileDeps, prNumber: number, trigger: Trigger) {
    this.deps = deps;
    this.prNumber = prNumber;
    this.trigger = trigger;
  }

  private get gh(): GitHubApi {
    return this.deps.gh;
  }

  private get config(): Config {
    return this.deps.config;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** What a command comment asks for; undefined for other triggers. */
  private get verb(): Command['verb'] | undefined {
    return this.trigger.kind === 'command' ? (this.trigger.command?.verb ?? 'quiz') : undefined;
  }

  private record(type: string, detail: string): void {
    this.actions.push({ type, detail });
    log.info(`• ${type}: ${detail}`);
  }

  async run(): Promise<ReconcileResult> {
    this.pr = await this.gh.getPull(this.prNumber);
    if (this.pr.state !== 'open') {
      return { gate: 'skipped', description: 'Pull request is not open.', actions: this.actions };
    }
    if (this.trigger.kind === 'command') await this.react(this.trigger.commandCommentId, 'eyes');

    const [reviews, comments, files, committers, previousStatus] = await Promise.all([
      this.gh.listReviews(this.prNumber),
      this.gh.listComments(this.prNumber),
      this.gh.listFiles(this.prNumber),
      this.gh.listCommitters(this.prNumber).catch((error: Error) => {
        log.warning(`Could not list the pull request's commit authors: ${error.message}`);
        return [];
      }),
      this.gh.getStatus(this.pr.head.sha, this.config.statusContext).catch(() => null),
    ]);
    this.reviews = reviews;
    this.comments = comments;
    for (const comment of comments) {
      const reviewer = comment.user?.type === 'Bot' ? pendingReviewer(comment.body) : null;
      if (reviewer) this.slots.set(key(reviewer), comment);
    }
    this.committerLogins = committers;
    this.committers = new Set(committers.map(key));
    this.previousStatus = previousStatus;
    this.changes = buildChangeSet(files, this.config.ignorePaths);
    this.quizzes = await this.loadQuizzes(comments);
    if (this.config.allowChallenges) await this.loadChallenges();
    if (this.changes.possiblyIncomplete) log.warning('GitHub lists at most 3000 files; the quiz only sees those.');

    // Before the open quizzes, so a withdrawal or a replaced practice quiz closes them in the same run.
    if (this.verb === 'challenge' || this.verb === 'withdraw') await this.handleChallengeCommand();
    for (const quiz of [...this.quizzes]) {
      if (quiz.state.status === 'open') await this.processOpenQuiz(quiz);
    }
    await this.copyChallenges();
    if (this.changes.hasReadableChanges) {
      await this.ensureQuizzes();
    } else if (this.verb === 'quiz') {
      await this.react(this.trigger.commandCommentId, 'confused');
      await this.explain(
        `${mention(this.trigger.actor ?? '')}, there is nothing to quiz on: this pull request only changes files the ` +
          'quiz skips (ignored paths such as lockfiles, or binary files). An approval of the latest commit is enough.',
      );
    }
    await this.closeStoppedSlots();
    await this.linkFollowUps();

    await this.resolveEligibility();
    let gate = this.evaluateGate();
    if (this.generationPaused && gate.state !== 'success' && this.previousStatus) gate = this.previousStatus;
    await this.publishStatus(gate);
    if (this.config.submitReviews) await this.syncBotReview(gate.state === 'success');
    return {
      gate: gate.state === 'success' ? 'passed' : gate.state === 'error' ? 'error' : 'pending',
      description: gate.description,
      actions: this.actions,
    };
  }

  // --- Loading -----------------------------------------------------------------------------------------------

  private toQuiz(comment: IssueComment, state: QuizState): QuizComment {
    return {
      commentId: comment.id,
      nodeId: comment.node_id,
      url: comment.html_url,
      body: comment.body,
      createdAt: comment.created_at,
      author: comment.user?.login ?? '',
      state,
    };
  }

  private async loadQuizzes(comments: IssueComment[]): Promise<QuizComment[]> {
    const quizzes: QuizComment[] = [];
    for (const comment of comments) {
      if (comment.user?.type !== 'Bot' || !isQuizBody(comment.body)) continue;
      const state = this.deps.codec.open(this.prNumber, extractSealedState(comment.body)!);
      if (!state) {
        log.info(`Ignoring quiz comment ${comment.id}: its state cannot be decrypted with the current secret.`);
        continue;
      }
      if (state.commentId === comment.id) {
        quizzes.push(this.toQuiz(comment, state));
        continue;
      }
      // State from another comment was pasted in. Never grade it; bring back what the bot last wrote here, if anything.
      const recovered = await this.recoverOwnState(comment);
      if (recovered) quizzes.push(recovered);
      else log.warning(`Ignoring comment ${comment.id}: it carries quiz state that belongs to another comment.`);
    }
    return quizzes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commentId - b.commentId);
  }

  /** Restores a quiz comment to the state in the bot's own latest revision of it. */
  private async recoverOwnState(comment: IssueComment): Promise<QuizComment | null> {
    const history = await this.gh.getCommentEdits(comment.node_id).catch(() => null);
    if (!history?.complete) return null;
    const ours = history.edits.find((e) => e.editor && loginsEqual(e.editor, comment.user?.login));
    const sealed = ours?.body ? extractSealedState(ours.body) : null;
    const state = sealed ? this.deps.codec.open(this.prNumber, sealed) : null;
    if (!state || state.commentId !== comment.id) return null;
    const quiz = this.toQuiz(comment, state);
    const culprits = history.edits.filter((e) => !(e.editor && loginsEqual(e.editor, comment.user?.login)));
    const who = [...new Set(culprits.map((e) => `\`${e.editor ?? 'ghost'}\``))].join(', ') || 'someone';
    if (state.status === 'open') state.notice = `This quiz was modified by ${who}, so it was restored. Please select your answers again.`;
    await this.save(quiz);
    this.record('quiz-restored', `Undid quiz state pasted into comment ${comment.id} by ${who.replace(/`/g, '')}.`);
    return quiz;
  }

  /**
   * Reads the challenges from the bot's comment reviews. GitHub offers no way to delete a submitted review or to
   * dismiss a comment review, but people with write access can edit its body, so an edited record only counts in
   * the bot's own latest revision, which is put back. Each challenge quiz carries a copy of its challenges, which
   * keeps a challenge whose record is gone. What can't be verified fails closed on pull requests with challenges.
   */
  private async loadChallenges(): Promise<void> {
    const problems: string[] = [];
    const fail = (error: Error): undefined => {
      problems.push(error.message);
      return undefined;
    };
    const records: Array<{ record: ChallengeRecord; review: Review }> = [];
    const candidates = this.reviews.filter((r) => r.user?.type === 'Bot' && r.state === 'COMMENTED');
    // The identity that posts this gate's quizzes and reviews; its edited comment reviews may be challenge records.
    const gateBots = [
      ...this.quizzes.map((q) => q.author),
      ...this.reviews.filter((r) => r.user?.type === 'Bot' && (r.body ?? '').includes(REVIEW_MARKER)).map((r) => r.user!.login),
    ];
    // An edited review that may be a record but can't be checked may be the only trace of a challenge.
    let unverifiedRecord = false;
    const edited = candidates.length ? await this.gh.listEditedReviewIds(this.prNumber).catch(fail) : new Set<number>();
    for (const review of candidates) {
      const current = this.openRecord(review.body);
      if (!edited?.has(review.id)) {
        // Never edited, so exactly what the bot posted (or unknown because the list failed: then the run is unverified).
        if (current) records.push({ record: current, review });
        continue;
      }
      const history = review.node_id
        ? await this.gh.getCommentEdits(review.node_id).catch(fail)
        : fail(new Error(`review ${review.id} has no node id`));
      if (!history) {
        if (current || gateBots.some((login) => loginsEqual(login, review.user?.login))) unverifiedRecord = true;
        continue;
      }
      const ours = history.edits.flatMap((e) => {
        const record = e.body && loginsEqual(e.editor, review.user?.login) ? this.openRecord(e.body) : null;
        return record ? [{ body: e.body!, record }] : [];
      });
      const latest = ours[0];
      if (!latest) {
        // Not a record, or the bot's revisions were deleted from the history: the current body proves nothing.
        if (current && !history.complete) {
          unverifiedRecord = true;
          fail(new Error(`the edit history of review ${review.id} is too long to check`));
        }
        continue;
      }
      if (normalizeBody(latest.body) !== normalizeBody(review.body ?? '')) await this.restoreRecord(review, latest.body, history);
      records.push({ record: latest.record, review });
    }

    const known = new Map<string, Challenge>();
    const withdrawn = new Set<string>();
    for (const { record, review } of records) {
      if (record.kind === 'withdraw') {
        for (const id of record.ids) withdrawn.add(id);
        if (record.commandCommentId !== undefined) this.withdrawCommands.push({ by: record.by, commandCommentId: record.commandCommentId });
      } else if (!known.has(record.id)) {
        const { id, by, challengee, at, commandCommentId } = record;
        known.set(id, { id, by, challengee, at, commandCommentId, reviewUrl: review.html_url });
      }
    }
    for (const quiz of this.quizzes) {
      for (const ref of [...(quiz.state.challenge?.refs ?? []), ...(quiz.state.challenge?.later ?? [])]) {
        if (!known.has(ref.id)) known.set(ref.id, { ...ref, challengee: quiz.state.reviewer });
      }
    }
    this.challenges = [...known.values()].map((c) => ({ ...c, withdrawn: withdrawn.has(c.id) }));

    if (!problems.length) return;
    const message = `Could not verify the challenge records: ${problems.join('; ')}`;
    log.warning(message);
    const hasChallenges =
      unverifiedRecord ||
      this.challenges.length > 0 ||
      this.quizzes.some((q) => q.state.challenge) ||
      this.verb === 'challenge' ||
      this.verb === 'withdraw';
    // A GraphQL hiccup never touches pull requests without challenges or a record that may hold one; the next event checks again.
    if (hasChallenges) {
      this.verificationErrors.push(message);
      this.challengesUnverified = true;
    }
  }

  private openRecord(body: string | null | undefined): ChallengeRecord | null {
    const sealed = extractChallengeState(body);
    return sealed ? this.deps.codec.openChallenge(this.prNumber, sealed) : null;
  }

  /** Puts the bot's own text back into a challenge record someone else edited. */
  private async restoreRecord(review: Review, body: string, history: CommentHistory): Promise<void> {
    const editors = history.edits.filter((e) => !loginsEqual(e.editor, review.user?.login)).map((e) => e.editor ?? 'ghost');
    const who = [...new Set(editors)].map((l) => `\`${l}\``).join(', ') || 'someone';
    try {
      await this.gh.updateReview(this.prNumber, review.id, body);
      review.body = body;
      this.record('challenge-restored', `Undid edits by ${who} to the challenge record ${review.html_url ?? review.id}.`);
    } catch (error) {
      // The verified record counts anyway.
      log.warning(`Could not restore challenge record ${review.id}: ${(error as Error).message}`);
    }
  }

  private quizzesOf(login: string): QuizComment[] {
    return this.quizzes.filter((q) => loginsEqual(q.state.reviewer, login));
  }

  /** Latest review decision of a user; comments don't change a decision on GitHub. */
  private latestDecision(login: string): Review | undefined {
    return this.reviews
      .filter((r) => r.user && loginsEqual(r.user.login, login) && r.state !== 'COMMENTED' && r.state !== 'PENDING')
      .at(-1);
  }

  private approvedLatestCommit(login: string): boolean {
    const decision = this.latestDecision(login);
    return decision?.state === 'APPROVED' && decision.commit_id === this.pr.head.sha;
  }

  /**
   * A pass is valid for the code the quiz covered. If only ignored or binary files changed since (which a quiz
   * can't cover), the reviewer must approve the latest commit again for the pass to keep counting. A challenge
   * quiz is never a reviewer's pass.
   */
  private passStatus(login: string, includePractice = false): { status: PassStatus; quiz?: QuizComment } {
    const quiz = this.quizzesOf(login)
      .filter(
        (q) =>
          q.state.status === 'passed' &&
          q.state.fingerprint === this.changes.fingerprint &&
          !q.state.challenge &&
          (includePractice || !q.state.practice),
      )
      .at(-1);
    if (!quiz) return { status: 'none' };
    if (quiz.state.fullFingerprint === this.changes.fullFingerprint || this.approvedLatestCommit(login)) {
      return { status: 'valid', quiz };
    }
    return { status: 'needs-approval', quiz };
  }

  /** Passes that count: valid, by an eligible reviewer who has not requested changes since. */
  private passes(): QuizComment[] {
    const byReviewer = new Map<string, QuizComment>();
    for (const quiz of this.quizzes) {
      const login = quiz.state.reviewer;
      if (byReviewer.has(key(login)) || this.eligibility.get(key(login)) !== true) continue;
      const pass = this.passStatus(login);
      if (pass.status !== 'valid' || this.latestDecision(login)?.state === 'CHANGES_REQUESTED') continue;
      byReviewer.set(key(login), pass.quiz!);
    }
    return [...byReviewer.values()];
  }

  private openQuiz(login: string, kind: 'challenge' | 'other' = 'other'): QuizComment | undefined {
    return this.quizzesOf(login).find(
      (q) =>
        q.state.status === 'open' &&
        q.state.fingerprint === this.changes.fingerprint &&
        !!q.state.challenge === (kind === 'challenge'),
    );
  }

  /** Open quizzes the gate waits for; practice quizzes don't hold it up. */
  private openQuizzes(): QuizComment[] {
    return this.quizzes.filter(
      (q) => q.state.status === 'open' && !q.state.practice && q.state.fingerprint === this.changes.fingerprint,
    );
  }

  /**
   * Failed attempts and questions seen so far. Every quiz carries this history forward in its sealed state, so
   * deleting old quiz comments neither resets the attempt limit nor brings back questions whose answers were shown.
   * Challenge quizzes count apart: only those of the newest challenge, so every new challenge brings new attempts.
   * Questions seen in any quiz are never asked again.
   */
  private attemptHistory(login: string, kind: 'challenge' | 'other' = 'other'): { failed: number; asked: string[] } {
    const mine = this.quizzesOf(login);
    const newest = kind === 'challenge' ? this.newestChallenge(login) : undefined;
    const counted = mine.filter((q) =>
      kind === 'challenge' ? !!newest && !!q.state.challenge?.refs.some((r) => r.id === newest.id) : !q.state.challenge,
    );
    let failed = counted.filter((q) => q.state.status === 'failed').length;
    for (const quiz of counted) {
      failed = Math.max(failed, (quiz.state.failedBefore ?? 0) + (quiz.state.status === 'failed' ? 1 : 0));
    }
    const asked: string[] = [];
    for (const quiz of mine) asked.push(...(quiz.state.asked ?? []), ...quiz.state.questions.map((q) => q.text.slice(0, 200)));
    return { failed, asked: [...new Set(asked)].slice(-MAX_ASKED_QUESTIONS) };
  }

  /** Humans whose latest review decision is an approval. */
  private activeApprovers(): string[] {
    const latest = new Map<string, Review>();
    for (const review of this.reviews) {
      if (!review.user || review.user.type === 'Bot') continue;
      if (review.state === 'COMMENTED' || review.state === 'PENDING') continue;
      latest.set(key(review.user.login), review);
    }
    return [...latest.values()].filter((r) => r.state === 'APPROVED').map((r) => r.user!.login);
  }

  // --- Challenges ----------------------------------------------------------------------------------------------

  /** Known challenges that no withdraw record ends; none while challenges are turned off. */
  private activeChallenges(login?: string): Challenge[] {
    if (!this.config.allowChallenges) return [];
    return this.challenges.filter((c) => !c.withdrawn && (login === undefined || loginsEqual(c.challengee, login)));
  }

  private challengees(): string[] {
    return uniqueLogins(this.activeChallenges().map((c) => c.challengee));
  }

  private challengersOf(login: string): string[] {
    return uniqueLogins(this.activeChallenges(login).map((c) => c.by));
  }

  /** The author owes a challenge quiz. Challenges rest while the pull request has nothing a quiz could cover. */
  private isChallenged(login: string): boolean {
    return this.changes.hasReadableChanges && this.activeChallenges(login).length > 0;
  }

  /** One passed challenge quiz on the current code meets every challenge to the author; a practice pass never does. */
  private challengeMet(login: string): boolean {
    return this.quizzesOf(login).some(
      (q) => !!q.state.challenge && q.state.status === 'passed' && q.state.fingerprint === this.changes.fingerprint,
    );
  }

  /** Challenged authors the gate still waits for. */
  private unmetChallengees(): string[] {
    if (!this.changes.hasReadableChanges) return [];
    return this.challengees().filter((login) => !this.challengeMet(login));
  }

  /** The challenge with the latest command; its quizzes count toward the author's attempts. */
  private newestChallenge(login: string): Challenge | undefined {
    let newest: Challenge | undefined;
    for (const c of this.activeChallenges(login)) {
      if (!newest || (c.commandCommentId ?? 0) > (newest.commandCommentId ?? 0)) newest = c;
    }
    return newest;
  }

  private lockedOut(login: string): boolean {
    return this.config.maxAttempts > 0 && this.attemptHistory(login, 'challenge').failed >= this.config.maxAttempts;
  }

  /**
   * The login as the pull request knows it, if it is an author of the change, and whether it is a person. The exact
   * spelling decides, so `@renovate` can't stand for `renovate[bot]`.
   */
  private authorIdentity(login: string): { login: string; human: boolean } | undefined {
    const opener = this.pr.user;
    if (opener && loginsEqual(login, opener.login)) {
      return { login: opener.login, human: opener.type !== 'Bot' && !/\[bot\]$/i.test(opener.login) };
    }
    const committer =
      this.committerLogins.find((c) => c.toLowerCase() === login.toLowerCase()) ??
      this.committerLogins.find((c) => loginsEqual(c, login));
    if (!committer) return undefined;
    return { login: committer, human: !/\[bot\]$/i.test(committer) && !NON_HUMAN_LOGINS.has(committer.toLowerCase()) };
  }

  /**
   * Whom a challenge names: the mentioned authors, or by default the opener (on a pull request a bot opened, every
   * human committer). Only human authors of the change who can tick the quiz's checkboxes can be challenged.
   */
  private async resolveTargets(targets: string[]): Promise<{ logins: string[]; notAuthors: string[]; noWriteAccess: string[] }> {
    const authors: string[] = [];
    const notAuthors: string[] = [];
    if (targets.length) {
      for (const target of targets) {
        // A `[bot]` spelling never names a person, even when the same name without it does.
        const author = /\[bot\]$/i.test(target) ? undefined : this.authorIdentity(target);
        if (author?.human) authors.push(author.login);
        else notAuthors.push(target);
      }
    } else {
      const opener = this.pr.user ? this.authorIdentity(this.pr.user.login) : undefined;
      if (opener?.human) authors.push(opener.login);
      else authors.push(...this.committerLogins.filter((login) => this.authorIdentity(login)?.human));
    }
    const logins: string[] = [];
    const noWriteAccess: string[] = [];
    for (const login of uniqueLogins(authors)) {
      if (await this.canPush(login)) logins.push(login);
      else noWriteAccess.push(login);
    }
    return { logins, notAuthors, noWriteAccess };
  }

  private async handleChallengeCommand(): Promise<void> {
    const { actor, command } = this.trigger;
    if (!actor || !command || command.verb === 'quiz') return;
    if (command.verb === 'challenge') await this.challenge(actor, command.targets);
    else await this.withdraw(actor, command.targets);
  }

  /** `/pr-quiz challenge [@author …]`: records a challenge for each author it names. */
  private async challenge(actor: string, targets: string[]): Promise<void> {
    const commandId = this.trigger.commandCommentId;
    const by = mention(actor);
    const reject = async (reason: string): Promise<void> => {
      this.record('challenge-rejected', `${by} can't challenge: ${reason}`);
      await this.react(commandId, 'confused');
      await this.explain(`${by}, you can't challenge here: ${reason}`);
    };
    if (!this.config.allowChallenges) return reject('challenges are turned off (allow-challenges: false).');
    if (commandId !== undefined && this.challenges.some((c) => c.commandCommentId === commandId)) {
      await this.react(commandId, '+1'); // a re-run of the same event
      return;
    }
    // A re-run of an old challenge command never undoes a withdrawal the actor made after it.
    if (commandId !== undefined && this.withdrawCommands.some((w) => loginsEqual(w.by, actor) && w.commandCommentId > commandId)) {
      await this.react(commandId, '+1');
      return;
    }
    if (!this.changes.hasReadableChanges) return reject('nothing in this pull request can be quizzed.');
    // The same rule that makes a pass count: only someone whose own pass could open the gate can ask for more.
    if (!(await this.isEligible(actor))) return reject("authors of the change and people without write access can't challenge.");
    const { logins, notAuthors, noWriteAccess } = await this.resolveTargets(targets);
    if (!logins.length) {
      return reject(skippedTargetLines(notAuthors, noWriteAccess).join(' ') || 'the pull request has no human author to challenge.');
    }

    let posted = 0;
    let failed = false;
    const already: string[] = [];
    for (const login of logins) {
      // While the records can't be verified, a challenge that looks active may have been withdrawn: record it again.
      if (
        !this.challengesUnverified &&
        this.activeChallenges(login).some((c) => loginsEqual(c.by, actor)) &&
        (this.challengeMet(login) || !this.lockedOut(login))
      ) {
        const open = this.openQuiz(login, 'challenge');
        already.push(
          this.challengeMet(login)
            ? `${mention(login)} already passed a challenge quiz on this version of the change.`
            : open
              ? `${mention(login)}'s challenge quiz is waiting for their answers: ${open.url}`
              : `${mention(login)}'s challenge quiz is being prepared.`,
        );
        continue;
      }
      const met = this.challengeMet(login);
      const record: ChallengeRecord = {
        v: 1,
        kind: 'challenge',
        id: randomBytes(8).toString('hex'),
        by: actor,
        challengee: login,
        at: this.now(),
        commandCommentId: commandId,
      };
      const info: ChallengeRecordInfo = {
        command: this.config.command,
        met,
        openQuizUrl: this.openQuiz(login, 'challenge')?.url,
        renewedAttempts: !met && this.lockedOut(login) ? this.config.maxAttempts : undefined,
        // Mentions that were not challenged are named once, in the first record.
        ...(posted ? {} : { notAuthors, noWriteAccess }),
      };
      let review: Review;
      try {
        review = await this.postChallengeRecord(record, info);
      } catch (error) {
        // No fallback to a store people could delete: without its record there is no challenge.
        const message = (error as Error).message;
        log.warning(`Could not post the challenge record: ${message}`);
        this.record('challenge-rejected', `Could not post the challenge record: ${message}`);
        await this.explain(`${by}, the challenge could not be recorded: ${message}`);
        failed = true;
        break;
      }
      this.challenges.push({ id: record.id, by: actor, challengee: login, at: record.at, commandCommentId: commandId, reviewUrl: review.html_url });
      this.record('challenge-recorded', `${by} challenged ${mention(login)}: ${review.html_url ?? `review ${review.id}`}`);
      posted++;
    }
    if (posted) await this.react(commandId, 'rocket');
    if (failed) await this.react(commandId, 'confused');
    else if (!posted) await this.react(commandId, '+1'); // the actor had challenged them all already
    if (!failed && !posted && already.length) await this.explain(`${by}, you already challenged them. ${already.join(' ')}`);
  }

  /** `/pr-quiz withdraw [@author …]`: only the reviewer who challenged can end their challenges. */
  private async withdraw(actor: string, targets: string[]): Promise<void> {
    const commandId = this.trigger.commandCommentId;
    const by = mention(actor);
    const reject = async (reason: string): Promise<void> => {
      this.record('withdraw-rejected', `${by} can't withdraw: ${reason}`);
      await this.react(commandId, 'confused');
      await this.explain(`${by}, nothing was withdrawn: ${reason}`);
    };
    if (!this.config.allowChallenges) return reject('challenges are turned off (allow-challenges: false).');
    if (commandId !== undefined && this.withdrawCommands.some((w) => w.commandCommentId === commandId)) {
      await this.react(commandId, '+1'); // a re-run of the same event
      return;
    }
    // A re-run of an old withdraw command never ends a challenge made after it.
    const mine = this.activeChallenges().filter(
      (c) =>
        loginsEqual(c.by, actor) &&
        (!targets.length || targets.some((t) => loginsEqual(t, c.challengee))) &&
        (c.commandCommentId ?? 0) < (commandId ?? 0),
    );
    if (!mine.length || !(await this.canPush(actor))) return reject('only the reviewer who challenged can withdraw.');

    const challengees = uniqueLogins(mine.map((c) => c.challengee));
    const remaining = this.activeChallenges().filter(
      (c) => !mine.includes(c) && challengees.some((login) => loginsEqual(login, c.challengee)),
    );
    const record: ChallengeRecord = {
      v: 1,
      kind: 'withdraw',
      ids: mine.map((c) => c.id),
      by: actor,
      at: this.now(),
      commandCommentId: commandId,
    };
    let review: Review;
    try {
      review = await this.postChallengeRecord(record, {
        command: this.config.command,
        challengees,
        remaining: uniqueLogins(remaining.map((c) => c.by)),
      });
    } catch (error) {
      const message = (error as Error).message;
      log.warning(`Could not post the withdraw record: ${message}`);
      return reject(`could not post the withdraw record (${message}).`);
    }
    for (const c of mine) c.withdrawn = true;
    if (commandId !== undefined) this.withdrawCommands.push({ by: actor, commandCommentId: commandId });
    this.record('challenge-withdrawn', `${by} withdrew their challenge for ${listLogins(challengees)}: ${review.html_url ?? `review ${review.id}`}`);
    await this.react(commandId, '+1');
  }

  /** A comment review of the bot, sealed like a quiz's answer key; it is never edited except to undo others' edits. */
  private postChallengeRecord(record: ChallengeRecord, info: ChallengeRecordInfo): Promise<Review> {
    const body = renderChallengeRecord(record, this.deps.codec.sealChallenge(this.prNumber, record), info);
    return this.gh.createReview(this.prNumber, 'COMMENT', body, this.pr.head.sha);
  }

  /**
   * A challenge made while the author's challenge quiz is open, or after they passed one on the current code, gets
   * no quiz of its own, so it is copied into that quiz: then it outlives its record like every other challenge.
   * Only quizzes checked against the bot's own revision in this run are rewritten, so the bot never re-signs state
   * someone pasted in. A challenge whose quiz could not be generated yet still depends on its record alone.
   */
  private async copyChallenges(): Promise<void> {
    if (this.challengesUnverified) return;
    for (const login of this.challengees()) {
      const open = this.openQuiz(login, 'challenge');
      const met = this.quizzesOf(login)
        .filter((q) => q.state.challenge && q.state.status === 'passed' && q.state.fingerprint === this.changes.fingerprint)
        .at(-1);
      for (const quiz of [open && this.verifiedQuizIds.has(open.commentId) ? open : undefined, met]) {
        const carried = quiz?.state.challenge;
        if (!quiz || !carried) continue;
        const missing = this.activeChallenges(login)
          .filter((c) => ![...carried.refs, ...(carried.later ?? [])].some((r) => r.id === c.id))
          .map(({ id, by, at, commandCommentId }) => ({ id, by, at, commandCommentId }));
        if (!missing.length) continue;
        // Keep the author's ticks: the copy only changes the sealed state.
        const parsed = quiz.state.status === 'open' ? parseOpenQuiz(quiz.body, quiz.state, extractSealedState(quiz.body)!) : undefined;
        carried.later = [...(carried.later ?? []), ...missing];
        try {
          await this.save(quiz, parsed?.readable ? parsed.selections : undefined);
          log.info(`Copied ${missing.length} challenge(s) for ${login} into quiz ${quiz.commentId}.`);
        } catch (error) {
          log.warning(`Could not copy the challenges for ${login} into quiz ${quiz.commentId}: ${(error as Error).message}`);
        }
      }
    }
  }

  // --- Eligibility ---------------------------------------------------------------------------------------------

  private isAuthor(login: string): boolean {
    return loginsEqual(login, this.pr.user?.login) || this.committers.has(key(login));
  }

  private async canPush(login: string): Promise<boolean> {
    const cached = this.writeAccess.get(key(login));
    if (cached !== undefined) return cached;
    let canPush: boolean;
    try {
      canPush = await this.gh.hasWriteAccess(login);
    } catch (error) {
      log.warning(`Could not read ${login}'s permission (${(error as Error).message}); falling back to author association.`);
      canPush = this.reviews.some(
        (r) => r.user && loginsEqual(r.user.login, login) && TRUSTED_ASSOCIATIONS.has(r.author_association ?? ''),
      );
    }
    this.writeAccess.set(key(login), canPush);
    return canPush;
  }

  /** Whose pass counts toward the gate: not an author of the change, and able to push. */
  private async isEligible(login: string): Promise<boolean> {
    const cached = this.eligibility.get(key(login));
    if (cached !== undefined) return cached;
    const eligible = !this.isAuthor(login) && (await this.canPush(login));
    this.eligibility.set(key(login), eligible);
    return eligible;
  }

  private async resolveEligibility(): Promise<void> {
    const logins = new Set([...this.activeApprovers(), ...this.quizzes.map((q) => q.state.reviewer)]);
    for (const login of logins) await this.isEligible(login);
  }

  // --- Writing quizzes -----------------------------------------------------------------------------------------

  /** Seals and renders; drops the optional per-file fingerprints if the comment would exceed GitHub's size limit. */
  private render(state: QuizState, selections?: boolean[][], submitted = false): string {
    const body = renderQuiz(state, this.deps.codec.seal(this.prNumber, state), selections, submitted);
    if (body.length <= MAX_COMMENT_CHARS || !state.files) return body;
    delete state.files;
    return renderQuiz(state, this.deps.codec.seal(this.prNumber, state), selections, submitted);
  }

  private async save(quiz: QuizComment, selections?: boolean[][], submitted = false): Promise<void> {
    const body = this.render(quiz.state, selections, submitted);
    const updated = await this.gh.updateComment(quiz.commentId, body);
    quiz.body = updated.body ?? body;
  }

  /**
   * Posts a placeholder first (unless the quiz goes into one already shown while it was written), so the state can be
   * sealed together with the id of the comment it lives in.
   */
  private async post(state: QuizState, slot?: IssueComment): Promise<QuizComment> {
    const placeholder = slot ?? (await this.gh.createComment(this.prNumber, renderPlaceholder(state.reviewer, !!state.challenge)));
    state.commentId = placeholder.id;
    const comment = await this.gh.updateComment(placeholder.id, this.render(state));
    const quiz: QuizComment = {
      commentId: placeholder.id,
      nodeId: placeholder.node_id,
      url: placeholder.html_url,
      body: comment.body,
      createdAt: placeholder.created_at,
      author: placeholder.user?.login ?? '',
      state,
    };
    this.quizzes.push(quiz);
    this.verifiedQuizIds.add(quiz.commentId);
    return quiz;
  }

  /** Failed or outdated quizzes link to the reviewer's next open quiz, whichever run created it. */
  private async linkFollowUps(): Promise<void> {
    for (const quiz of this.quizzes) {
      const { state } = quiz;
      if ((state.status !== 'failed' && state.status !== 'outdated') || state.followUpUrl) continue;
      // A challenge quiz and a reviewer quiz of the same login follow up on their own kind; practice leads to either.
      const next = this.quizzes.find(
        (q) =>
          q.commentId > quiz.commentId &&
          q.state.status === 'open' &&
          loginsEqual(q.state.reviewer, state.reviewer) &&
          (state.practice || !!q.state.challenge === !!state.challenge),
      );
      if (!next) continue;
      state.followUpUrl = next.url;
      await this.save(quiz);
    }
  }

  // --- Open quizzes --------------------------------------------------------------------------------------------

  private async processOpenQuiz(quiz: QuizComment): Promise<void> {
    let history: CommentHistory;
    try {
      history = await this.gh.getCommentEdits(quiz.nodeId);
    } catch (error) {
      this.verificationErrors.push((error as Error).message);
      log.warning(`Could not read the edit history of quiz comment ${quiz.commentId}: ${(error as Error).message}`);
      return;
    }
    const integrity = this.checkIntegrity(quiz, history);
    if (!integrity.ok) {
      await this.handleTampering(quiz, integrity);
      return;
    }
    this.verifiedQuizIds.add(quiz.commentId);

    const { state } = quiz;
    const who = mention(state.reviewer);
    if (state.fingerprint !== this.changes.fingerprint) {
      state.status = 'outdated';
      await this.save(quiz);
      this.record('quiz-outdated', `Quiz for ${who} no longer matches the code after new commits.`);
      return;
    }
    // Records that can't be verified may be missing a challenge or a withdrawal, so they close nothing.
    if (!this.challengesUnverified && state.practice && this.isChallenged(state.reviewer)) {
      state.status = 'outdated';
      state.closedReason = `${listLogins(this.challengersOf(state.reviewer))} challenged ${who}, so this practice quiz was replaced by a challenge quiz.`;
      await this.save(quiz);
      this.record('quiz-replaced', `Replaced ${who}'s practice quiz with a challenge quiz.`);
      return;
    }
    if (!this.challengesUnverified && state.challenge && !this.isChallenged(state.reviewer)) {
      const reason = this.config.allowChallenges ? 'The challenge was withdrawn' : 'Challenges are turned off for this repository';
      state.status = 'outdated';
      state.closedReason = `${reason}, so this quiz no longer needs an answer.`;
      await this.save(quiz);
      this.record('quiz-closed', `Closed ${who}'s challenge quiz: ${reason.toLowerCase()}.`);
      return;
    }
    // A challenge quiz and a reviewer quiz can be open side by side for an author who can review again.
    const duplicate = this.quizzesOf(state.reviewer).find(
      (q) => q !== quiz && q.state.status === 'open' && q.commentId > quiz.commentId && !!q.state.challenge === !!state.challenge,
    );
    if (duplicate) {
      state.status = 'outdated';
      state.closedReason = 'A newer quiz replaced this one.';
      state.followUpUrl = duplicate.url;
      await this.save(quiz);
      this.record('quiz-superseded', `Closed duplicate quiz for ${who}.`);
      return;
    }

    const parsed = parseOpenQuiz(quiz.body, state, extractSealedState(quiz.body)!);
    if (!parsed.readable) {
      state.notice = 'The quiz text was changed, so it was restored. Please select your answers again.';
      await this.save(quiz);
      this.record('quiz-restored', `Quiz for ${who} had been edited and was restored.`);
      return;
    }
    if (!parsed.submitted) return;

    const intruders = this.intruders(quiz, history);
    if (intruders.length) {
      await this.voidAndRepost(quiz, intruders);
      return;
    }

    const result = grade(state, parsed.selections);
    if (!result.complete) {
      state.notice = result.problems.join(' ');
      await this.save(quiz, parsed.selections, false);
      this.record('submission-incomplete', `${who}: ${state.notice}`);
      return;
    }

    state.notice = undefined;
    state.result = {
      answers: result.answers,
      correct: result.correct,
      gradedAt: this.now(),
      timing: this.answerTiming(quiz, history),
    };
    state.fullFingerprint = this.changes.fullFingerprint;
    const right = result.correct.filter(Boolean).length;
    const took = describeTiming(state);
    if (result.passed) {
      state.status = 'passed';
      await this.save(quiz);
      this.record('quiz-passed', `${who} answered ${right}/${state.questions.length} correctly${took}.`);
      return;
    }
    state.status = 'failed';
    state.closingNotes = state.challenge
      ? [`Nothing on the pull request was dismissed. The challenge stays open until ${who} passes a challenge quiz.`]
      : state.practice
        ? [`Comment \`${this.config.command}\` for new questions.`]
        : await this.handleFailure(state.reviewer, right, state.questions.length);
    await this.save(quiz);
    this.record('quiz-failed', `${who} answered ${right}/${state.questions.length} correctly${took}.`);
  }

  /**
   * When the questions appeared and when the reviewer ticked boxes, from GitHub's edit history. Only reported:
   * someone who read the code before approving answers as fast as someone who asked an AI.
   */
  private answerTiming(quiz: QuizComment, history: CommentHistory): AnswerTiming | undefined {
    const oldestFirst = [...history.edits].reverse();
    const shown = oldestFirst.find((e) => e.editor && loginsEqual(e.editor, quiz.author) && isQuizBody(e.body));
    const ticks = oldestFirst.filter((e) => e.editor && loginsEqual(e.editor, quiz.state.reviewer));
    if (!shown || !ticks.length) return undefined;
    return { shownAt: shown.editedAt, firstAnswerAt: ticks[0]!.editedAt, submittedAt: ticks.at(-1)!.editedAt };
  }

  /**
   * The state blob must be exactly the one in the bot's own latest revision of the comment. This catches pasting
   * an older version of a quiz (e.g. the open version of one whose answers were revealed after grading), moving
   * state between comments, and pruning the bot's revisions from the edit history.
   */
  private checkIntegrity(quiz: QuizComment, history: CommentHistory): Integrity {
    const culprits = [
      ...new Set(
        history.edits.filter((e) => !(e.editor && loginsEqual(e.editor, quiz.author))).map((e) => e.editor ?? 'ghost'),
      ),
    ];
    if (!history.complete) return { ok: false, culprits };
    if (history.edits.length === 0) return { ok: true }; // never edited: the body is what the bot posted
    const ours = history.edits.find((e) => e.editor && loginsEqual(e.editor, quiz.author));
    if (!ours?.body) return { ok: false, culprits };
    const ourSealed = extractSealedState(ours.body);
    if (ourSealed && ourSealed === extractSealedState(quiz.body)) return { ok: true };
    const restore = ourSealed ? this.deps.codec.open(this.prNumber, ourSealed) : null;
    return restore && restore.commentId === quiz.commentId ? { ok: false, restore, culprits } : { ok: false, culprits };
  }

  private async handleTampering(quiz: QuizComment, integrity: { restore?: QuizState; culprits: string[] }): Promise<void> {
    const who = integrity.culprits.map((l) => `\`${l}\``).join(', ') || 'someone';
    if (integrity.restore) {
      quiz.state = integrity.restore;
      if (quiz.state.status === 'open') {
        quiz.state.notice = `This quiz was modified by ${who}, so it was restored. Please select your answers again.`;
      }
      await this.save(quiz);
      this.record('quiz-restored', `Undid changes by ${integrity.culprits.join(', ') || 'unknown'} to the quiz state.`);
      return;
    }
    // Nothing trustworthy to restore: close it without reusing its questions.
    quiz.state.status = 'void';
    quiz.state.voidedBy = integrity.culprits;
    quiz.state.closedReason =
      `The edit history of this quiz was altered (by ${who}), so it can no longer be graded. ` +
      'A new quiz with new questions is posted when needed.';
    await this.save(quiz);
    this.record('quiz-voided', `Quiz for ${mention(quiz.state.reviewer)} had its history altered.`);
  }

  /** Everyone except the reviewer and the bot who edited the quiz comment (checkbox ticks are edits). */
  private intruders(quiz: QuizComment, history: CommentHistory): string[] {
    const intruders = new Set<string>();
    for (const edit of history.edits) {
      if (edit.editor && (loginsEqual(edit.editor, quiz.state.reviewer) || loginsEqual(edit.editor, quiz.author))) continue;
      intruders.add(edit.editor ?? 'ghost');
    }
    return [...intruders];
  }

  private async voidAndRepost(quiz: QuizComment, intruders: string[]): Promise<void> {
    const old = quiz.state;
    const fresh: QuizState = {
      ...structuredClone(old),
      id: randomBytes(8).toString('hex'),
      status: 'open',
      createdAt: this.now(),
      notice:
        `The previous copy of this quiz was edited by ${intruders.map((l) => `\`${l}\``).join(', ')}. ` +
        `Only ${mention(old.reviewer)} may answer, so the answers were reset.`,
    };
    for (const field of ['commentId', 'result', 'voidedBy', 'followUpUrl', 'closingNotes', 'closedReason'] as const) {
      delete fresh[field];
    }
    const replacement = await this.post(fresh);
    old.status = 'void';
    old.voidedBy = intruders;
    old.followUpUrl = replacement.url;
    await this.save(quiz);
    this.record('quiz-voided', `Quiz for ${mention(old.reviewer)} was edited by ${intruders.join(', ')}; reposted.`);
  }

  /** Step 6 of the flow: dismiss the uninformed approval and ask the reviewer to look again. */
  private async handleFailure(reviewer: string, right: number, total: number): Promise<string[]> {
    const who = mention(reviewer);
    const notes: string[] = [];
    const approvals = this.reviews.filter((r) => r.user && loginsEqual(r.user.login, reviewer) && r.state === 'APPROVED');
    let dismissed = 0;
    for (const review of approvals) {
      try {
        await this.gh.dismissReview(
          this.prNumber,
          review.id,
          `PR Quiz: ${right} of ${total} answers were correct, so this approval was dismissed. ` +
            `A new quiz is waiting for ${who} in the conversation; passing it approves the pull request.`,
        );
        review.state = 'DISMISSED';
        dismissed++;
      } catch (error) {
        log.warning(`Could not dismiss review ${review.id}: ${(error as Error).message}`);
        notes.push(`⚠️ Could not dismiss ${who}'s approval (${(error as Error).message}).`);
      }
    }
    if (dismissed) {
      notes.push(`${who}'s approval was dismissed.`);
      this.record('approval-dismissed', `Dismissed ${dismissed} approval(s) by ${who}.`);
    }
    try {
      await this.gh.requestReviewers(this.prNumber, [reviewer]);
      notes.push(`A new review was requested from ${who}.`);
      this.record('review-requested', `Re-requested a review from ${who}.`);
    } catch (error) {
      log.warning(`Could not re-request a review from ${reviewer}: ${(error as Error).message}`);
    }
    return notes;
  }

  // --- Creating quizzes ----------------------------------------------------------------------------------------

  private async ensureQuizzes(): Promise<void> {
    const reviewers = new Map<string, string>(); // key -> login
    for (const login of this.activeApprovers()) reviewers.set(key(login), login);
    for (const quiz of this.quizzes) {
      // A challenge quiz is retaken while its challenge is unmet (below), not because it failed.
      if (quiz.state.challenge) continue;
      const latest = this.quizzesOf(quiz.state.reviewer)
        .filter((q) => !q.state.challenge)
        .at(-1);
      // A failed attempt always earns a retake, even if generating it failed in an earlier run.
      if (latest === quiz && quiz.state.status === 'failed') reviewers.set(key(quiz.state.reviewer), quiz.state.reviewer);
    }
    const candidates = new Map(reviewers);
    // Only a plain `/pr-quiz` asks for a quiz for the commenter.
    const commander = this.verb === 'quiz' ? this.trigger.actor : undefined;
    if (commander) candidates.set(key(commander), commander);
    for (const login of this.unmetChallengees()) candidates.set(key(login), login);

    for (const login of candidates.values()) {
      const who = mention(login);
      let isCommander = !!commander && loginsEqual(login, commander);
      if (this.isChallenged(login)) {
        await this.ensureChallengeQuiz(login, isCommander);
        // A challenged author whose commits are gone can review now: their approval needs a reviewer quiz of its own.
        if (!reviewers.has(key(login)) || !(await this.isEligible(login))) continue;
        isCommander = false; // the challenge quiz answered the command
      }
      // Authors with write access get a practice quiz on request; their pass never counts toward the gate.
      const practice = !(await this.isEligible(login));
      if (practice && !(isCommander && (await this.canPush(login)))) {
        if (isCommander) {
          this.record('quiz-skipped', `${who} cannot take the quiz (no write access).`);
          await this.react(this.trigger.commandCommentId, 'confused');
          await this.explain(`${who}, you can't take a quiz here: you don't have write access to this repository.`);
        } else {
          log.info(`${who} is an author of the change or has no write access, so their approval does not start a quiz.`);
          await this.explainIgnoredApproval(login);
        }
        continue;
      }
      const passed = this.passStatus(login, practice);
      const open = this.openQuiz(login);
      if (passed.status !== 'none' || open) {
        if (isCommander) {
          await this.react(this.trigger.commandCommentId, '+1');
          const what = practice ? 'practice quiz' : 'quiz';
          await this.explain(
            open
              ? `${who}, your ${what} is waiting for your answers: ${open.url}`
              : `${who}, you already passed the ${what} on this version of the change: ${passed.quiz!.url}`,
          );
        }
        continue;
      }
      if (this.config.maxAttempts > 0 && this.attemptHistory(login).failed >= this.config.maxAttempts) {
        await this.lockOut(login);
        if (isCommander) {
          await this.react(this.trigger.commandCommentId, 'confused');
          await this.explain(
            `${who}, you have used all ${this.config.maxAttempts} attempts on this pull request, so no new quiz is generated.`,
          );
        }
        continue;
      }
      if (this.generationPausedFor(login)) continue;
      try {
        await this.createQuiz(login, practice ? 'practice' : 'review');
        if (isCommander) await this.react(this.trigger.commandCommentId, 'rocket');
      } catch (error) {
        const message = (error as Error).message;
        this.errors.push(message);
        log.error(`Could not create a quiz for ${login}: ${message}`);
      }
    }
  }

  /** A challenged author gets a challenge quiz (never a practice quiz) until one passes on the current code. */
  private async ensureChallengeQuiz(login: string, isCommander: boolean): Promise<void> {
    const who = mention(login);
    const open = this.openQuiz(login, 'challenge');
    if (this.challengeMet(login) || open) {
      if (isCommander) {
        await this.react(this.trigger.commandCommentId, '+1');
        await this.explain(
          open
            ? `${who}, your challenge quiz is waiting for your answers: ${open.url}`
            : `${who}, you already passed the challenge quiz on this version of the change.`,
        );
      }
      return;
    }
    if (this.lockedOut(login)) {
      await this.lockOutChallenge(login);
      if (isCommander) {
        await this.react(this.trigger.commandCommentId, 'confused');
        await this.explain(
          `${who}, you have used all ${this.config.maxAttempts} attempts on this challenge, so no new quiz is generated. ` +
            `A reviewer can comment \`${this.config.command} challenge ${who}\` for new attempts.`,
        );
      }
      return;
    }
    if (this.generationPausedFor(login)) return;
    try {
      await this.createQuiz(login, 'challenge');
      if (isCommander) await this.react(this.trigger.commandCommentId, 'rocket');
    } catch (error) {
      const message = (error as Error).message;
      this.errors.push(message);
      log.error(`Could not create a challenge quiz for ${login}: ${message}`);
    }
  }

  /** After a failed generation, only some triggers try again (not every checkbox tick). */
  private generationPausedFor(login: string): boolean {
    if (
      this.previousStatus?.state === 'error' &&
      this.previousStatus.description.startsWith(GENERATION_ERROR_PREFIX) &&
      !RETRY_TRIGGERS.has(this.trigger.kind)
    ) {
      this.generationPaused = true;
      log.info(`Not retrying quiz generation for ${login} on a ${this.trigger.kind} event after an earlier error.`);
      return true;
    }
    return false;
  }

  /** A reviewer who used up all attempts cannot pass; an approval from them is not accepted. */
  private async lockOut(login: string): Promise<void> {
    const who = mention(login);
    for (const review of this.reviews) {
      if (!review.user || !loginsEqual(review.user.login, login) || review.state !== 'APPROVED') continue;
      try {
        await this.gh.dismissReview(
          this.prNumber,
          review.id,
          `PR Quiz: ${who} used all ${this.config.maxAttempts} quiz attempts on this pull request, so this approval does not count. Please ask another reviewer.`,
        );
        review.state = 'DISMISSED';
        this.record('approval-dismissed', `Dismissed approval by ${who} (no attempts left).`);
      } catch (error) {
        log.warning(`Could not dismiss review ${review.id}: ${(error as Error).message}`);
      }
    }
    const last = this.quizzesOf(login)
      .filter((q) => !q.state.challenge)
      .at(-1);
    const note = `${who} has used all ${this.config.maxAttempts} attempts; no new quiz will be generated. Another reviewer needs to approve and pass.`;
    if (last && !last.state.closingNotes?.includes(note)) {
      last.state.closingNotes = [...(last.state.closingNotes ?? []), note];
      await this.save(last);
      this.record('attempts-exhausted', note);
    }
  }

  /** A challenged author without attempts left stays blocked; nothing is dismissed. */
  private async lockOutChallenge(login: string): Promise<void> {
    const who = mention(login);
    const n = this.config.maxAttempts;
    const by = this.challengersOf(login);
    const withdraw = by.length === 1 ? `${listLogins(by)} can withdraw the challenge` : `${listLogins(by)} can withdraw their challenges`;
    const note =
      `${who} has used all ${n} attempts on this challenge, so no new quiz is generated. ` +
      `A reviewer can comment \`${this.config.command} challenge ${who}\` for ${n} new attempts, or ${withdraw}.`;
    const last = this.quizzesOf(login)
      .filter((q) => q.state.challenge)
      .at(-1);
    if (last && !last.state.closingNotes?.includes(note)) {
      last.state.closingNotes = [...(last.state.closingNotes ?? []), note];
      await this.save(last);
      this.record('attempts-exhausted', note);
    }
  }

  private async fetchFileContext(onlyPaths?: ReadonlySet<string>): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    if (!this.config.includeFileContext) return contents;
    const budget = Math.floor(this.config.maxDiffChars * 0.3);
    let used = 0;
    for (const file of contextCandidates(this.changes, onlyPaths)) {
      if (contents.size >= MAX_CONTEXT_FILES || used >= budget) break;
      const text = await this.gh.getFileText(file.path, this.pr.head.sha).catch(() => null);
      if (!text || text.includes('\u0000') || text.length > MAX_CONTEXT_FILE_CHARS || used + text.length > budget) continue;
      contents.set(file.path, text);
      used += text.length;
    }
    return contents;
  }

  private async createQuiz(login: string, kind: QuizKind): Promise<void> {
    // Visible at once: a placeholder that turns into the quiz, and a status saying what the run is doing.
    const writing = { challenge: kind === 'challenge', questions: this.config.questionCount, runUrl: this.deps.runUrl };
    const slot = await this.openSlot(login, renderWriting(login, writing));
    await this.publishStatus({
      state: 'pending',
      context: this.config.statusContext,
      description: `Writing a ${kind === 'challenge' ? 'challenge quiz' : 'quiz'} for ${mention(login)}…`,
      target_url: this.deps.runUrl ?? slot.html_url,
    });
    try {
      await this.writeQuiz(login, kind, slot);
    } catch (error) {
      const body = renderWritingFailed(login, { ...writing, reason: (error as Error).message, command: this.config.command });
      await this.gh.updateComment(slot.id, body).catch((e: Error) => log.warning(`Could not update ${slot.html_url}: ${e.message}`));
      throw error;
    }
  }

  /** The comment a quiz is written into: the placeholder an earlier run left for this reviewer, or a new one. */
  private async openSlot(login: string, body: string): Promise<IssueComment> {
    const left = this.slots.get(key(login));
    this.slots.delete(key(login));
    if (left) return left.body === body ? left : await this.gh.updateComment(left.id, body);
    return await this.gh.createComment(this.prNumber, body);
  }

  /** Placeholders still saying "writing" belong to a run that stopped early: say so, instead of spinning forever. */
  private async closeStoppedSlots(): Promise<void> {
    for (const slot of this.slots.values()) {
      const reviewer = pendingReviewer(slot.body);
      if (!reviewer || !isWriting(slot.body)) continue;
      const challenge = (slot.body ?? '').includes('PR Quiz challenge');
      const body = renderWritingStopped(reviewer, {
        challenge,
        questions: this.config.questionCount,
        command: this.config.command,
      });
      await this.gh.updateComment(slot.id, body).then(
        () => this.record('quiz-stopped', `Writing a quiz for ${mention(reviewer)} stopped in an earlier run: ${slot.html_url}`),
        (e: Error) => log.warning(`Could not update ${slot.html_url}: ${e.message}`),
      );
    }
    this.slots.clear();
  }

  private async writeQuiz(login: string, kind: QuizKind, slot: IssueComment): Promise<void> {
    const lastPass = this.quizzesOf(login)
      .filter((q) => q.state.status === 'passed' && quizKind(q.state) === kind)
      .at(-1);
    const changed = lastPass ? changedSince(lastPass.state.files, this.changes) : null;
    const scoped = changed ? new Set(changed.filter((p) => p in this.changes.fileFingerprints)) : undefined;
    const incremental = !!scoped && scoped.size > 0;
    const onlyPaths = incremental ? scoped : undefined;

    const context = renderPullRequestContext(
      {
        title: this.pr.title,
        body: this.pr.body,
        author: this.pr.user?.login ?? 'unknown',
        baseRef: this.pr.base.ref,
        headRef: this.pr.head.ref,
      },
      this.changes,
      { maxChars: this.config.maxDiffChars, onlyPaths, fileContents: await this.fetchFileContext(onlyPaths) },
    );
    if (context.truncatedPaths.length || context.omittedPaths.length) {
      log.warning(
        `Diff exceeds max-diff-chars: truncated ${context.truncatedPaths.length} and omitted ${context.omittedPaths.length} file(s).`,
      );
    }

    const history = this.attemptHistory(login, kind === 'challenge' ? 'challenge' : 'other');
    // A backup of the challenges this quiz answers, in case their records are lost.
    const refs: ChallengeRef[] | undefined =
      kind === 'challenge'
        ? this.activeChallenges(login).map(({ id, by, at, commandCommentId }) => ({ id, by, at, commandCommentId }))
        : undefined;
    const generated = await generateQuiz(this.deps.llm, {
      context: context.text,
      reviewer: login,
      questionCount: this.config.questionCount,
      optionCount: this.config.optionCount,
      previousQuestions: history.asked,
      incremental,
      extraInstructions: this.config.extraInstructions,
      verify: this.config.verifyQuestions,
      audience: kind === 'review' ? 'reviewer' : 'author',
      challengers: kind === 'challenge' ? this.challengersOf(login) : undefined,
    });

    const fileCount = Object.keys(this.changes.fileFingerprints).length;
    const state: QuizState = {
      v: 1,
      id: randomBytes(8).toString('hex'),
      reviewer: login,
      attempt: history.failed + 1,
      failedBefore: history.failed,
      asked: history.asked,
      headSha: this.pr.head.sha,
      fingerprint: this.changes.fingerprint,
      files: fileCount <= MAX_STORED_FILE_FINGERPRINTS ? this.changes.fileFingerprints : undefined,
      scope: incremental ? 'incremental' : 'full',
      practice: kind === 'practice' || undefined,
      challenge: refs ? { refs } : undefined,
      attested: true,
      status: 'open',
      questions: generated.questions,
      model: this.deps.llm.model,
      createdAt: this.now(),
    };
    const quiz = await this.post(state, slot);
    const verified = this.config.verifyQuestions ? `, ${generated.verifiedCount} verified, ${generated.droppedCount} dropped` : '';
    this.record(
      'quiz-posted',
      `${kind === 'challenge' ? 'Challenge quiz' : 'Quiz'} for ${mention(login)} (attempt ${state.attempt}, ${state.scope}, ` +
        `${state.questions.length} questions${verified}): ${quiz.url}`,
    );
  }

  // --- Gate, status and bot review -----------------------------------------------------------------------------

  /** Reviewers alone: every active challenge is required on top, however `require-all-approvers` is set. */
  private reviewersSatisfied(): boolean {
    if (!this.passes().length) return false;
    if (!this.config.requireAllApprovers) return true;
    return this.activeApprovers()
      .filter((login) => this.eligibility.get(key(login)) === true)
      .every((login) => this.passStatus(login).status === 'valid');
  }

  private evaluateGate(): CommitStatus {
    const context = this.config.statusContext;
    const eligibleApprovers = this.activeApprovers().filter((login) => this.eligibility.get(key(login)) === true);

    if (!this.changes.hasReadableChanges) {
      // Nothing a quiz could cover (only ignored or binary files): a plain approval of the latest commit counts.
      const approvers = eligibleApprovers.filter((login) => this.approvedLatestCommit(login));
      return approvers.length
        ? { state: 'success', context, description: `No readable diff to quiz on; approved by ${listLogins(approvers)}` }
        : { state: 'pending', context, description: 'No readable diff to quiz on; waiting for an approval of the latest commit' };
    }

    const passers = this.passes();
    const pendingApprovers = eligibleApprovers.filter((login) => this.passStatus(login).status !== 'valid');
    const open = this.openQuizzes();
    const satisfied = this.reviewersSatisfied();
    const unmet = this.unmetChallengees();
    const passedBy = `Passed by ${listLogins(passers.map((q) => q.state.reviewer))}`;

    if (satisfied && !unmet.length && !this.challengesUnverified) {
      const met = this.challengees();
      return {
        state: 'success',
        context,
        description: met.length ? `${passedBy}; challenge passed by ${listLogins(met)}` : passedBy,
        target_url: passers.at(-1)!.url,
      };
    }
    if (this.errors.length) {
      return {
        state: 'error',
        context,
        description: `${GENERATION_ERROR_PREFIX} ${this.errors[0]}. Comment ${this.config.command} to retry.`,
        target_url: this.pr.html_url,
      };
    }
    if (this.verificationErrors.length) {
      return {
        state: 'error',
        context,
        description: 'Could not verify a quiz or challenge (GitHub API error); it is checked again on the next event.',
        target_url: this.pr.html_url,
      };
    }
    if (open.length) {
      const takers = open.map((q) => `${mention(q.state.reviewer)}${q.state.challenge ? ' (challenged)' : ''}`);
      return {
        state: 'pending',
        context,
        description: `Waiting for ${joinList(takers)} to answer the quiz`,
        target_url: open[0]!.url,
      };
    }
    const locked = unmet.filter((login) => this.lockedOut(login));
    if (locked.length) {
      return {
        state: 'pending',
        context,
        description:
          `${listLogins(locked)} used all ${this.config.maxAttempts} challenge attempts; ` +
          `a reviewer can comment "${this.config.command} challenge ${locked.map(mention).join(' ')}" for more`,
        target_url:
          this.quizzesOf(locked[0]!)
            .filter((q) => q.state.challenge)
            .at(-1)?.url ?? this.pr.html_url,
      };
    }
    if (satisfied) {
      return {
        state: 'pending',
        context,
        description: `${passedBy}; waiting for a challenge quiz for ${listLogins(unmet)}`,
        target_url: this.pr.html_url,
      };
    }
    const reapprove = [...new Set(this.quizzes.map((q) => q.state.reviewer))].filter(
      (login) => this.eligibility.get(key(login)) === true && this.passStatus(login).status === 'needs-approval',
    );
    if (reapprove.length) {
      return {
        state: 'pending',
        context,
        description: `Ignored or binary files changed since ${listLogins(reapprove)} passed; approve the latest commit to confirm`,
        target_url: this.pr.html_url,
      };
    }
    if (pendingApprovers.length) {
      return {
        state: 'pending',
        context,
        description: `Approval by ${listLogins(pendingApprovers)} is not backed by a passed quiz`,
        target_url: this.pr.html_url,
      };
    }
    if (unmet.length) {
      return {
        state: 'pending',
        context,
        description: `Waiting for a challenge quiz for ${listLogins(unmet)}`,
        target_url: this.pr.html_url,
      };
    }
    return {
      state: 'pending',
      context,
      description: `Waiting for an approving review (reviewers can also comment ${this.config.command})`,
      target_url: this.pr.html_url,
    };
  }

  private async publishStatus(status: CommitStatus): Promise<void> {
    const current = this.published ?? this.previousStatus;
    const description = status.description.length > 140 ? status.description.slice(0, 139) + '…' : status.description;
    if (
      current &&
      current.state === status.state &&
      current.description === description &&
      (current.target_url ?? '') === (status.target_url ?? '')
    ) {
      return;
    }
    await this.gh.setStatus(this.pr.head.sha, { ...status, description });
    this.published = { ...status, description };
    this.record('status', `${status.context}: ${status.state} (${description})`);
  }

  /**
   * Steps 4 and 9 of the flow: the bot blocks while a quiz is pending or a challenge is unmet (even when it can't
   * be generated or the author has no attempts left) and approves once the gate passes.
   */
  private async syncBotReview(satisfied: boolean): Promise<void> {
    const botReviews = this.reviews.filter((r) => r.user?.type === 'Bot' && (r.body ?? '').includes(REVIEW_MARKER));
    const latest = botReviews.filter((r) => r.state !== 'COMMENTED').at(-1);
    const open = this.openQuizzes();
    const unmet = this.unmetChallengees();
    const blocking = open.length > 0 || unmet.length > 0;
    const challengedBy = (login: string) => listLogins(this.challengersOf(login)) || 'a reviewer';
    const passes = this.passes();
    const passers = passes.map((q) => q.state.reviewer);
    const sha = this.pr.head.sha;

    if (satisfied && passers.length === 0) {
      // Green without a quiz (nothing a quiz could cover): the human approval stands; the bot just stops blocking.
      if (latest?.state === 'CHANGES_REQUESTED') await this.dismissBotReview(latest, 'PR Quiz: no readable diff to quiz on.');
      return;
    }
    if (satisfied) {
      if (latest?.state === 'APPROVED') return;
      const attested = passes.every((q) => q.state.attested)
        ? ` ${passers.length === 1 ? 'The reviewer' : 'Each reviewer'} confirmed answering from their own reading of the code, not by asking an AI.`
        : '';
      const challenges = this.challengees()
        .map((login) => ` ${mention(login)} also passed the challenge by ${challengedBy(login)}.`)
        .join('');
      const body = `${REVIEW_MARKER}\n✅ **PR Quiz passed** by ${listLogins(passers)}: every question about this change was answered correctly, so the approval is backed by understanding.${attested}${challenges}`;
      try {
        await this.gh.createReview(this.prNumber, 'APPROVE', body, sha);
        this.record('bot-approved', `Approved on behalf of ${listLogins(passers)}.`);
      } catch (error) {
        log.warning(`The bot could not approve: ${reviewRefusal(error)} The commit status still reports the result.`);
        if (latest?.state === 'CHANGES_REQUESTED') await this.dismissBotReview(latest, 'PR Quiz passed.');
      }
      return;
    }

    if (blocking && latest?.state !== 'CHANGES_REQUESTED') {
      const waiting = open.map(
        (q) =>
          `- ${mention(q.state.reviewer)}${q.state.challenge ? ` (challenged by ${challengedBy(q.state.reviewer)})` : ''}: ${q.url}`,
      );
      for (const login of unmet) {
        if (open.some((q) => loginsEqual(q.state.reviewer, login))) continue;
        waiting.push(
          this.lockedOut(login)
            ? `- ${mention(login)}: used all ${this.config.maxAttempts} attempts on the challenge by ${challengedBy(login)}`
            : `- ${mention(login)}: challenge quiz by ${challengedBy(login)} not posted yet`,
        );
      }
      const challenged = this.activeChallenges().length ? ' Challenged authors must pass their own quiz too.' : '';
      const body =
        `${REVIEW_MARKER}\n🧠 **PR Quiz pending.** An approval counts once the reviewer answers a few questions about this change correctly.${challenged}\n\n` +
        `Waiting for:\n${waiting.join('\n')}`;
      try {
        await this.gh.createReview(this.prNumber, 'REQUEST_CHANGES', body, sha);
        this.record('bot-requested-changes', 'Blocking until the quiz is passed.');
      } catch (error) {
        log.warning(`The bot could not submit its pending review: ${reviewRefusal(error)}`);
      }
      return;
    }

    if (!blocking && latest?.state === 'APPROVED') {
      // Only the challenge records could not be read (a transient API error): the error status already blocks the
      // merge, and the next healthy run settles it, so the approval is not withdrawn on a guess.
      if (this.challengesUnverified && this.changes.hasReadableChanges && this.reviewersSatisfied()) return;
      await this.dismissBotReview(latest, 'PR Quiz: the approval is no longer backed by a passed quiz.');
    }
  }

  private async dismissBotReview(review: Review, message: string): Promise<void> {
    try {
      await this.gh.dismissReview(this.prNumber, review.id, message);
      review.state = 'DISMISSED';
      this.record('bot-review-dismissed', message);
    } catch (error) {
      log.warning(`Could not dismiss the bot's own review: ${(error as Error).message}`);
    }
  }

  /** Answers the command comment of this run in one line, when its outcome isn't a new quiz. */
  private async explain(text: string): Promise<void> {
    const id = this.trigger.commandCommentId;
    if (this.trigger.kind !== 'command' || id === undefined) return;
    const quote = this.comments.find((c) => c.id === id)?.body?.split(/\r?\n/, 1)[0];
    await this.reply(`command-${id}`, text, quote);
  }

  /** Tells an approver once why their approval can't count, when it was this run's trigger. */
  private async explainIgnoredApproval(login: string): Promise<void> {
    if (this.trigger.kind !== 'approval' || !loginsEqual(this.trigger.actor, login)) return;
    const review = this.reviews.filter((r) => r.user && loginsEqual(r.user.login, login) && r.state === 'APPROVED').at(-1);
    if (!review) return;
    const who = mention(login);
    const author = this.isAuthor(login);
    const why = author
      ? 'you are an author of this change (you opened the pull request or committed to it)'
      : "you don't have write access to this repository";
    const practice = author && (await this.canPush(login)) ? ` You can still comment \`${this.config.command}\` for a practice quiz.` : '';
    await this.reply(
      `review-${review.id}`,
      `${who}, your approval doesn't start a quiz and doesn't count toward the gate, because ${why}. ` +
        `Another reviewer needs to approve and pass a quiz.${practice}`,
    );
  }

  /** Posts a reply at most once per key, so re-runs of the same event stay quiet. */
  private async reply(replyKey: string, text: string, quote?: string): Promise<void> {
    const marker = replyMarker(replyKey);
    if (this.comments.some((c) => c.user?.type === 'Bot' && c.body?.includes(marker))) return;
    try {
      const comment = await this.gh.createComment(this.prNumber, renderReply(replyKey, text, quote));
      this.comments.push(comment);
      this.record('replied', text);
    } catch (error) {
      log.warning(`Could not reply: ${(error as Error).message}`);
    }
  }

  private async react(commentId: number | undefined, content: '+1' | 'eyes' | 'confused' | 'rocket'): Promise<void> {
    if (!commentId) return;
    await this.gh.addReaction(commentId, content).catch((error: Error) => log.debug(`Reaction failed: ${error.message}`));
  }
}

export function reconcile(deps: ReconcileDeps, prNumber: number, trigger: Trigger): Promise<ReconcileResult> {
  return new Reconciliation(deps, prNumber, trigger).run();
}
