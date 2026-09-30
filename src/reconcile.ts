import { randomBytes } from 'node:crypto';
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
import { parseOpenQuiz } from './quiz/parse.ts';
import { extractSealedState, isQuizBody, mention, renderPlaceholder, renderQuiz, REVIEW_MARKER } from './quiz/render.ts';
import type { QuizComment, QuizState } from './quiz/types.ts';
import { log } from './util/action.ts';

export type TriggerKind = 'approval' | 'review' | 'comment-edit' | 'command' | 'push' | 'manual';

export interface Trigger {
  kind: TriggerKind;
  /** User who caused the event (reviewer, commenter, ...). */
  actor?: string;
  /** Comment id of a `/pr-quiz` command. */
  commandCommentId?: number;
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

const key = (login: string) => login.replace(/\[bot\]$/i, '').toLowerCase();

/** Why GitHub refused a review by the bot, in words that point at the fix. */
function reviewRefusal(error: unknown): string {
  const message = (error as Error).message;
  if (/own pull request/i.test(message)) return `${message}. GitHub does not let the bot review a pull request it opened itself.`;
  if (/not permitted/i.test(message)) {
    return `${message}. For GITHUB_TOKEN, enable "Allow GitHub Actions to create and approve pull requests" in the repository (and organization) settings.`;
  }
  return message;
}

function listLogins(logins: string[]): string {
  const m = logins.map(mention);
  return m.length <= 1 ? (m[0] ?? '') : `${m.slice(0, -1).join(', ')} and ${m[m.length - 1]}`;
}

type Integrity =
  | { ok: true }
  | { ok: false; restore?: QuizState; culprits: string[] };

type PassStatus = 'valid' | 'needs-approval' | 'none';

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
  private committers = new Set<string>();
  private previousStatus: CommitStatus | null = null;
  /** Generation was skipped because an earlier attempt failed and this trigger is not a retry. */
  private generationPaused = false;
  private pr!: PullRequest;
  private reviews: Review[] = [];
  private quizzes: QuizComment[] = [];
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
    this.committers = new Set(committers.map(key));
    this.previousStatus = previousStatus;
    this.changes = buildChangeSet(files, this.config.ignorePaths);
    this.quizzes = await this.loadQuizzes(comments);
    if (this.changes.possiblyIncomplete) log.warning('GitHub lists at most 3000 files; the quiz only sees those.');

