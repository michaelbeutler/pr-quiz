import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import { parseEvent } from '../src/event.ts';
import { LlmError } from '../src/llm/backend.ts';
import { StateCodec } from '../src/quiz/crypto.ts';
import { readCheckboxes } from '../src/quiz/parse.ts';
import { AI_NOTE_CHALLENGE, ATTESTATION, extractChallengeState, extractSealedState, formatDuration } from '../src/quiz/render.ts';
import { reconcile, type Trigger } from '../src/reconcile.ts';
import { log } from '../src/util/action.ts';
import { FakeGitHub, FakeLlm, pickRight, pickWrongFirst, sampleFiles, testConfig } from './fakes.ts';

function setup(config: Partial<Config> = {}) {
  const gh = new FakeGitHub();
  const llm = new FakeLlm();
  const cfg = testConfig(config);
  const codec = new StateCodec(cfg.stateSecret, 4242);
  const run = (trigger: Trigger = { kind: 'manual' }) => reconcile({ gh, codec, config: cfg, llm }, 7, trigger);
  return { gh, llm, codec, run };
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

describe('the review flow', () => {
  it('follows the 9 steps: approve → quiz → wrong → dismissed + new quiz → right → bot approves', async () => {
    const { gh, run } = setup();

    // 1. The pull request is opened: the gate waits for an approval.
    expect((await run({ kind: 'push' })).gate).toBe('pending');
    expect(gh.latestStatus()).toMatchObject({ state: 'pending', description: expect.stringContaining('Waiting for an approving review') });

    // 2 + 3. alice reviews and approves.
    gh.approve('alice');
    await run({ kind: 'approval', actor: 'alice' });

    // 4. The bot posts a quiz for alice and blocks with a pending (changes requested) review.
    const quiz1 = gh.latestQuizFor('alice')!;
    expect(quiz1.body).toContain('## 🧠 PR Quiz for @alice');
    expect(readCheckboxes(quiz1.body)).toHaveLength(3 * 4 + 1);
    expect(gh.botReviewState()).toBe('CHANGES_REQUESTED');
    expect(gh.latestStatus()).toMatchObject({ state: 'pending', target_url: quiz1.html_url });

    // 5. alice answers the first question wrong.
    gh.answerQuiz('alice', quiz1.id, pickWrongFirst);
    const failed = await run({ kind: 'comment-edit', actor: 'alice' });

    // 6. Her approval is dismissed and her review re-requested.
    expect(gh.reviewStateOf('alice')).toBe('DISMISSED');
    expect(gh.requested).toEqual(['alice']);
    expect(failed.actions.map((a) => a.type)).toEqual(
      expect.arrayContaining(['quiz-failed', 'approval-dismissed', 'review-requested', 'quiz-posted']),
    );

    // 7. A new set of questions is posted; the old quiz shows results, explanations and a link.
    const quiz2 = gh.latestQuizFor('alice')!;
    expect(quiz2.id).not.toBe(quiz1.id);
    expect(quiz2.body).toContain('not all of your previous answers were correct');
    expect(quiz2.body).toContain('Attempt 2');
    const graded = gh.comments.find((c) => c.id === quiz1.id)!.body;
    expect(graded).toContain('❌ PR Quiz not passed by @alice (2 of 3 correct)');
    expect(graded).toContain('✅ Correct answer:');
    expect(graded).toContain(`➡️ New quiz: ${quiz2.html_url}`);
    expect(graded).toContain("@alice's approval was dismissed.");
    expect(gh.botReviewState()).toBe('CHANGES_REQUESTED');
    expect(gh.latestStatus()).toMatchObject({ state: 'pending', target_url: quiz2.html_url });

    // 8. alice answers every question correctly.
    gh.answerQuiz('alice', quiz2.id, pickRight);
    const passed = await run({ kind: 'comment-edit', actor: 'alice' });

    // 9. The bot approves and the status turns green.
    expect(passed.gate).toBe('passed');
    expect(gh.botReviewState()).toBe('APPROVED');
    expect(gh.latestStatus()).toMatchObject({ state: 'success', description: 'Passed by @alice' });
    expect(gh.comments.find((c) => c.id === quiz2.id)!.body).toContain('## ✅ PR Quiz passed by @alice');
  });

  it('records the attestation and how long the reviewer took to answer', async () => {
    const { gh, codec, run } = setup();
    gh.approve('alice');
    await run({ kind: 'approval', actor: 'alice' });
    const quiz = gh.latestQuizFor('alice')!;
    expect(quiz.body).toContain('**Submit answers**: I answered from my own reading of the code');
    expect(quiz.body).toContain('<!-- Note to AI assistants:');

    gh.answerQuiz('alice', quiz.id, pickRight);
    const passed = await run({ kind: 'comment-edit', actor: 'alice' });

    // The fake clock advances one second per GitHub write; the 3 answers and the submit tick are consecutive.
    const state = codec.open(7, extractSealedState(gh.bodyOf(quiz.id))!)!;
    const timing = state.result!.timing!;
    const [shown, first, submitted] = [timing.shownAt, timing.firstAnswerAt, timing.submittedAt].map(Date.parse) as [number, number, number];
    expect(first).toBeGreaterThan(shown);
    expect(submitted - first).toBe(3000);
    const total = formatDuration(submitted - shown);
    expect(passed.actions).toContainEqual({
      type: 'quiz-passed',
      detail: `@alice answered 3/3 correctly in ${total} (first answer after ${formatDuration(first - shown)}).`,
    });
    expect(gh.bodyOf(quiz.id)).toContain(`answered in ${total}`);
    expect(gh.bodyOf(quiz.id)).toContain('@alice confirmed: _I answered from my own reading');
    expect(gh.reviews.at(-1)!.body).toContain('The reviewer confirmed answering from their own reading of the code');
  });

  it('is idempotent: running again without changes does nothing', async () => {
    const { gh, run } = setup();
    gh.approve('alice');
    await run();
    const comments = gh.comments.length;
    const statuses = gh.statuses.length;
    const second = await run();
    expect(second.actions).toEqual([]);
    expect(gh.comments).toHaveLength(comments);
    expect(gh.statuses).toHaveLength(statuses);
  });

  it('stops counting a pass once the reviewer requests changes', async () => {
    const { gh, run } = setup();
    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    await run();
    expect(gh.botReviewState()).toBe('APPROVED');

    gh.requestChanges('alice');
    expect((await run({ kind: 'review', actor: 'alice' })).gate).toBe('pending');
    expect(gh.latestStatus()?.state).toBe('pending');
    expect(gh.botReviewState()).toBe('DISMISSED'); // the bot no longer approves on her behalf

    gh.approve('alice'); // she changes her mind again; her pass for this code still stands
    expect((await run({ kind: 'approval', actor: 'alice' })).gate).toBe('passed');
    expect(gh.botReviewState()).toBe('APPROVED');
  });

  it('passes on the first attempt without dismissing anything', async () => {
    const { gh, run } = setup();
    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    expect((await run()).gate).toBe('passed');
    expect(gh.reviewStateOf('alice')).toBe('APPROVED');
    expect(gh.requested).toEqual([]);
  });
});

describe('answer integrity', () => {
  it('voids the quiz when someone other than the reviewer ticks boxes, and reposts it', async () => {
    const { gh, run, llm } = setup();
    gh.approve('alice');
    await run();
    const quiz = gh.latestQuizFor('alice')!;
    gh.toggleCheckbox('author', quiz.id, 0); // the PR author "helps"
    gh.answerQuiz('alice', quiz.id, pickRight);
    const generations = llm.generation;

    const result = await run();
    expect(result.gate).toBe('pending');
    const replacement = gh.latestQuizFor('alice')!;
    expect(replacement.id).not.toBe(quiz.id);
    expect(llm.generation).toBe(generations); // same questions, no new generation
    expect(replacement.body).toContain('edited by `author`');
    expect(readCheckboxes(replacement.body).every((c) => !c)).toBe(true);
    expect(gh.comments.find((c) => c.id === quiz.id)!.body).toContain('invalidated');
    expect(gh.reviewStateOf('alice')).toBe('APPROVED'); // not counted as a failed attempt

    gh.answerQuiz('alice', replacement.id, pickRight);
    expect((await run()).gate).toBe('passed');
  });

  it('asks for exactly one answer per question before grading', async () => {
    const { gh, run } = setup();
    gh.approve('alice');
    await run();
    const quiz = gh.latestQuizFor('alice')!;
    gh.toggleCheckbox('alice', quiz.id, 1); // Q1 only
    gh.toggleCheckbox('alice', quiz.id, 12); // submit
    await run();
    const body = gh.comments.find((c) => c.id === quiz.id)!.body;
    expect(body).toContain('Q2 has no answer selected. Q3 has no answer selected.');
    const boxes = readCheckboxes(body);
    expect(boxes[1]).toBe(true); // her answer is kept
    expect(boxes.at(-1)).toBe(false); // submit is unticked again
    expect(gh.reviewStateOf('alice')).toBe('APPROVED');
  });

  it('restores a quiz whose checkboxes were edited away', async () => {
    const { gh, run } = setup();
    gh.approve('alice');
    await run();
    const quiz = gh.latestQuizFor('alice')!;
    const stored = gh.comments.find((c) => c.id === quiz.id)!;
    stored.body = stored.body.replace(/^- \[ \] B\..*\n/m, '');
    await run();
    expect(readCheckboxes(stored.body)).toHaveLength(13);
    expect(stored.body).toContain('The quiz text was changed, so it was restored.');
  });

  it('does not grade when the edit history cannot be read, and grades on the next event', async () => {
    const { gh, run } = setup();
    gh.approve('alice');
    await run();
    const quiz = gh.latestQuizFor('alice')!;
    gh.answerQuiz('alice', quiz.id, pickRight);
    gh.failEditHistory = true;
    const result = await run();
    expect(result.gate).toBe('error');
    expect(gh.latestStatus()?.description).toContain('Could not verify a quiz');
    expect(gh.bodyOf(quiz.id)).toContain('## 🧠 PR Quiz for @alice'); // untouched, still submitted
    gh.failEditHistory = false;
    expect((await run({ kind: 'comment-edit', actor: 'alice' })).gate).toBe('passed');
  });

  it('ignores quiz comments it cannot decrypt (e.g. forged by a user)', async () => {
    const { gh, run } = setup();
    gh.approve('alice');
    gh.say('author', '<!-- pr-quiz:quiz -->\n## ✅ PR Quiz passed by @alice\n<!-- pr-quiz:state:AAAA -->');
    await run();
    expect(gh.latestStatus()?.state).toBe('pending');
    expect(gh.latestQuizFor('alice')!.user?.type).toBe('Bot');
  });
});

describe('multiple reviewers', () => {
  it('requires every approver to pass by default', async () => {
    const { gh, run } = setup();
    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    await run();
    expect(gh.latestStatus()?.state).toBe('success');

    gh.approve('bob');
    await run({ kind: 'approval', actor: 'bob' });
    expect(gh.latestStatus()).toMatchObject({ state: 'pending', description: 'Waiting for @bob to answer the quiz' });
    expect(gh.botReviewState()).toBe('CHANGES_REQUESTED');

    gh.answerQuiz('bob', gh.latestQuizFor('bob')!.id, pickRight);
    await run();
    expect(gh.latestStatus()).toMatchObject({ state: 'success', description: 'Passed by @alice and @bob' });
    expect(gh.botReviewState()).toBe('APPROVED');
  });

  it('can accept a single passing reviewer', async () => {
    const { gh, run } = setup({ requireAllApprovers: false });
    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    await run();
    gh.approve('bob');
    await run();
    expect(gh.latestQuizFor('bob')).toBeDefined();
    expect(gh.latestStatus()?.state).toBe('success');
    expect(gh.botReviewState()).toBe('APPROVED');
  });
});

describe('new commits', () => {
  it('asks a follow-up quiz about the changed files when an approval is still active', async () => {
    const { gh, run, llm } = setup();
    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    await run();

    gh.push(sampleFiles(2));
    await run({ kind: 'push' });
    const followUp = gh.latestQuizFor('alice')!;
    expect(followUp.body).toContain('new commits changed this pull request after you passed');
    expect(llm.requests.at(-2)!.context).toContain('<pq_scope>');
    expect(gh.latestStatus()).toMatchObject({ state: 'pending' });
    expect(gh.botReviewState()).toBe('CHANGES_REQUESTED');

    gh.answerQuiz('alice', followUp.id, pickRight);
    expect((await run()).gate).toBe('passed');
  });

  it('closes an unanswered quiz when the code changes', async () => {
    const { gh, run } = setup();
    gh.approve('alice');
    await run();
    const quiz = gh.latestQuizFor('alice')!;
    gh.reviews.find((r) => r.user?.login === 'alice')!.state = 'DISMISSED'; // stale approval dismissed by GitHub
    gh.push(sampleFiles(3));
    await run({ kind: 'push' });
    expect(gh.comments.find((c) => c.id === quiz.id)!.body).toContain('no longer active');
    expect(gh.latestQuizFor('alice')!.id).toBe(quiz.id);
    expect(gh.latestStatus()?.description).toContain('Waiting for an approving review');
  });

  it('keeps a pass when a rebase does not change the diff', async () => {
    const { gh, run } = setup();
    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    await run();
    const quizzes = gh.comments.length;
    gh.push(sampleFiles(1).map((f) => ({ ...f, patch: f.patch?.replace('@@ -10,6 +10,15 @@', '@@ -30,6 +30,15 @@') })));
    expect((await run({ kind: 'push' })).gate).toBe('passed');
    expect(gh.comments).toHaveLength(quizzes);
  });
});

describe('limits and permissions', () => {
  it('stops generating quizzes after max-attempts failures and rejects further approvals', async () => {
    const { gh, run } = setup({ maxAttempts: 2 });
    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickWrongFirst);
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickWrongFirst);
    const result = await run();
    expect(result.actions.map((a) => a.type)).toContain('attempts-exhausted');
    expect(gh.latestQuizFor('alice')!.body).toContain('has used all 2 attempts');
    expect(gh.comments.filter((c) => c.user?.type === 'Bot' && c.body.includes('pr-quiz:quiz'))).toHaveLength(2);

    gh.approve('alice');
    await run({ kind: 'approval', actor: 'alice' });
    expect(gh.reviewStateOf('alice')).toBe('DISMISSED');
    expect(gh.latestStatus()?.state).toBe('pending');
  });

  it('lets anyone with write access request a quiz with the command, but not read-only users', async () => {
    const { gh, run } = setup();
    gh.permissions.set('reader', 'read');
    const own = gh.say('author', '/pr-quiz');
    await run({ kind: 'command', actor: 'author', commandCommentId: own.id });
    expect(gh.reactions).toContainEqual({ commentId: own.id, content: 'rocket' });
    gh.answerQuiz('author', gh.latestQuizFor('author')!.id, pickRight);
    expect((await run()).gate).toBe('pending'); // the author's own pass is practice only

    const reader = gh.say('reader', '/pr-quiz');
    await run({ kind: 'command', actor: 'reader', commandCommentId: reader.id });
    expect(gh.reactions).toContainEqual({ commentId: reader.id, content: 'confused' });

    const bob = gh.say('bob', '/pr-quiz');
    await run({ kind: 'command', actor: 'bob', commandCommentId: bob.id });
    expect(gh.reactions).toContainEqual({ commentId: bob.id, content: 'rocket' });
    gh.answerQuiz('bob', gh.latestQuizFor('bob')!.id, pickRight);
    expect((await run()).gate).toBe('passed'); // a pass counts even without a formal approval
  });

  it('does not quiz approvals from users without write access, and they do not block the gate', async () => {
    const { gh, run, llm } = setup();
    gh.permissions.set('drive-by', 'read');
    gh.approve('drive-by', 'NONE');
    const result = await run();
    expect(gh.latestQuizFor('drive-by')).toBeUndefined();
    expect(result.actions.map((a) => a.type)).not.toContain('quiz-posted');
    expect(llm.requests).toHaveLength(0);

    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    expect((await run()).gate).toBe('passed'); // the drive-by approval can never pass, so it is ignored
  });

  it('accepts a custom role with write access', async () => {
    const { gh, run } = setup();
    gh.permissions.set('senior', 'senior-dev');
    gh.approve('senior');
    await run();
    expect(gh.latestQuizFor('senior')).toBeDefined();
  });

  it('needs a plain approval of the latest commit when only ignored files changed', async () => {
    const { gh, run, llm } = setup();
    gh.push([sampleFiles()[1]!]); // lockfile only
    expect((await run({ kind: 'push' })).gate).toBe('pending');
    expect(gh.latestStatus()?.description).toContain('No readable diff to quiz on');
    gh.approve('alice');
    expect((await run()).gate).toBe('passed');
    expect(gh.latestQuizFor('alice')).toBeUndefined();
    expect(llm.requests).toHaveLength(0);
    expect(gh.latestStatus()?.description).toBe('No readable diff to quiz on; approved by @alice');
  });
});

