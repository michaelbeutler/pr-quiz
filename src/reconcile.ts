import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import { buildChangeSet, changedSince, contextCandidates, renderPullRequestContext, type ChangeSet } from './diff.ts';
import {
  loginsEqual,
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
import { extractSealedState, isQuizBody, mention, renderQuiz, REVIEW_MARKER } from './quiz/render.ts';
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

const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const MAX_STORED_FILE_FINGERPRINTS = 300;
/** GitHub rejects comments longer than 65,536 characters. */
const MAX_COMMENT_CHARS = 65_000;
const MAX_CONTEXT_FILES = 15;
const MAX_CONTEXT_FILE_CHARS = 60_000;

const key = (login: string) => login.replace(/\[bot\]$/i, '').toLowerCase();

function listLogins(logins: string[]): string {
  const m = logins.map(mention);
  return m.length <= 1 ? (m[0] ?? '') : `${m.slice(0, -1).join(', ')} and ${m[m.length - 1]}`;
}

/**
 * One reconciliation of a pull request. Every trigger runs the full loop against GitHub's current state, so
 * missed, duplicated or reordered webhook events cannot leave the quiz in an inconsistent state.
 */
class Reconciliation {
  readonly actions: BotAction[] = [];
  private readonly errors: string[] = [];
  private readonly deps: ReconcileDeps;
  private readonly prNumber: number;
  private readonly trigger: Trigger;
  private readonly permissionCache = new Map<string, boolean>();
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
    if (this.trigger.kind === 'command' && this.trigger.commandCommentId) {
      await this.react(this.trigger.commandCommentId, 'eyes');
    }

    const [reviews, comments, files] = await Promise.all([
      this.gh.listReviews(this.prNumber),
      this.gh.listComments(this.prNumber),
      this.gh.listFiles(this.prNumber),
    ]);
    this.reviews = reviews;
    this.changes = buildChangeSet(files, this.config.ignorePaths);
    this.quizzes = this.loadQuizzes(comments);
    if (this.changes.possiblyIncomplete) log.warning('GitHub lists at most 3000 files; the quiz only sees those.');

    for (const quiz of [...this.quizzes]) {
      if (quiz.state.status === 'open') await this.processOpenQuiz(quiz);
    }
    if (this.changes.hasReadableChanges) await this.ensureQuizzes();
    await this.linkFollowUps();

    const gate = this.evaluateGate();
    await this.publishStatus(gate);
    if (this.config.submitReviews) await this.syncBotReview(gate.state === 'success');
    return {
      gate: gate.state === 'success' ? 'passed' : gate.state === 'error' ? 'error' : 'pending',
      description: gate.description,
      actions: this.actions,
    };
  }

  // --- Loading -----------------------------------------------------------------------------------------------

  private loadQuizzes(comments: IssueComment[]): QuizComment[] {
    const quizzes: QuizComment[] = [];
    for (const comment of comments) {
      if (comment.user?.type !== 'Bot' || !isQuizBody(comment.body)) continue;
      const state = this.deps.codec.open(this.prNumber, extractSealedState(comment.body)!);
      if (!state) {
        log.info(`Ignoring quiz comment ${comment.id}: its state cannot be decrypted with the current secret.`);
        continue;
      }
      quizzes.push({
        commentId: comment.id,
        nodeId: comment.node_id,
        url: comment.html_url,
        body: comment.body,
        createdAt: comment.created_at,
        author: comment.user.login,
        state,
      });
    }
    return quizzes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commentId - b.commentId);
  }

  private quizzesOf(login: string): QuizComment[] {
    return this.quizzes.filter((q) => loginsEqual(q.state.reviewer, login));
  }

  private validPass(login: string): QuizComment | undefined {
    return this.quizzesOf(login).find((q) => q.state.status === 'passed' && q.state.fingerprint === this.changes.fingerprint);
  }

  private openQuiz(login: string): QuizComment | undefined {
    return this.quizzesOf(login).find((q) => q.state.status === 'open' && q.state.fingerprint === this.changes.fingerprint);
  }

  /** Latest review decision of a user; comments don't change a decision on GitHub. */
  private latestDecision(login: string): Review['state'] | undefined {
    return this.reviews.filter(
      (r) => r.user && loginsEqual(r.user.login, login) && r.state !== 'COMMENTED' && r.state !== 'PENDING',
    ).at(-1)?.state;
  }

  /** One valid passed quiz per reviewer, ignoring reviewers who have since requested changes. */
  private passes(): QuizComment[] {
    const byReviewer = new Map<string, QuizComment>();
    for (const quiz of this.quizzes) {
      if (quiz.state.status !== 'passed' || quiz.state.fingerprint !== this.changes.fingerprint) continue;
      if (this.latestDecision(quiz.state.reviewer) === 'CHANGES_REQUESTED') continue;
      byReviewer.set(key(quiz.state.reviewer), quiz);
    }
    return [...byReviewer.values()];
  }

  private openQuizzes(): QuizComment[] {
    return this.quizzes.filter((q) => q.state.status === 'open' && q.state.fingerprint === this.changes.fingerprint);
  }

  private failedCount(login: string): number {
    return this.quizzesOf(login).filter((q) => q.state.status === 'failed').length;
  }

  /** Humans whose latest review decision is an approval. */
  private activeApprovers(): string[] {
    const latest = new Map<string, Review>();
    for (const review of this.reviews) {
      if (!review.user || review.user.type === 'Bot') continue;
      if (review.state === 'COMMENTED' || review.state === 'PENDING') continue;
      latest.set(key(review.user.login), review);
    }
    return [...latest.values()]
      .filter((r) => r.state === 'APPROVED' && !loginsEqual(r.user!.login, this.pr.user?.login))
      .map((r) => r.user!.login);
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

  private async post(state: QuizState): Promise<QuizComment> {
    const comment = await this.gh.createComment(this.prNumber, this.render(state));
    const quiz: QuizComment = {
      commentId: comment.id,
      nodeId: comment.node_id,
      url: comment.html_url,
      body: comment.body,
      createdAt: comment.created_at,
      author: comment.user?.login ?? '',
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
    const { state } = quiz;
    const who = mention(state.reviewer);
    if (state.fingerprint !== this.changes.fingerprint) {
      state.status = 'outdated';
      await this.save(quiz);
      this.record('quiz-outdated', `Quiz for ${who} no longer matches the code after new commits.`);
      return;
    }
    const duplicate = this.quizzesOf(state.reviewer).find(
      (q) => q !== quiz && q.state.status === 'open' && q.createdAt > quiz.createdAt,
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

    let intruders: string[];
    try {
      intruders = await this.findIntruders(quiz);
    } catch (error) {
      state.notice =
        'Could not verify who ticked the answers (GitHub API error). Untick and tick **Submit answers** to try again.';
      await this.save(quiz, parsed.selections, false);
      this.errors.push(`Could not read the quiz edit history: ${(error as Error).message}`);
      return;
    }
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

  /** Everyone except the reviewer and the bot who edited the quiz comment (checkbox ticks are edits). */
  private async findIntruders(quiz: QuizComment): Promise<string[]> {
    const edits = await this.gh.getCommentEdits(quiz.nodeId);
    const intruders = new Set<string>();
    for (const edit of edits) {
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
    delete fresh.result;
    delete fresh.voidedBy;
    delete fresh.followUpUrl;
    delete fresh.closingNotes;
    delete fresh.closedReason;
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

  private async canTakeQuiz(login: string): Promise<boolean> {
    if (loginsEqual(login, this.pr.user?.login)) return false;
    const cached = this.permissionCache.get(key(login));
    if (cached !== undefined) return cached;
    let allowed: boolean;
    try {
      allowed = WRITE_ROLES.has(await this.gh.getPermission(login));
    } catch (error) {
      log.warning(`Could not read ${login}'s permission (${(error as Error).message}); falling back to author association.`);
      allowed = this.reviews.some(
        (r) => r.user && loginsEqual(r.user.login, login) && TRUSTED_ASSOCIATIONS.has(r.author_association ?? ''),
      );
    }
    this.permissionCache.set(key(login), allowed);
    return allowed;
  }

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
      if (this.validPass(login) || this.openQuiz(login)) {
        if (isCommander) await this.react(this.trigger.commandCommentId, '+1');
        continue;
      }
      if (!(await this.canTakeQuiz(login))) {
        this.record('quiz-skipped', `${who} cannot take the quiz (pull request author or no write access).`);
        if (isCommander) await this.react(this.trigger.commandCommentId, 'confused');
        continue;
      }
      if (this.config.maxAttempts > 0 && this.failedCount(login) >= this.config.maxAttempts) {
        await this.lockOut(login);
        if (isCommander) await this.react(this.trigger.commandCommentId, 'confused');
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
    }
    this.record('attempts-exhausted', note);
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

    const generated = await generateQuiz(this.deps.llm, {
      context: context.text,
      reviewer: login,
      questionCount: this.config.questionCount,
      optionCount: this.config.optionCount,
      previousQuestions: this.quizzesOf(login).flatMap((q) => q.state.questions.map((x) => x.text)),
      incremental,
      extraInstructions: this.config.extraInstructions,
      verify: this.config.verifyQuestions,
    });

    const fileCount = Object.keys(this.changes.fileFingerprints).length;
    const state: QuizState = {
      v: 1,
      id: randomBytes(8).toString('hex'),
      reviewer: login,
      attempt: this.failedCount(login) + 1,
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
    if (!this.changes.hasReadableChanges) {
      return { state: 'success', context, description: 'No reviewable changes (only ignored or binary files).' };
    }
    const passers = this.passes();
    const pendingApprovers = this.activeApprovers().filter((login) => !this.validPass(login));
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
      return { state: 'error', context, description: `Quiz error: ${this.errors[0]}`, target_url: this.pr.html_url };
    }
    if (open.length) {
      return {
        state: 'pending',
        context,
        description: `Waiting for ${listLogins(open.map((q) => q.state.reviewer))} to answer the quiz`,
        target_url: open[0]!.url,
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
    const current = await this.gh.getStatus(this.pr.head.sha, status.context).catch(() => null);
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
      // Green without a quiz (nothing reviewable): just make sure the bot is not blocking.
      if (latest?.state === 'CHANGES_REQUESTED') await this.dismissBotReview(latest, 'PR Quiz: no reviewable changes.');
      return;
    }
    if (satisfied) {
      if (latest?.state === 'APPROVED') return;
      const body = `${REVIEW_MARKER}\n✅ **PR Quiz passed** by ${listLogins(passers)}: every question about this change was answered correctly, so the approval is backed by understanding.`;
      try {
        await this.gh.createReview(this.prNumber, 'APPROVE', body, sha);
        this.record('bot-approved', `Approved on behalf of ${listLogins(passers)}.`);
      } catch (error) {
        log.warning(
          `The bot could not approve (${(error as Error).message}). For GITHUB_TOKEN, enable "Allow GitHub Actions to create and approve pull requests" in the repository (and organization) settings. The commit status still reports the result.`,
        );
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
        log.warning(`The bot could not submit its pending review: ${(error as Error).message}`);
      }
      return;
    }

    if (!open.length && latest?.state === 'APPROVED') {
      await this.dismissBotReview(latest, 'PR Quiz: the code changed since the quiz was passed.');
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