    for (const quiz of [...this.quizzes]) {
      if (quiz.state.status === 'open') await this.processOpenQuiz(quiz);
    }
    if (this.changes.hasReadableChanges) {
      await this.ensureQuizzes();
    } else if (this.trigger.kind === 'command') {
      await this.react(this.trigger.commandCommentId, 'confused');
    }
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
   * can't cover), the reviewer must approve the latest commit again for the pass to keep counting.
   */
  private passStatus(login: string): { status: PassStatus; quiz?: QuizComment } {
    const quiz = this.quizzesOf(login)
      .filter((q) => q.state.status === 'passed' && q.state.fingerprint === this.changes.fingerprint)
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

  private openQuiz(login: string): QuizComment | undefined {
    return this.quizzesOf(login).find((q) => q.state.status === 'open' && q.state.fingerprint === this.changes.fingerprint);
  }

  private openQuizzes(): QuizComment[] {
    return this.quizzes.filter((q) => q.state.status === 'open' && q.state.fingerprint === this.changes.fingerprint);
  }

  /**
   * Failed attempts and questions seen so far. Every quiz carries this history forward in its sealed state, so
   * deleting old quiz comments neither resets the attempt limit nor brings back questions whose answers were shown.
   */
  private attemptHistory(login: string): { failed: number; asked: string[] } {
    const mine = this.quizzesOf(login);
    let failed = mine.filter((q) => q.state.status === 'failed').length;
    const asked: string[] = [];
    for (const quiz of mine) {
      failed = Math.max(failed, (quiz.state.failedBefore ?? 0) + (quiz.state.status === 'failed' ? 1 : 0));
      asked.push(...(quiz.state.asked ?? []), ...quiz.state.questions.map((q) => q.text.slice(0, 200)));
    }
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

  // --- Eligibility ---------------------------------------------------------------------------------------------

  /** Who may take a quiz (and so be approved for): not an author of the change, and able to push. */
  private async isEligible(login: string): Promise<boolean> {
    const cached = this.eligibility.get(key(login));
    if (cached !== undefined) return cached;
    let eligible = false;
    if (!loginsEqual(login, this.pr.user?.login) && !this.committers.has(key(login))) {
      try {
        eligible = await this.gh.hasWriteAccess(login);
      } catch (error) {
        log.warning(`Could not read ${login}'s permission (${(error as Error).message}); falling back to author association.`);
        eligible = this.reviews.some(
          (r) => r.user && loginsEqual(r.user.login, login) && TRUSTED_ASSOCIATIONS.has(r.author_association ?? ''),
        );
      }
    }
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

  /** Posts a placeholder first so the state can be sealed together with the id of the comment it lives in. */
  private async post(state: QuizState): Promise<QuizComment> {
    const placeholder = await this.gh.createComment(this.prNumber, renderPlaceholder(state.reviewer));
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
    return quiz;
  }

  /** Failed or outdated quizzes link to the reviewer's next open quiz, whichever run created it. */
  private async linkFollowUps(): Promise<void> {
    for (const quiz of this.quizzes) {
      const { state } = quiz;
      if ((state.status !== 'failed' && state.status !== 'outdated') || state.followUpUrl) continue;
      const next = this.quizzes.find(
        (q) => q.commentId > quiz.commentId && q.state.status === 'open' && loginsEqual(q.state.reviewer, state.reviewer),
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

    const { state } = quiz;
    const who = mention(state.reviewer);
    if (state.fingerprint !== this.changes.fingerprint) {
      state.status = 'outdated';
      await this.save(quiz);
      this.record('quiz-outdated', `Quiz for ${who} no longer matches the code after new commits.`);
      return;
    }
    const duplicate = this.quizzesOf(state.reviewer).find(
      (q) => q !== quiz && q.state.status === 'open' && q.commentId > quiz.commentId,
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
    state.result = { answers: result.answers, correct: result.correct, gradedAt: this.now() };
    state.fullFingerprint = this.changes.fullFingerprint;
    const right = result.correct.filter(Boolean).length;
    if (result.passed) {
      state.status = 'passed';
      await this.save(quiz);
      this.record('quiz-passed', `${who} answered ${right}/${state.questions.length} correctly.`);
      return;
    }
    state.status = 'failed';
    state.closingNotes = await this.handleFailure(state.reviewer, right, state.questions.length);
    await this.save(quiz);
    this.record('quiz-failed', `${who} answered ${right}/${state.questions.length} correctly.`);
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
    const candidates = new Map<string, string>(); // key -> login
    for (const login of this.activeApprovers()) candidates.set(key(login), login);
    for (const quiz of this.quizzes) {
      const latest = this.quizzesOf(quiz.state.reviewer).at(-1);
      // A failed attempt always earns a retake, even if generating it failed in an earlier run.
      if (latest === quiz && quiz.state.status === 'failed') candidates.set(key(quiz.state.reviewer), quiz.state.reviewer);
    }
    const commander = this.trigger.kind === 'command' ? this.trigger.actor : undefined;
    if (commander) candidates.set(key(commander), commander);

    for (const login of candidates.values()) {
      const who = mention(login);
      const isCommander = !!commander && loginsEqual(login, commander);
      if (this.passStatus(login).status !== 'none' || this.openQuiz(login)) {
        if (isCommander) await this.react(this.trigger.commandCommentId, '+1');
        continue;
      }
      if (!(await this.isEligible(login))) {
        const why = `${who} cannot take the quiz (an author of the change, or no write access).`;
        if (isCommander) {
          this.record('quiz-skipped', why);
          await this.react(this.trigger.commandCommentId, 'confused');
        } else {
          log.info(why);
        }
        continue;
      }
      if (this.config.maxAttempts > 0 && this.attemptHistory(login).failed >= this.config.maxAttempts) {
        await this.lockOut(login);
        if (isCommander) await this.react(this.trigger.commandCommentId, 'confused');
        continue;
      }
      if (
        this.previousStatus?.state === 'error' &&
        this.previousStatus.description.startsWith(GENERATION_ERROR_PREFIX) &&
        !RETRY_TRIGGERS.has(this.trigger.kind)
      ) {
        this.generationPaused = true;
        log.info(`Not retrying quiz generation for ${login} on a ${this.trigger.kind} event after an earlier error.`);
        continue;
      }
      try {
        await this.createQuiz(login);
        if (isCommander) await this.react(this.trigger.commandCommentId, 'rocket');
      } catch (error) {
        const message = (error as Error).message;
        this.errors.push(message);
        log.error(`Could not create a quiz for ${login}: ${message}`);
      }
    }
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
    const last = this.quizzesOf(login).at(-1);
    const note = `${who} has used all ${this.config.maxAttempts} attempts; no new quiz will be generated. Another reviewer needs to approve and pass.`;
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

  private async createQuiz(login: string): Promise<void> {
    const lastPass = this.quizzesOf(login)
      .filter((q) => q.state.status === 'passed')
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

    const history = this.attemptHistory(login);
    const generated = await generateQuiz(this.deps.llm, {
      context: context.text,
      reviewer: login,
      questionCount: this.config.questionCount,
      optionCount: this.config.optionCount,
      previousQuestions: history.asked,
      incremental,
      extraInstructions: this.config.extraInstructions,
      verify: this.config.verifyQuestions,
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
      status: 'open',
      questions: generated.questions,
      model: this.deps.llm.model,
      createdAt: this.now(),
    };
    const quiz = await this.post(state);
    const verified = this.config.verifyQuestions ? `, ${generated.verifiedCount} verified, ${generated.droppedCount} dropped` : '';
    this.record(
      'quiz-posted',
      `Quiz for ${mention(login)} (attempt ${state.attempt}, ${state.scope}, ${state.questions.length} questions${verified}): ${quiz.url}`,
    );
  }

  // --- Gate, status and bot review -----------------------------------------------------------------------------

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
    const satisfied = passers.length > 0 && (!this.config.requireAllApprovers || pendingApprovers.length === 0);

    if (satisfied) {
      return {
        state: 'success',
        context,
        description: `Passed by ${listLogins(passers.map((q) => q.state.reviewer))}`,
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
        description: 'Could not verify a quiz (GitHub API error); it is checked again on the next event.',
        target_url: this.pr.html_url,
      };
    }
    if (open.length) {
      return {
        state: 'pending',
        context,
        description: `Waiting for ${listLogins(open.map((q) => q.state.reviewer))} to answer the quiz`,
        target_url: open[0]!.url,
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
    return {
      state: 'pending',
      context,
      description: `Waiting for an approving review (reviewers can also comment ${this.config.command})`,
      target_url: this.pr.html_url,
    };
  }

  private async publishStatus(status: CommitStatus): Promise<void> {
    const current = this.previousStatus;
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
    this.record('status', `${status.context}: ${status.state} (${description})`);
  }

  /** Steps 4 and 9 of the flow: the bot blocks while a quiz is pending and approves once the gate passes. */
  private async syncBotReview(satisfied: boolean): Promise<void> {
    const botReviews = this.reviews.filter((r) => r.user?.type === 'Bot' && (r.body ?? '').includes(REVIEW_MARKER));
    const latest = botReviews.filter((r) => r.state !== 'COMMENTED').at(-1);
    const open = this.openQuizzes();
    const passers = this.passes().map((q) => q.state.reviewer);
    const sha = this.pr.head.sha;

    if (satisfied && passers.length === 0) {
      // Green without a quiz (nothing a quiz could cover): the human approval stands; the bot just stops blocking.
      if (latest?.state === 'CHANGES_REQUESTED') await this.dismissBotReview(latest, 'PR Quiz: no readable diff to quiz on.');
      return;
    }
    if (satisfied) {
      if (latest?.state === 'APPROVED') return;
      const body = `${REVIEW_MARKER}\n✅ **PR Quiz passed** by ${listLogins(passers)}: every question about this change was answered correctly, so the approval is backed by understanding.`;
      try {
        await this.gh.createReview(this.prNumber, 'APPROVE', body, sha);
        this.record('bot-approved', `Approved on behalf of ${listLogins(passers)}.`);
      } catch (error) {
        log.warning(`The bot could not approve: ${reviewRefusal(error)} The commit status still reports the result.`);
        if (latest?.state === 'CHANGES_REQUESTED') await this.dismissBotReview(latest, 'PR Quiz passed.');
      }
      return;
    }

    if (open.length && latest?.state !== 'CHANGES_REQUESTED') {
      const links = open.map((q) => `- ${mention(q.state.reviewer)}: ${q.url}`).join('\n');
      const body =
        `${REVIEW_MARKER}\n🧠 **PR Quiz pending.** An approval counts once the reviewer answers a few questions about this change correctly.\n\n` +
        `Waiting for:\n${links}`;
      try {
        await this.gh.createReview(this.prNumber, 'REQUEST_CHANGES', body, sha);
        this.record('bot-requested-changes', 'Blocking until the quiz is passed.');
      } catch (error) {
        log.warning(`The bot could not submit its pending review: ${reviewRefusal(error)}`);
      }
      return;
    }

    if (!open.length && latest?.state === 'APPROVED') {
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

  private async react(commentId: number | undefined, content: '+1' | 'eyes' | 'confused' | 'rocket'): Promise<void> {
    if (!commentId) return;
    await this.gh.addReaction(commentId, content).catch((error: Error) => log.debug(`Reaction failed: ${error.message}`));
  }
}

export function reconcile(deps: ReconcileDeps, prNumber: number, trigger: Trigger): Promise<ReconcileResult> {
  return new Reconciliation(deps, prNumber, trigger).run();
}