describe('degraded permissions and failures', () => {
  it('falls back to the commit status when the bot may not approve', async () => {
    const { gh, run } = setup();
    gh.botMayApprove = false;
    gh.approve('alice');
    await run();
    expect(gh.botReviewState()).toBe('CHANGES_REQUESTED');
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    expect((await run()).gate).toBe('passed');
    expect(gh.botReviewState()).toBe('DISMISSED'); // its blocking review no longer blocks
    expect(gh.latestStatus()?.state).toBe('success');
  });

  it('still posts new questions when the approval cannot be dismissed', async () => {
    const { gh, run } = setup();
    gh.botMayDismiss = false;
    gh.approve('alice');
    await run();
    const quiz1 = gh.latestQuizFor('alice')!;
    gh.answerQuiz('alice', quiz1.id, pickWrongFirst);
    await run();
    expect(gh.comments.find((c) => c.id === quiz1.id)!.body).toContain("⚠️ Could not dismiss @alice's approval");
    expect(gh.latestQuizFor('alice')!.id).not.toBe(quiz1.id);
    expect(gh.latestStatus()?.state).toBe('pending');
  });

  it('reports generation failures on the status and recovers on the next run', async () => {
    const { gh, run, llm } = setup();
    llm.failGeneration = new LlmError('Anthropic API rejected the credentials (401).', false);
    gh.approve('alice');
    const result = await run();
    expect(result.gate).toBe('error');
    expect(gh.latestStatus()).toMatchObject({ state: 'error', description: expect.stringContaining('401') });

    llm.failGeneration = null;
    await run();
    expect(gh.latestQuizFor('alice')).toBeDefined();
    expect(gh.latestStatus()?.state).toBe('pending');
  });

  it('retries a retake whose generation failed in an earlier run', async () => {
    const { gh, run, llm } = setup();
    gh.approve('alice');
    await run();
    const quiz1 = gh.latestQuizFor('alice')!;
    gh.answerQuiz('alice', quiz1.id, pickWrongFirst);
    llm.failGeneration = new LlmError('overloaded', true);
    await run();
    expect(gh.latestQuizFor('alice')!.id).toBe(quiz1.id);
    llm.failGeneration = null;
    await run(); // alice has no active approval any more, but the failed attempt still earns a retake
    const quiz2 = gh.latestQuizFor('alice')!;
    expect(quiz2.id).not.toBe(quiz1.id);
    expect(gh.comments.find((c) => c.id === quiz1.id)!.body).toContain(quiz2.html_url);
  });

  it('still gates a pull request the bot opened itself, and says why it cannot review it', async () => {
    // The live test setup: github-actions[bot] opened the PR, a human reviews.
    const gh = new FakeGitHub({ author: 'github-actions[bot]' });
    gh.committers = new Set(['pr-quiz-demo']);
    const llm = new FakeLlm();
    const config = testConfig();
    const warnings = vi.spyOn(log, 'warning');
    const run = () => reconcile({ gh, codec: new StateCodec(config.stateSecret, 4242), config, llm }, 7, { kind: 'manual' });
    gh.approve('michaelbeutler');
    await run();
    gh.answerQuiz('michaelbeutler', gh.latestQuizFor('michaelbeutler')!.id, pickRight);
    expect((await run()).gate).toBe('passed');
    expect(gh.botReviewState()).toBeUndefined();
    const messages = warnings.mock.calls.map(([m]) => m);
    expect(messages).toContainEqual(expect.stringContaining('does not let the bot review a pull request it opened itself'));
    expect(messages.join('\n')).not.toContain('Allow GitHub Actions');
  });

  it('works with a GitHub App bot identity', async () => {
    const gh = new FakeGitHub({ botLogin: 'pr-quiz[bot]' });
    const llm = new FakeLlm();
    const config = testConfig();
    const run = () => reconcile({ gh, codec: new StateCodec(config.stateSecret, 4242), config, llm }, 7, { kind: 'manual' });
    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    expect((await run()).gate).toBe('passed');
  });
});

