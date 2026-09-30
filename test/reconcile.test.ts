import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import { LlmError } from '../src/llm/backend.ts';
import { StateCodec } from '../src/quiz/crypto.ts';
import { readCheckboxes } from '../src/quiz/parse.ts';
import { reconcile, type Trigger } from '../src/reconcile.ts';
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

  it('lets reviewers request a quiz with the command, but not the author or read-only users', async () => {
    const { gh, run } = setup();
    gh.permissions.set('reader', 'read');
    const own = gh.say('author', '/pr-quiz');
    await run({ kind: 'command', actor: 'author', commandCommentId: own.id });
    expect(gh.reactions).toContainEqual({ commentId: own.id, content: 'confused' });

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
  it('excludes people who committed to the pull request, and ignores their approvals', async () => {
    const { gh, run } = setup();
    gh.push(sampleFiles(2), 'bob'); // bob pushed a fix-up commit
    gh.approve('bob');
    const own = gh.say('bob', '/pr-quiz');
    await run({ kind: 'command', actor: 'bob', commandCommentId: own.id });
    expect(gh.latestQuizFor('bob')).toBeUndefined();
    expect(gh.reactions).toContainEqual({ commentId: own.id, content: 'confused' });

    gh.approve('alice');
    await run();
    gh.answerQuiz('alice', gh.latestQuizFor('alice')!.id, pickRight);
    expect((await run()).gate).toBe('passed');
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