describe('state integrity (replays and rollbacks)', () => {
  /** Fails alice's first quiz after she saved its raw, still-open markdown. */
  async function failFirstQuiz(ctx: ReturnType<typeof setup>) {
    const { gh, run } = ctx;
    gh.approve('alice');
    await run();
    const quiz1 = gh.latestQuizFor('alice')!;
    const openBody = gh.bodyOf(quiz1.id); // visible to her in the edit history anyway
    gh.answerQuiz('alice', quiz1.id, pickWrongFirst);
    await run();
    const graded = gh.bodyOf(quiz1.id);
    expect(graded).toContain('not passed');
    return { quiz1, openBody, quiz2: gh.latestQuizFor('alice')! };
  }

  /** Ticks the answers the graded quiz revealed, in a body that has Q1's open state. */
  function tickRevealed(gh: FakeGitHub, commentId: number) {
    gh.answerQuiz('alice', commentId, pickRight);
  }

  it('rejects pasting an earlier, answered quiz into the retake comment', async () => {
    const ctx = setup();
    const { gh, run } = ctx;
    const { openBody, quiz2 } = await failFirstQuiz(ctx);

    gh.editBody('alice', quiz2.id, openBody);
    tickRevealed(gh, quiz2.id);
    const result = await run({ kind: 'comment-edit', actor: 'alice' });

    expect(result.gate).toBe('pending');
    expect(result.actions.map((a) => a.type)).toContain('quiz-restored');
    expect(result.actions.map((a) => a.type)).not.toContain('quiz-posted'); // her retake is back, no new generation
    expect(gh.bodyOf(quiz2.id)).toContain('was modified by `alice`, so it was restored');
    expect(gh.bodyOf(quiz2.id)).toContain('Set 2'); // the retake's own questions are back
    expect(gh.botReviewState()).toBe('CHANGES_REQUESTED');
  });

  it('rejects rolling a graded quiz back to its open version', async () => {
    const ctx = setup();
    const { gh, run } = ctx;
    const { quiz1, openBody } = await failFirstQuiz(ctx);

    gh.editBody('alice', quiz1.id, openBody);
    tickRevealed(gh, quiz1.id);
    const result = await run({ kind: 'comment-edit', actor: 'alice' });

    expect(result.gate).toBe('pending');
    expect(gh.bodyOf(quiz1.id)).toContain('❌ PR Quiz not passed by @alice');
  });

  it('closes a quiz without reusing its questions when the bot revision was pruned from the history', async () => {
    const ctx = setup();
    const { gh, run, llm } = ctx;
    const { quiz1, openBody } = await failFirstQuiz(ctx);

    gh.editBody('alice', quiz1.id, openBody);
    gh.pruneRevision(quiz1.id, (edit, index) => edit.isBot && index <= 2); // hide the graded revision
    tickRevealed(gh, quiz1.id);
    const generations = llm.generation;
    const result = await run({ kind: 'comment-edit', actor: 'alice' });

    expect(result.gate).toBe('pending');
    expect(gh.bodyOf(quiz1.id)).toContain('edit history of this quiz was altered');
    expect(llm.generation).toBe(generations); // her open retake stays; nothing regenerated from Q1
  });

  it('ignores quiz state copied into a comment posted by another workflow', async () => {
    const { gh, run } = setup();
    gh.approve('alice');
    await run();
    const quiz = gh.latestQuizFor('alice')!;
    // Same github-actions identity, pre-ticked copy of alice's quiz (answers guessed).
    const copy = gh.postAsBot(gh.bodyOf(quiz.id).replace(/- \[ \]/g, '- [x]'));
    const result = await run();
    expect(result.actions.map((a) => a.type)).not.toContain('quiz-failed');
    expect(gh.bodyOf(copy.id)).toContain('- [x]'); // untouched and never graded
    expect(gh.reviewStateOf('alice')).toBe('APPROVED');
  });

  it('with a GitHub App identity, edits made as github-actions count as someone else', async () => {
    const gh = new FakeGitHub({ botLogin: 'pr-quiz[bot]' });
    const llm = new FakeLlm();
    const config = testConfig();
    const run = () => reconcile({ gh, codec: new StateCodec(config.stateSecret, 4242), config, llm }, 7, { kind: 'manual' });
    gh.approve('alice');
    await run();
    const quiz = gh.latestQuizFor('alice')!;
    gh.toggleCheckbox('github-actions', quiz.id, 0);
    gh.answerQuiz('alice', quiz.id, pickRight);
    const result = await run();
    expect(result.actions.map((a) => a.type)).toContain('quiz-voided');
    expect(gh.bodyOf(quiz.id)).toContain('edited by `github-actions`');
  });
});

describe('changes a quiz cannot cover', () => {
  const binary = { filename: 'public/logo.png', status: 'added', additions: 0, deletions: 0, changes: 0, sha: 'img1' };

  async function passedAlice(ctx: ReturnType<typeof setup>) {
    ctx.gh.approve('alice');
    await ctx.run();
    ctx.gh.answerQuiz('alice', ctx.gh.latestQuizFor('alice')!.id, pickRight);
    expect((await ctx.run()).gate).toBe('passed');
  }

  it('asks for a fresh approval, not a quiz, when only ignored files change after a pass', async () => {
    const ctx = setup();
    const { gh, run, llm } = ctx;
    await passedAlice(ctx);
    const generations = llm.generation;

    const [code, lock] = sampleFiles();
    gh.push([code!, { ...lock!, patch: '@@ -1 +1 @@\n-"lockfileVersion": 3\n+"evil": "https://attacker.example"\n' }]);
    expect((await run({ kind: 'push' })).gate).toBe('pending');
    expect(gh.latestStatus()?.description).toContain('approve the latest commit to confirm');
    expect(llm.generation).toBe(generations);

    gh.approve('alice');
    expect((await run({ kind: 'approval', actor: 'alice' })).gate).toBe('passed');
  });

  it('does not generate a junk quiz when only a binary file is added after a pass', async () => {
    const ctx = setup();
    const { gh, run, llm } = ctx;
    await passedAlice(ctx);
    const generations = llm.generation;
    gh.push([...sampleFiles(), binary]);
    expect((await run({ kind: 'push' })).gate).toBe('pending');
    expect(llm.generation).toBe(generations);
  });

  it('never turns green for a binary-only PR without an approval of the latest commit', async () => {
    const { gh, run } = setup();
    gh.push([binary]);
    expect((await run({ kind: 'push' })).gate).toBe('pending');
    gh.approve('alice');
    expect((await run()).gate).toBe('passed');
  });

  it('re-evaluates when the base branch changes what the PR contains', async () => {
    const ctx = setup();
    const { gh, run } = ctx;
    await passedAlice(ctx);
    gh.retarget(sampleFiles(5), 'release');
    const result = await run({ kind: 'push' });
    expect(result.gate).toBe('pending');
    expect(gh.latestStatus()?.state).toBe('pending');
  });
});

describe('who may take the quiz', () => {
  it('gives people who committed to the pull request only a practice quiz, and ignores their approvals', async () => {
    const { gh, run, llm } = setup();
    gh.push(sampleFiles(2), 'bob'); // bob pushed a fix-up commit
    gh.approve('bob');
    await run();
    expect(gh.latestQuizFor('bob')).toBeUndefined(); // his approval alone doesn't start a quiz
    expect(llm.requests).toHaveLength(0);

    const own = gh.say('bob', '/pr-quiz');
    await run({ kind: 'command', actor: 'bob', commandCommentId: own.id });
    expect(gh.reactions).toContainEqual({ commentId: own.id, content: 'rocket' });
    expect(gh.latestQuizFor('bob')!.body).toContain('practice quiz');
    expect(gh.latestStatus()?.description).not.toContain('@bob'); // the gate doesn't wait for practice
    expect(gh.botReviewState()).toBeUndefined();

    gh.answerQuiz('bob', gh.latestQuizFor('bob')!.id, pickRight);
    expect((await run()).gate).toBe('pending');
    expect(gh.latestQuizFor('bob')!.body).toContain('does not count toward the gate');

    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    expect((await run()).gate).toBe('passed');
  });

  it('does not dismiss or re-request anything when a practice quiz fails, and retakes only on request', async () => {
    const { gh, run } = setup();
    gh.push(sampleFiles(2), 'bob');
    gh.approve('bob');
    const own = gh.say('bob', '/pr-quiz');
    await run({ kind: 'command', actor: 'bob', commandCommentId: own.id });
    const first = gh.latestQuizFor('bob')!;
    gh.answerQuiz('bob', first.id, pickWrongFirst);
    const result = await run();
    expect(result.actions.map((a) => a.type)).not.toContain('approval-dismissed');
    expect(gh.requested).toEqual([]);
    expect(gh.reviewStateOf('bob')).toBe('APPROVED');
    expect(gh.latestQuizFor('bob')!.id).toBe(first.id); // no automatic retake
    expect(gh.bodyOf(first.id)).toContain('`/pr-quiz` for new questions');

    const again = gh.say('bob', '/pr-quiz');
    await run({ kind: 'command', actor: 'bob', commandCommentId: again.id });
    expect(gh.latestQuizFor('bob')!.id).not.toBe(first.id);
  });

  it('stops counting a pass when the reviewer later pushes to the pull request', async () => {
    const { gh, run } = setup({ requireAllApprovers: false });
    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    await run();
    gh.committers.add('alice'); // e.g. she pushed a commit without changing the diff we quiz on
    expect((await run()).gate).toBe('pending');
  });
});

describe('attempt history', () => {
  it('survives deleting old quiz comments', async () => {
    const { gh, run, llm } = setup({ maxAttempts: 3 });
    gh.approve('alice');
    await run();
    for (let attempt = 1; attempt <= 2; attempt++) {
      gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickWrongFirst);
      await run();
    }
    const third = gh.latestQuizFor('alice')!;
    expect(third.body).toContain('Attempt 3');
    // Delete the failed quizzes to "reset" the history.
    gh.comments = gh.comments.filter((c) => c.id === third.id || !c.body.includes('not passed'));
    gh.answerQuiz('alice', third.id, pickWrongFirst);
    const result = await run();
    expect(result.actions.map((a) => a.type)).toContain('attempts-exhausted');
    const lastTask = llm.requests.findLast((r) => r.task.includes('Write '))!.task;
    expect(lastTask).toContain('Set 1, question 1'); // earlier questions still reach the generator
  });
});

describe('retrying after errors', () => {
  it('does not call Claude again on every checkbox tick after a failure', async () => {
    const { gh, run, llm } = setup();
    llm.failGeneration = new LlmError('Claude declined to write questions for this change.', false);
    gh.approve('alice');
    await run({ kind: 'approval', actor: 'alice' });
    const calls = llm.requests.length;
    expect(gh.latestStatus()?.state).toBe('error');

    await run({ kind: 'comment-edit', actor: 'bob' });
    await run({ kind: 'review', actor: 'bob' });
    expect(llm.requests.length).toBe(calls);
    expect(gh.latestStatus()?.state).toBe('error');

    llm.failGeneration = null;
    const retry = gh.say('alice', '/pr-quiz');
    await run({ kind: 'command', actor: 'alice', commandCommentId: retry.id });
    expect(gh.latestQuizFor('alice')).toBeDefined();
  });
});

/** The trigger GitHub sends for a new comment. */
function triggerFor(id: number, login: string, body: string): Trigger {
  const { trigger } = parseEvent(
    'issue_comment',
    { action: 'created', issue: { number: 7, pull_request: {} }, sender: { login, type: 'User' }, comment: { id, body, user: { login } } },
    '/pr-quiz',
  );
  return trigger!;
}

/** Posts `body` as `login` and runs the trigger GitHub would send for it. */
async function comment(ctx: ReturnType<typeof setup>, login: string, body: string) {
  const c = ctx.gh.say(login, body);
  const trigger = triggerFor(c.id, login, body);
  return { id: c.id, trigger, result: await ctx.run(trigger) };
}

async function passReviewer(ctx: ReturnType<typeof setup>, login = 'alice') {
  ctx.gh.approve(login);
  await ctx.run();
  ctx.gh.answerQuiz(login, ctx.gh.latestQuizFor(login)!.id, pickRight);
  await ctx.run();
}

const types = (result: { actions: Array<{ type: string }> }) => result.actions.map((a) => a.type);
const quizCommentsFor = (gh: FakeGitHub, login: string) =>
  gh.comments.filter((c) => c.user?.type === 'Bot' && new RegExp(`^## .*@${login}\\b`, 'm').test(c.body));

describe('challenging the author', () => {
  it('blocks the gate until the challenged author passes, even after a reviewer passed', async () => {
    const ctx = setup();
    const { gh } = ctx;
    await passReviewer(ctx);
    expect(gh.latestStatus()?.state).toBe('success');
    const alicePass = gh.latestQuizFor('alice')!;

    const { id } = await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(gh.reactionsOn(id)).toContain('rocket');
    expect(gh.challengeReviews()).toHaveLength(1);
    expect(gh.challengeReviews()[0]!.body).toContain('@alice challenged @author');
    const quiz = gh.latestQuizFor('author')!;
    expect(quiz.body).toContain('## 🎯 PR Quiz challenge for @author');
    expect(quiz.body).toContain(AI_NOTE_CHALLENGE);
    expect(quiz.body).toContain(`**Submit answers**: ${ATTESTATION}`);
    expect(gh.latestQuizFor('alice')!.id).toBe(alicePass.id);
    expect(gh.bodyOf(alicePass.id)).toContain('## ✅ PR Quiz passed by @alice');
    expect(gh.latestStatus()).toMatchObject({ state: 'pending', description: 'Waiting for @author (challenged) to answer the quiz' });
    expect(gh.botReviewState()).toBe('CHANGES_REQUESTED');

    gh.answerQuiz('author', quiz.id, pickRight);
    const passed = await ctx.run({ kind: 'comment-edit', actor: 'author' });
    expect(passed.gate).toBe('passed');
    expect(gh.latestStatus()?.description).toBe('Passed by @alice; challenge passed by @author');
    expect(gh.botReviewState()).toBe('APPROVED');
    expect(gh.reviews.at(-1)!.body).toContain('@author also passed the challenge by @alice');
    expect(gh.bodyOf(quiz.id)).toContain('This meets the challenge by @alice');
    expect(gh.bodyOf(quiz.id)).toContain('answered in');
  });

  it('never lets a challenge pass stand in for a reviewer', async () => {
    const ctx = setup();
    const { gh } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    gh.answerQuiz('author', gh.latestQuizFor('author')!.id, pickRight);
    expect((await ctx.run()).gate).toBe('pending');
    expect(gh.latestStatus()?.description).toContain('Waiting for an approving review');

    await passReviewer(ctx, 'bob');
    expect(gh.latestStatus()).toMatchObject({ state: 'success', description: 'Passed by @bob; challenge passed by @author' });
  });

  it('never counts a challenge pass for a reviewer, even once the author could review', async () => {
    const ctx = setup();
    const { gh } = ctx;
    gh.push(sampleFiles(2), 'bob');
    await comment(ctx, 'alice', '/pr-quiz challenge @bob');
    gh.answerQuiz('bob', gh.latestQuizFor('bob')!.id, pickRight);
    await ctx.run();
    gh.committers.delete('bob'); // e.g. his commits were squashed into the author's
    expect((await ctx.run()).gate).toBe('pending');
    expect(gh.latestStatus()?.description).toContain('Waiting for an approving review');
  });

  it('quizzes a challenged author who can review again on their approval, apart from the challenge', async () => {
    const ctx = setup();
    const { gh } = ctx;
    gh.push(sampleFiles(2), 'bob');
    await comment(ctx, 'alice', '/pr-quiz challenge @bob');
    const challengeQuiz = gh.latestQuizFor('bob')!;
    gh.committers.delete('bob'); // e.g. a force-push dropped his commits
    gh.approve('bob');
    await ctx.run({ kind: 'approval', actor: 'bob' });
    const reviewerQuiz = gh.latestQuizFor('bob')!;
    expect(reviewerQuiz.id).not.toBe(challengeQuiz.id);
    expect(reviewerQuiz.body).toContain('## 🧠 PR Quiz for @bob');
    expect(gh.bodyOf(challengeQuiz.id)).toContain('## 🎯 PR Quiz challenge for @bob'); // both stay open
    expect((await ctx.run()).actions).toEqual([]);

    gh.answerQuiz('bob', challengeQuiz.id, pickRight);
    gh.answerQuiz('bob', reviewerQuiz.id, pickRight);
    await ctx.run();
    await passReviewer(ctx);
    expect(gh.latestStatus()).toMatchObject({ state: 'success', description: expect.stringContaining('challenge passed by @bob') });
    expect(gh.botReviewState()).toBe('APPROVED');
  });

  it('posts new questions after a wrong answer and dismisses nothing', async () => {
    const ctx = setup();
    const { gh } = ctx;
    gh.push(sampleFiles(2), 'bob');
    gh.approve('bob');
    await comment(ctx, 'alice', '/pr-quiz challenge @bob');
    const first = gh.latestQuizFor('bob')!;
    gh.answerQuiz('bob', first.id, pickWrongFirst);
    const failed = await ctx.run({ kind: 'comment-edit', actor: 'bob' });

    expect(types(failed)).toEqual(expect.arrayContaining(['quiz-failed', 'quiz-posted']));
    expect(types(failed)).not.toContain('approval-dismissed');
    expect(types(failed)).not.toContain('review-requested');
    expect(gh.requested).toEqual([]);
    expect(gh.reviewStateOf('bob')).toBe('APPROVED');
    const retake = gh.latestQuizFor('bob')!;
    expect(retake.id).not.toBe(first.id);
    expect(retake.body).toContain('Attempt 2');
    expect(retake.body).toContain('not all of your previous answers');
    const graded = gh.bodyOf(first.id);
    expect(graded).toContain('❌ PR Quiz challenge not passed by @bob');
    expect(graded).toContain('Nothing on the pull request was dismissed');
    expect(graded).toContain(`➡️ New quiz: ${retake.html_url}`);
  });

  it('stops at max-attempts until a reviewer challenges again', async () => {
    const ctx = setup({ maxAttempts: 2 });
    const { gh, llm } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    gh.answerQuiz('author', gh.latestQuizFor('author')!.id, pickWrongFirst);
    await ctx.run();
    gh.answerQuiz('author', gh.latestQuizFor('author')!.id, pickWrongFirst);
    const exhausted = await ctx.run();
    expect(types(exhausted)).toContain('attempts-exhausted');
    expect(gh.latestQuizFor('author')!.body).toContain('has used all 2 attempts on this challenge');
    const generations = llm.generation;
    await ctx.run();
    expect(llm.generation).toBe(generations);
    expect(gh.latestStatus()?.description).toContain('used all 2 challenge attempts');
    expect(gh.botReviewState()).toBe('CHANGES_REQUESTED');

    const { id } = await comment(ctx, 'bob', '/pr-quiz challenge @author');
    expect(gh.reactionsOn(id)).toContain('rocket');
    expect(gh.challengeReviews()).toHaveLength(2);
    expect(gh.challengeReviews()[1]!.body).toContain('gives them 2 new ones');
    expect(gh.latestQuizFor('author')!.body).toContain('Attempt 1');
  });

  it('answers a repeated challenge with 👍 while attempts are left and renews them after a lockout', async () => {
    const ctx = setup({ maxAttempts: 1 });
    const { gh } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const first = gh.latestQuizFor('author')!;
    const repeat = await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(gh.reactionsOn(repeat.id)).toContain('+1');
    expect(gh.challengeReviews()).toHaveLength(1);
    gh.answerQuiz('author', first.id, pickWrongFirst);
    await ctx.run();
    expect(gh.latestStatus()?.description).toContain('used all 1 challenge attempts');

    const renewed = await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(gh.reactionsOn(renewed.id)).toContain('rocket');
    expect(gh.challengeReviews()).toHaveLength(2);
    expect(gh.challengeReviews()[1]!.body).toContain('this challenge gives them');
    expect(gh.latestQuizFor('author')!.body).toContain('Attempt 1');
  });

  it('lets only the challenger withdraw', async () => {
    const ctx = setup();
    const { gh } = ctx;
    await passReviewer(ctx);
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const quiz = gh.latestQuizFor('author')!;

    const rejected = async (login: string, body: string) => {
      const { id, result } = await comment(ctx, login, body);
      expect(gh.reactionsOn(id)).toContain('confused');
      expect(types(result)).toContain('withdraw-rejected');
      expect(result.gate).toBe('pending');
    };
    await rejected('author', '/pr-quiz withdraw @author');
    await rejected('bob', '/pr-quiz withdraw @author');
    gh.permissions.set('alice', 'read');
    await rejected('alice', '/pr-quiz withdraw');

    gh.permissions.delete('alice');
    // Without its record a withdrawal doesn't count, not even in the run that tried it.
    gh.botMayComment = false;
    const failed = await comment(ctx, 'alice', '/pr-quiz withdraw');
    expect(gh.reactionsOn(failed.id)).toContain('confused');
    expect(types(failed.result)).toContain('withdraw-rejected');
    expect(failed.result.gate).toBe('pending');
    expect(gh.bodyOf(quiz.id)).toContain('## 🎯 PR Quiz challenge for @author');
    gh.botMayComment = true;

    const { id, result } = await comment(ctx, 'alice', '/pr-quiz withdraw');
    expect(gh.reactionsOn(id)).toContain('+1');
    expect(gh.challengeReviews().at(-1)!.body).toContain('↩️ **PR Quiz challenge withdrawn:** @alice withdrew their challenge for @author.');
    expect(gh.bodyOf(quiz.id)).toContain('The challenge was withdrawn');
    expect(result.gate).toBe('passed');
    expect(gh.botReviewState()).toBe('APPROVED');
  });

  it('withdraws only the named challenge', async () => {
    const ctx = setup();
    const { gh } = ctx;
    gh.push(sampleFiles(2), 'bob');
    await comment(ctx, 'alice', '/pr-quiz challenge @author @bob');
    const authorQuiz = gh.latestQuizFor('author')!;
    const bobQuiz = gh.latestQuizFor('bob')!;
    const { id } = await comment(ctx, 'alice', '/pr-quiz withdraw @bob');
    expect(gh.reactionsOn(id)).toContain('+1');
    expect(gh.challengeReviews().at(-1)!.body).toContain('@alice withdrew their challenge for @bob.');
    expect(gh.bodyOf(bobQuiz.id)).toContain('The challenge was withdrawn');
    expect(gh.bodyOf(authorQuiz.id)).toContain('## 🎯 PR Quiz challenge for @author');
    expect(gh.latestStatus()?.description).toBe('Waiting for @author (challenged) to answer the quiz');

    const none = await comment(ctx, 'alice', '/pr-quiz withdraw @carol');
    expect(gh.reactionsOn(none.id)).toContain('confused');
  });

  it("survives deleting the command and the quiz comments, and can't be dismissed", async () => {
    const ctx = setup();
    const { gh } = ctx;
    const { id: commandId } = await comment(ctx, 'alice', '/pr-quiz challenge');
    gh.answerQuiz('author', gh.latestQuizFor('author')!.id, pickWrongFirst);
    await ctx.run();
    gh.deleteComment(commandId);
    for (const c of quizCommentsFor(gh, 'author')) gh.deleteComment(c.id);
    expect(gh.latestQuizFor('author')).toBeUndefined();

    const result = await ctx.run();
    expect(gh.latestQuizFor('author')!.body).toContain('## 🎯 PR Quiz challenge for @author');
    expect(result.gate).toBe('pending');
    await expect(gh.dismissReview(7, gh.challengeReviews()[0]!.id, 'x')).rejects.toThrow();

    // Dismissing the bot's blocking review only makes the bot block again.
    const blocking = gh.reviews.filter((r) => r.user?.type === 'Bot' && r.state === 'CHANGES_REQUESTED').at(-1)!;
    await gh.dismissReview(7, blocking.id, 'Not needed.');
    expect((await ctx.run({ kind: 'review', actor: 'github-actions[bot]' })).gate).toBe('pending');
    expect(gh.botReviewState()).toBe('CHANGES_REQUESTED');
  });

  it('undoes edits to a challenge record', async () => {
    const ctx = setup();
    const { gh } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const record = gh.challengeReviews()[0]!;
    await comment(ctx, 'carol', '/pr-quiz challenge');
    await comment(ctx, 'carol', '/pr-quiz withdraw');
    const withdrawal = gh.challengeReviews().at(-1)!;
    expect(withdrawal.body).toContain('The challenge by @alice still applies.');

    gh.editReview('author', record.id, withdrawal.body!);
    const restored = await ctx.run();
    expect(types(restored)).toContain('challenge-restored');
    expect(gh.reviews.find((r) => r.id === record.id)!.body).toContain('@alice challenged @author');
    expect(restored.gate).toBe('pending');

    gh.editReview('author', record.id, 'Withdrawn.');
    const again = await ctx.run();
    expect(again.actions).toContainEqual({
      type: 'challenge-restored',
      detail: `Undid edits by \`author\` to the challenge record ${record.html_url}.`,
    });
    expect(gh.reviews.find((r) => r.id === record.id)!.body).toContain('@alice challenged @author');
    expect(gh.latestStatus()?.state).toBe('pending');
    expect((await ctx.run()).actions).toEqual([]);

    // When the bot can't put its text back, its verified revision still counts.
    gh.editReview('author', record.id, 'Withdrawn.');
    vi.spyOn(gh, 'updateReview').mockRejectedValueOnce(new Error('Resource not accessible by integration'));
    expect(types(await ctx.run())).not.toContain('challenge-restored');
    expect(gh.latestStatus()?.description).toBe('Waiting for @author (challenged) to answer the quiz');
  });

  it('keeps a challenge from the quiz copy when its record and history were destroyed', async () => {
    const ctx = setup();
    const { gh } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const record = gh.challengeReviews()[0]!;
    const quiz = gh.latestQuizFor('author')!;
    gh.editReview('author', record.id, 'Withdrawn.');
    gh.pruneReviewRevision(record.id, (e) => e.isBot);

    const result = await ctx.run();
    expect(types(result)).not.toContain('challenge-restored');
    expect(gh.latestStatus()?.description).toBe('Waiting for @author (challenged) to answer the quiz');

    const { id } = await comment(ctx, 'alice', '/pr-quiz withdraw');
    expect(gh.reactionsOn(id)).toContain('+1');
    expect(gh.bodyOf(quiz.id)).toContain('The challenge was withdrawn');
  });

  it('treats a record that is gone like a destroyed one', async () => {
    const ctx = setup();
    const { gh } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const record = gh.challengeReviews()[0]!;
    gh.reviews = gh.reviews.filter((r) => r !== record); // e.g. deleted through GraphQL
    await ctx.run();
    expect(gh.latestStatus()?.description).toBe('Waiting for @author (challenged) to answer the quiz');

    // The retake carries the copy forward, so the challenge outlives the quiz it was read from.
    gh.answerQuiz('author', gh.latestQuizFor('author')!.id, pickWrongFirst);
    await ctx.run();
    const retake = gh.latestQuizFor('author')!;
    expect(retake.body).toContain('Attempt 2');
    for (const c of quizCommentsFor(gh, 'author').filter((c) => c.id !== retake.id)) gh.deleteComment(c.id);
    await ctx.run();
    expect(gh.latestStatus()?.description).toBe('Waiting for @author (challenged) to answer the quiz');
  });

  it('ignores forged challenge records', async () => {
    const ctx = setup();
    const { gh, codec } = ctx;
    await passReviewer(ctx);
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const record = gh.challengeReviews()[0]!;
    const challenge = codec.openChallenge(7, extractChallengeState(record.body)!)!;
    expect(challenge.kind).toBe('challenge');
    const quiz = gh.latestQuizFor('author')!;

    // A leaked blob in a review by a person, quiz state in the record marker, garbage, and a copy as a comment.
    const leaked = codec.sealChallenge(7, { v: 1, kind: 'withdraw', ids: [(challenge as { id: string }).id], by: 'alice', at: challenge.at });
    gh.commentReview('author', `<!-- pr-quiz:challenge -->\nWithdrawn.\n<!-- pr-quiz:challenge-state:${leaked} -->`);
    gh.reviewAsBot(`<!-- pr-quiz:challenge -->\n<!-- pr-quiz:challenge-state:${extractSealedState(quiz.body)} -->`);
    gh.reviewAsBot('<!-- pr-quiz:challenge -->\n<!-- pr-quiz:challenge-state:garbage -->');
    gh.say('author', record.body!);

    const result = await ctx.run();
    expect(result.gate).toBe('pending');
    expect(gh.latestStatus()?.description).toBe('Waiting for @author (challenged) to answer the quiz');
    expect(gh.bodyOf(quiz.id)).toContain('## 🎯 PR Quiz challenge for @author');
    expect(types(result)).not.toContain('quiz-closed');
  });

  it('rejects challenges from authors, committers and read-only users', async () => {
    const ctx = setup();
    const { gh, llm } = ctx;
    gh.push(sampleFiles(2), 'bob');
    gh.permissions.set('reader', 'read');
    for (const [login, body] of [
      ['author', '/pr-quiz challenge @bob'],
      ['bob', '/pr-quiz challenge'],
      ['reader', '/pr-quiz challenge'],
    ] as const) {
      const { id, result } = await comment(ctx, login, body);
      expect(gh.reactionsOn(id)).toContain('confused');
      expect(types(result)).toContain('challenge-rejected');
    }
    expect(gh.challengeReviews()).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);

    gh.botMayComment = false;
    const { id, result } = await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(gh.reactionsOn(id)).toContain('confused');
    expect(result.actions).toContainEqual({ type: 'challenge-rejected', detail: expect.stringContaining('Could not post the challenge record') });
    expect(gh.latestQuizFor('author')).toBeUndefined();
  });

  it("doesn't challenge authors without write access", async () => {
    const ctx = setup();
    const { gh, llm } = ctx;
    gh.permissions.set('author', 'read');
    const { id, result } = await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(gh.reactionsOn(id)).toContain('confused');
    expect(result.actions).toContainEqual({
      type: 'challenge-rejected',
      detail: expect.stringContaining("`author` can't answer a quiz here (no write access)"),
    });
    expect(gh.challengeReviews()).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);

    gh.push(sampleFiles(2), 'bob');
    const named = await comment(ctx, 'alice', '/pr-quiz challenge @author @bob');
    expect(gh.reactionsOn(named.id)).toContain('rocket');
    const record = gh.challengeReviews()[0]!;
    expect(record.body).toContain('@alice challenged @bob');
    expect(record.body).toContain("`author` can't answer a quiz here (no write access), so they were not challenged.");
    expect(gh.latestQuizFor('bob')).toBeDefined();
    expect(gh.latestQuizFor('author')).toBeUndefined();
  });

  it('challenges named committers and skips mentions that are not human authors', async () => {
    const ctx = setup();
    const { gh } = ctx;
    gh.push(sampleFiles(2), 'bob');
    const { id } = await comment(ctx, 'alice', '/pr-quiz challenge @bob @carol @dependabot[bot]');
    expect(gh.reactionsOn(id)).toContain('rocket');
    expect(gh.latestQuizFor('bob')!.body).toContain('## 🎯 PR Quiz challenge for @bob');
    expect(gh.latestQuizFor('author')).toBeUndefined();
    const record = gh.challengeReviews()[0]!;
    expect(record.body).toContain('@alice challenged @bob');
    expect(record.body).toContain('`carol` is not a human author of this change, so they were not challenged.');
    expect(record.body).toContain('`dependabot[bot]` is not a human author of this change, so they were not challenged.');

    const alone = await comment(ctx, 'alice', '/pr-quiz challenge @carol');
    expect(gh.reactionsOn(alone.id)).toContain('confused');
    expect(gh.challengeReviews()).toHaveLength(1);
  });

  it('challenges the human committers of a pull request a bot opened', async () => {
    const gh = new FakeGitHub({ author: 'github-actions[bot]' });
    gh.committers = new Set(['pr-quiz-demo', 'web-flow']);
    const llm = new FakeLlm();
    const config = testConfig();
    const codec = new StateCodec(config.stateSecret, 4242);
    const ctx = { gh, llm, codec, run: (trigger: Trigger = { kind: 'manual' }) => reconcile({ gh, codec, config, llm }, 7, trigger) };

    const { id, result } = await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(gh.reactionsOn(id)).toContain('rocket');
    expect(gh.challengeReviews()).toHaveLength(1); // a comment review is fine on the bot's own pull request
    expect(gh.challengeReviews()[0]!.body).toContain('@alice challenged @pr-quiz-demo');
    expect(gh.latestQuizFor('pr-quiz-demo')!.body).toContain('## 🎯 PR Quiz challenge for @pr-quiz-demo');
    expect(gh.comments.filter((c) => c.body.includes('<!-- pr-quiz:quiz -->'))).toHaveLength(1);
    expect(result.gate).toBe('pending');
  });

  it('treats re-runs of the same command as no-ops', async () => {
    const ctx = setup();
    const { gh } = ctx;
    const challenge = await comment(ctx, 'alice', '/pr-quiz challenge');
    await ctx.run(challenge.trigger);
    expect(gh.challengeReviews()).toHaveLength(1);
    expect(quizCommentsFor(gh, 'author')).toHaveLength(1);
    expect(gh.reactionsOn(challenge.id)).toEqual(['eyes', 'rocket', 'eyes', '+1']);

    const withdrawal = await comment(ctx, 'alice', '/pr-quiz withdraw');
    await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(gh.challengeReviews()).toHaveLength(3);
    const rerun = await ctx.run(withdrawal.trigger);
    expect(types(rerun)).not.toContain('withdraw-rejected');
    expect(gh.reactionsOn(withdrawal.id).at(-1)).toBe('+1');
    expect(gh.challengeReviews()).toHaveLength(3);
    expect(rerun.gate).toBe('pending');
    expect(gh.latestStatus()?.description).toBe('Waiting for @author (challenged) to answer the quiz');
  });

  it('never lets an old challenge command undo a withdrawal made after it', async () => {
    const ctx = setup();
    const { gh } = ctx;
    await passReviewer(ctx);
    await comment(ctx, 'alice', '/pr-quiz challenge');
    // A repeated challenge only gets 👍, so no record carries its comment id.
    const repeated = await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(gh.reactionsOn(repeated.id)).toEqual(['eyes', '+1']);
    expect((await comment(ctx, 'alice', '/pr-quiz withdraw')).result.gate).toBe('passed');
    const reviews = gh.challengeReviews().length;
    const quizzes = quizCommentsFor(gh, 'author').length;

    const rerun = await ctx.run(repeated.trigger);
    expect(types(rerun)).not.toContain('challenge-recorded');
    expect(gh.reactionsOn(repeated.id).at(-1)).toBe('+1');
    expect(gh.challengeReviews()).toHaveLength(reviews);
    expect(quizCommentsFor(gh, 'author')).toHaveLength(quizzes);
    expect(rerun.gate).toBe('passed');
    expect(gh.latestStatus()?.description).toBe('Passed by @alice');
  });

  it('never lets a withdraw command end a challenge made after it', async () => {
    const ctx = setup();
    const { gh } = ctx;
    gh.push(sampleFiles(2), 'bob');
    await comment(ctx, 'alice', '/pr-quiz challenge @author');
    // The withdraw command's run is held up (a busy concurrency group) while alice challenges bob too.
    const late = gh.say('alice', '/pr-quiz withdraw');
    await comment(ctx, 'alice', '/pr-quiz challenge @bob');
    await ctx.run(triggerFor(late.id, 'alice', late.body));
    expect(gh.challengeReviews().at(-1)!.body).toContain('@alice withdrew their challenge for @author.');
    expect(gh.bodyOf(gh.latestQuizFor('author')!.id)).toContain('The challenge was withdrawn');
    expect(gh.bodyOf(gh.latestQuizFor('bob')!.id)).toContain('## 🎯 PR Quiz challenge for @bob');
    expect(gh.latestStatus()?.description).toBe('Waiting for @bob (challenged) to answer the quiz');
  });

  it('asks a follow-up challenge quiz after new commits, but not for ignored files', async () => {
    const ctx = setup();
    const { gh, llm } = ctx;
    await passReviewer(ctx);
    await comment(ctx, 'alice', '/pr-quiz challenge');
    gh.answerQuiz('author', gh.latestQuizFor('author')!.id, pickRight);
    expect((await ctx.run()).gate).toBe('passed');

    gh.push(sampleFiles(2));
    await ctx.run({ kind: 'push' });
    const followUp = gh.latestQuizFor('author')!;
    expect(followUp.body).toContain('after you passed the challenge quiz');
    expect(followUp.body).toContain('follow-up on new commits');
    expect(llm.requests.at(-2)!.context).toContain('<pq_scope>');
    expect(llm.requests.at(-2)!.task).toContain('an author of this pull request');
    expect(gh.latestStatus()?.state).toBe('pending');

    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    expect((await ctx.run()).gate).toBe('pending');
    gh.answerQuiz('author', followUp.id, pickRight);
    expect((await ctx.run()).gate).toBe('passed');

    const generations = llm.generation;
    const [code, lock] = sampleFiles(2);
    gh.push([code!, { ...lock!, patch: '@@ -1 +1 @@\n-"lockfileVersion": 3\n+"lockfileVersion": 4\n' }]);
    await ctx.run({ kind: 'push' });
    expect(llm.generation).toBe(generations);
    expect(gh.latestStatus()?.description).toContain('approve the latest commit to confirm');
    gh.approve('alice');
    expect((await ctx.run({ kind: 'approval', actor: 'alice' })).gate).toBe('passed');
    expect(gh.latestStatus()?.description).toBe('Passed by @alice; challenge passed by @author');
  });

  it('rejects a challenge with nothing to quiz on, and rests while the diff has no readable changes', async () => {
    const lockfileOnly = () => [sampleFiles()[1]!];
    const empty = setup();
    empty.gh.push(lockfileOnly());
    const rejected = await comment(empty, 'alice', '/pr-quiz challenge');
    expect(empty.gh.reactionsOn(rejected.id)).toContain('confused');
    expect(empty.gh.challengeReviews()).toHaveLength(0);

    const ctx = setup();
    const { gh } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const quiz = gh.latestQuizFor('author')!;
    gh.push(lockfileOnly());
    gh.approve('alice');
    expect((await ctx.run({ kind: 'approval', actor: 'alice' })).gate).toBe('passed');
    expect(gh.latestStatus()?.description).toBe('No readable diff to quiz on; approved by @alice');

    gh.push(sampleFiles(3));
    expect((await ctx.run({ kind: 'push' })).gate).toBe('pending');
    const again = gh.latestQuizFor('author')!;
    expect(again.id).not.toBe(quiz.id);
    expect(again.body).toContain('## 🎯 PR Quiz challenge for @author');
  });

  it('lets the challenger withdraw while the diff has no readable changes', async () => {
    const ctx = setup();
    const { gh } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const quiz = gh.latestQuizFor('author')!;
    gh.push([sampleFiles()[1]!]);
    await ctx.run({ kind: 'push' });

    const withdrawal = await comment(ctx, 'alice', '/pr-quiz withdraw');
    expect(gh.reactionsOn(withdrawal.id)).toEqual(['eyes', '+1']);
    expect(gh.challengeReviews().at(-1)!.body).toContain('↩️ **PR Quiz challenge withdrawn:**');

    gh.push(sampleFiles(3));
    await ctx.run({ kind: 'push' });
    expect(gh.latestQuizFor('author')!.id).toBe(quiz.id);
    expect(gh.latestStatus()?.description).not.toContain('@author');
  });

  it('scopes a first challenge quiz in full after a practice pass on older code', async () => {
    const ctx = setup();
    const { gh, llm } = ctx;
    await comment(ctx, 'author', '/pr-quiz');
    expect(gh.latestQuizFor('author')!.body).toContain('practice quiz');
    gh.answerQuiz('author', gh.latestQuizFor('author')!.id, pickRight);
    await ctx.run();
    gh.push(sampleFiles(2));
    await ctx.run({ kind: 'push' });

    await comment(ctx, 'alice', '/pr-quiz challenge');
    const quiz = gh.latestQuizFor('author')!;
    expect(quiz.body).toContain('## 🎯 PR Quiz challenge for @author');
    expect(quiz.body).not.toContain('after you passed');
    expect(llm.requests.findLast((r) => r.task.includes('Write '))!.context).not.toContain('<pq_scope>');
  });

  it('keeps failed challenge quizzes out of the practice attempts', async () => {
    const ctx = setup({ maxAttempts: 1 });
    const { gh } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    gh.answerQuiz('author', gh.latestQuizFor('author')!.id, pickWrongFirst);
    await ctx.run();
    await comment(ctx, 'alice', '/pr-quiz withdraw');

    const { id, result } = await comment(ctx, 'author', '/pr-quiz');
    expect(gh.reactionsOn(id)).toContain('rocket');
    expect(types(result)).not.toContain('attempts-exhausted');
    const practice = gh.latestQuizFor('author')!;
    expect(practice.body).toContain('practice quiz');
    expect(practice.body).toContain('Attempt 1');
  });

  it('replaces an open practice quiz and never counts practice', async () => {
    const ctx = setup();
    const { gh, llm } = ctx;
    await comment(ctx, 'author', '/pr-quiz');
    const practice = gh.latestQuizFor('author')!;
    expect(practice.body).toContain('practice quiz');
    gh.toggleCheckbox('author', practice.id, 0);
    const { result } = await comment(ctx, 'alice', '/pr-quiz challenge');

    expect(types(result)).toContain('quiz-replaced');
    const replaced = gh.bodyOf(practice.id);
    expect(replaced).toContain('no longer active');
    expect(replaced).toContain('@alice challenged @author, so this practice quiz was replaced by a challenge quiz.');
    expect(replaced).toContain('➡️ New quiz');
    expect(gh.latestQuizFor('author')!.body).toContain('## 🎯 PR Quiz challenge for @author');
    expect(llm.requests.findLast((r) => r.task.includes('Write '))!.task).toContain('Set 1, question 1');

    for (const pick of [pickWrongFirst, pickRight]) {
      const limited = setup({ maxAttempts: 1 });
      await comment(limited, 'author', '/pr-quiz');
      const own = limited.gh.latestQuizFor('author')!;
      limited.gh.answerQuiz('author', own.id, pick);
      await limited.run();
      await comment(limited, 'alice', '/pr-quiz challenge');
      expect(limited.gh.challengeReviews()[0]!.body).not.toContain('already passed');
      const challengeQuiz = limited.gh.latestQuizFor('author')!;
      expect(challengeQuiz.id).not.toBe(own.id);
      expect(challengeQuiz.body).toContain('## 🎯 PR Quiz challenge for @author');
    }
  });

  it('gives a challenged author their challenge quiz on /pr-quiz', async () => {
    const ctx = setup();
    const { gh, llm } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const quiz = gh.latestQuizFor('author')!;
    const generations = llm.generation;
    const { id } = await comment(ctx, 'author', '/pr-quiz');
    expect(gh.reactionsOn(id)).toContain('+1');
    expect(gh.latestQuizFor('author')!.id).toBe(quiz.id);
    expect(llm.generation).toBe(generations);
    expect(gh.comments.some((c) => c.body.includes('practice quiz'))).toBe(false);
  });

  it('needs one pass for several challengers and keeps blocking for the rest after a withdrawal', async () => {
    const ctx = setup();
    const { gh, llm } = ctx;
    await passReviewer(ctx);
    const generations = llm.generation;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    await comment(ctx, 'bob', '/pr-quiz challenge');
    expect(llm.generation).toBe(generations + 1);
    const quiz = gh.latestQuizFor('author')!;
    expect(gh.challengeReviews()[1]!.body).toContain(`@author's open challenge quiz covers this challenge too: ${quiz.html_url}`);

    gh.answerQuiz('author', quiz.id, pickRight);
    await ctx.run();
    expect(gh.latestStatus()?.description).toBe('Passed by @alice; challenge passed by @author');

    gh.push(sampleFiles(2));
    await ctx.run({ kind: 'push' });
    const followUp = gh.latestQuizFor('author')!;
    expect(followUp.id).not.toBe(quiz.id);
    await comment(ctx, 'alice', '/pr-quiz withdraw');
    expect(gh.challengeReviews().at(-1)!.body).toContain('The challenge by @bob still applies.');
    expect(gh.bodyOf(followUp.id)).toContain('## 🎯 PR Quiz challenge for @author');
    await comment(ctx, 'bob', '/pr-quiz withdraw');
    expect(gh.bodyOf(followUp.id)).toContain('The challenge was withdrawn');
  });

  it('counts a pass on the current code for a later challenger at once', async () => {
    const ctx = setup();
    const { gh, llm } = ctx;
    await passReviewer(ctx);
    await comment(ctx, 'alice', '/pr-quiz challenge');
    gh.answerQuiz('author', gh.latestQuizFor('author')!.id, pickRight);
    await ctx.run();
    const generations = llm.generation;

    const again = await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(gh.reactionsOn(again.id)).toContain('+1'); // she already challenged, and it is met
    expect(gh.challengeReviews()).toHaveLength(1);

    const { id, result } = await comment(ctx, 'carol', '/pr-quiz challenge');
    expect(gh.reactionsOn(id)).toContain('rocket');
    expect(gh.challengeReviews().at(-1)!.body).toContain('@author already passed a challenge quiz on this version of the change');
    expect(result.gate).toBe('passed');
    expect(llm.generation).toBe(generations);
  });

  it('copies a challenge into the open quiz that covers it, so it outlives its record', async () => {
    const ctx = setup({ maxAttempts: 1 });
    const { gh, codec } = ctx;
    await passReviewer(ctx);
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const quiz = gh.latestQuizFor('author')!;
    gh.answerQuiz('author', quiz.id, pickRight, false); // ticked, not submitted yet
    const ticked = readCheckboxes(gh.bodyOf(quiz.id));
    await comment(ctx, 'bob', '/pr-quiz challenge');
    const bobRecord = gh.challengeReviews()[1]!;
    expect(bobRecord.body).toContain("@author's open challenge quiz covers this challenge too");
    const sealed = codec.open(7, extractSealedState(gh.bodyOf(quiz.id))!)!;
    expect(sealed.challenge!.refs.map((r) => r.by)).toEqual(['alice']);
    expect(sealed.challenge!.later!.map((r) => r.by)).toEqual(['bob']);
    expect(readCheckboxes(gh.bodyOf(quiz.id))).toEqual(ticked); // the author's ticks survive the copy

    await comment(ctx, 'alice', '/pr-quiz withdraw');
    // bob's record is destroyed: edited, with the bot's revisions deleted from its history.
    gh.editReview('author', bobRecord.id, 'Withdrawn.');
    gh.pruneReviewRevision(bobRecord.id, (e) => e.isBot);
    expect((await ctx.run()).gate).toBe('pending');
    expect(gh.bodyOf(quiz.id)).toContain('## 🎯 PR Quiz challenge for @author');
    expect(gh.latestStatus()?.description).toBe('Waiting for @author (challenged) to answer the quiz');

    // The copy is a backup only: bob's challenge still brings its own attempts.
    gh.answerQuiz('author', quiz.id, pickWrongFirst);
    await ctx.run();
    expect(gh.latestQuizFor('author')!.body).toContain('Attempt 1');
  });

  it('copies a challenge met at once into the passed quiz, so new commits still bring a quiz', async () => {
    const ctx = setup();
    const { gh } = ctx;
    await passReviewer(ctx);
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const quiz = gh.latestQuizFor('author')!;
    gh.answerQuiz('author', quiz.id, pickRight);
    await ctx.run();
    await comment(ctx, 'carol', '/pr-quiz challenge');
    const carolRecord = gh.challengeReviews()[1]!;
    await comment(ctx, 'alice', '/pr-quiz withdraw');
    gh.editReview('author', carolRecord.id, 'Withdrawn.');
    gh.pruneReviewRevision(carolRecord.id, (e) => e.isBot);
    expect((await ctx.run()).gate).toBe('passed');

    gh.push(sampleFiles(2));
    await ctx.run({ kind: 'push' });
    const followUp = gh.latestQuizFor('author')!;
    expect(followUp.id).not.toBe(quiz.id);
    expect(followUp.body).toContain('after you passed the challenge quiz');
    expect(gh.latestStatus()?.state).toBe('pending');
  });

  it('blocks even with require-all-approvers false', async () => {
    const ctx = setup({ requireAllApprovers: false });
    await passReviewer(ctx);
    expect(ctx.gh.latestStatus()?.state).toBe('success');
    const { result } = await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(result.gate).toBe('pending');
    expect(ctx.gh.botReviewState()).toBe('CHANGES_REQUESTED');
  });

  it('reports generation errors for challenge quizzes and retries on the next push or command', async () => {
    const ctx = setup();
    const { gh, llm } = ctx;
    await passReviewer(ctx);
    expect(gh.botReviewState()).toBe('APPROVED');
    llm.failGeneration = new LlmError('overloaded', true);
    const { result } = await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(result.gate).toBe('error');
    expect(gh.latestStatus()?.description).toContain('Quiz error');
    expect(gh.challengeReviews()).toHaveLength(1);
    // No quiz to answer yet, but the challenge still takes back the bot's approval.
    expect(gh.botReviewState()).toBe('CHANGES_REQUESTED');
    expect(gh.reviews.at(-1)!.body).toContain('- @author: challenge quiz by @alice not posted yet');

    const calls = llm.requests.length;
    await ctx.run({ kind: 'comment-edit', actor: 'bob' });
    expect(llm.requests.length).toBe(calls);
    expect(gh.latestStatus()?.state).toBe('error');

    llm.failGeneration = null;
    await ctx.run({ kind: 'push' });
    expect(gh.latestQuizFor('author')!.body).toContain('## 🎯 PR Quiz challenge for @author');
    expect(gh.latestStatus()?.description).toBe('Waiting for @author (challenged) to answer the quiz');
  });

  it('ignores challenges when allow-challenges is false', async () => {
    const ctx = setup();
    const { gh, llm, codec } = ctx;
    await passReviewer(ctx);
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const quiz = gh.latestQuizFor('author')!;
    const config = testConfig({ allowChallenges: false });
    const off = { ...ctx, run: (trigger: Trigger = { kind: 'manual' }) => reconcile({ gh, codec, config, llm }, 7, trigger) };
    const listing = vi.spyOn(gh, 'listEditedReviewIds');

    expect((await off.run()).gate).toBe('passed');
    expect(gh.bodyOf(quiz.id)).toContain('Challenges are turned off for this repository');
    expect(gh.latestStatus()?.description).toBe('Passed by @alice');
    expect(gh.botReviewState()).toBe('APPROVED');
    for (const body of ['/pr-quiz challenge', '/pr-quiz withdraw']) {
      const { id } = await comment(off, 'alice', body);
      expect(gh.reactionsOn(id)).toContain('confused');
    }
    expect(gh.challengeReviews()).toHaveLength(1);
    expect(listing).not.toHaveBeenCalled();

    const { id } = await comment(off, 'author', '/pr-quiz');
    expect(gh.reactionsOn(id)).toContain('rocket');
    expect(gh.latestQuizFor('author')!.body).toContain('practice quiz');
  });

  it('is idempotent with an active challenge', async () => {
    const ctx = setup();
    const { gh } = ctx;
    await passReviewer(ctx);
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const reviews = gh.reviews.length;
    const comments = gh.comments.length;
    const second = await ctx.run();
    expect(second.actions).toEqual([]);
    expect(gh.reviews).toHaveLength(reviews);
    expect(gh.comments).toHaveLength(comments);
  });

  it('voids a challenge quiz someone else ticked, without counting an attempt', async () => {
    const ctx = setup();
    const { gh, llm } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const quiz = gh.latestQuizFor('author')!;
    gh.toggleCheckbox('alice', quiz.id, 0);
    gh.answerQuiz('author', quiz.id, pickRight);
    const generations = llm.generation;
    const result = await ctx.run();
    expect(types(result)).toContain('quiz-voided');
    const replacement = gh.latestQuizFor('author')!;
    expect(replacement.id).not.toBe(quiz.id);
    expect(replacement.body).toContain('## 🎯 PR Quiz challenge for @author');
    expect(replacement.body).toContain('Attempt 1');
    expect(llm.generation).toBe(generations);
  });

  it("acts on commands but closes no quiz while the challenge records can't be verified", async () => {
    const ctx = setup();
    const { gh } = ctx;
    await comment(ctx, 'alice', '/pr-quiz challenge');
    const quiz = gh.latestQuizFor('author')!;
    gh.failReviewEdits = true;

    // A record that can't be verified might hide a withdrawal, so the challenge is recorded again.
    const again = await comment(ctx, 'alice', '/pr-quiz challenge');
    expect(gh.reactionsOn(again.id)).toContain('rocket');
    expect(gh.challengeReviews()).toHaveLength(2);
    expect(again.result.gate).toBe('error');

    const withdrawal = await comment(ctx, 'alice', '/pr-quiz withdraw');
    expect(gh.reactionsOn(withdrawal.id)).toContain('+1');
    expect(withdrawal.result.gate).toBe('error');
    expect(gh.bodyOf(quiz.id)).toContain('## 🎯 PR Quiz challenge for @author'); // still open

    gh.failReviewEdits = false;
    await ctx.run();
    expect(gh.bodyOf(quiz.id)).toContain('The challenge was withdrawn');
    expect(gh.latestStatus()?.description).toContain('Waiting for an approving review');
  });

  it("fails closed when the edit history of challenge records can't be read", async () => {
    const ctx = setup();
    const { gh } = ctx;
    await passReviewer(ctx);
    await comment(ctx, 'alice', '/pr-quiz challenge');
    gh.answerQuiz('author', gh.latestQuizFor('author')!.id, pickRight);
    expect((await ctx.run()).gate).toBe('passed');

    gh.failReviewEdits = true;
    expect((await ctx.run()).gate).toBe('error');
    expect(gh.latestStatus()).toMatchObject({ state: 'error', description: expect.stringContaining('Could not verify a quiz or challenge') });
    gh.failReviewEdits = false;
    expect((await ctx.run()).gate).toBe('passed');

    // Pull requests that don't use challenges never depend on the review edit history.
    const other = setup();
    other.gh.reviewAsBot('LGTM from another bot');
    other.gh.failReviewEdits = true;
    await passReviewer(other);
    expect(other.gh.latestStatus()?.state).toBe('success');
  });

  it("fails closed when a challenge record that no quiz copies can't be checked", async () => {
    // The challenge quiz was never generated, so the record is the only trace of the challenge.
    const unquizzed = async () => {
      const ctx = setup();
      await passReviewer(ctx);
      ctx.llm.failGeneration = new LlmError('overloaded', true);
      await comment(ctx, 'alice', '/pr-quiz challenge');
      const record = ctx.gh.challengeReviews()[0]!;
      return { ctx, record, body: record.body! };
    };
    const unverified = async (ctx: ReturnType<typeof setup>) => {
      expect((await ctx.run({ kind: 'comment-edit', actor: 'bob' })).gate).toBe('error');
      expect(ctx.gh.latestStatus()?.description).toContain('Could not verify a quiz or challenge');
    };

    // Its edit history can't be read, even though the record was stripped.
    const failing = await unquizzed();
    failing.ctx.gh.editReview('author', failing.record.id, 'Withdrawn.');
    const getCommentEdits = failing.ctx.gh.getCommentEdits.bind(failing.ctx.gh);
    const spy = vi
      .spyOn(failing.ctx.gh, 'getCommentEdits')
      .mockImplementation((id) => (id.startsWith('PRR_') ? Promise.reject(new Error('GraphQL unavailable')) : getCommentEdits(id)));
    await unverified(failing.ctx);
    spy.mockRestore();
    const restored = await failing.ctx.run({ kind: 'comment-edit', actor: 'bob' });
    expect(types(restored)).toContain('challenge-restored');
    expect(restored.gate).not.toBe('passed');

    // Its edit history is too long to reach the bot's revisions.
    const paged = await unquizzed();
    paged.ctx.gh.editReview('author', paged.record.id, 'x');
    paged.ctx.gh.editReview('author', paged.record.id, paged.body);
    paged.ctx.gh.truncatedReviewHistory.add(paged.record.id);
    await unverified(paged.ctx);
    paged.ctx.gh.truncatedReviewHistory.clear();
    expect((await paged.ctx.run({ kind: 'comment-edit', actor: 'bob' })).gate).not.toBe('passed');
    expect(paged.ctx.gh.latestStatus()?.description).not.toContain('Could not verify');
  });
});
