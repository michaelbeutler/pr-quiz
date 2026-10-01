import { describe, expect, it } from 'vitest';
import { StateCodec } from '../src/quiz/crypto.ts';
import { grade } from '../src/quiz/grade.ts';
import { normalizeBody, parseOpenQuiz, readCheckboxes } from '../src/quiz/parse.ts';
import {
  AI_NOTE,
  AI_NOTE_CHALLENGE,
  ATTESTATION,
  extractChallengeState,
  formatDuration,
  inlineText,
  isQuizBody,
  extractSealedState,
  QUIZ_MARKER,
  renderChallengeRecord,
  renderPlaceholder,
  renderQuiz,
  REVIEW_MARKER,
} from '../src/quiz/render.ts';
import type { ChallengeRecord, QuizState } from '../src/quiz/types.ts';

const baseState = (): QuizState => ({
  v: 1,
  id: 'q1',
  reviewer: 'alice',
  attempt: 1,
  headSha: 'a'.repeat(40),
  fingerprint: 'fp',
  scope: 'full',
  status: 'open',
  questions: [
    { text: 'What does `total()` return?', file: 'src/cart.ts', options: ['0', 'sum', 'NaN', 'throws'], answer: 1, explanation: 'SECRET-EXPLANATION' },
    { text: 'Which items are discounted?', options: ['all', 'none', 'first', 'last'], answer: 0, explanation: 'Because.' },
  ],
  model: 'claude-opus-5-5',
  createdAt: '2026-09-30T12:00:00.000Z',
});

describe('StateCodec', () => {
  const codec = new StateCodec('secret', 4242);

  it('round-trips the state', () => {
    const state = baseState();
    expect(codec.open(7, codec.seal(7, state))).toEqual(state);
  });

  it('keeps the answer key out of the visible blob', () => {
    const blob = codec.seal(7, baseState());
    expect(blob).not.toContain('SECRET');
    expect(Buffer.from(blob, 'base64url').toString('latin1')).not.toContain('answer');
  });

  it('rejects blobs moved to another pull request or repository, or sealed with another secret', () => {
    const blob = codec.seal(7, baseState());
    expect(codec.open(8, blob)).toBeNull();
    expect(new StateCodec('secret', 1).open(7, blob)).toBeNull();
    expect(new StateCodec('other', 4242).open(7, blob)).toBeNull();
  });

  it('rejects tampered blobs', () => {
    const blob = codec.seal(7, baseState());
    const middle = Math.floor(blob.length / 2);
    const flipped = blob.slice(0, middle) + (blob[middle] === 'A' ? 'B' : 'A') + blob.slice(middle + 1);
    expect(codec.open(7, flipped)).toBeNull();
    expect(codec.open(7, 'garbage')).toBeNull();
  });
});

describe('rendering and parsing', () => {
  const sealed = 'SEALED_blob-1';

  it('renders an open quiz whose checkboxes parse back exactly', () => {
    const state = baseState();
    const body = renderQuiz(state, sealed);
    expect(isQuizBody(body)).toBe(true);
    expect(extractSealedState(body)).toBe(sealed);
    expect(readCheckboxes(body)).toHaveLength(9);
    expect(body).not.toContain('SECRET-EXPLANATION');
    const parsed = parseOpenQuiz(body, state, sealed);
    expect(parsed).toMatchObject({ readable: true, intact: true, submitted: false });
  });

  it('reads answers ticked in the GitHub UI, including CRLF line endings', () => {
    const state = baseState();
    const selections = [
      [false, true, false, false],
      [true, false, false, false],
    ];
    const body = renderQuiz(state, sealed, selections, true).replace(/\n/g, '\r\n');
    const parsed = parseOpenQuiz(body, state, sealed);
    expect(parsed).toMatchObject({ readable: true, intact: true, submitted: true, selections });
  });

  it('notices text edits but can still read the answers', () => {
    const state = baseState();
    const body = renderQuiz(state, sealed).replace('Which items are discounted?', 'Which items (hint: all) are discounted?');
    expect(parseOpenQuiz(body, state, sealed)).toMatchObject({ readable: true, intact: false });
  });

  it('cannot read a quiz whose checkbox lines were removed', () => {
    const state = baseState();
    const body = renderQuiz(state, sealed).replace('- [ ] C. NaN\n', '');
    expect(parseOpenQuiz(body, state, sealed).readable).toBe(false);
  });

  it('asks AI assistants in the raw markdown not to answer, and puts the attestation on the submit checkbox', () => {
    const state = { ...baseState(), attested: true };
    const body = renderQuiz(state, sealed);
    expect(body).toContain(AI_NOTE);
    expect(body).toContain(`- [ ] **Submit answers**: ${ATTESTATION}`);
    expect(readCheckboxes(body)).toHaveLength(9);
    expect(parseOpenQuiz(renderQuiz(state, sealed, undefined, true), state, sealed)).toMatchObject({ intact: true, submitted: true });
  });

  it('keeps the old submit checkbox for quizzes created before the attestation', () => {
    const body = renderQuiz(baseState(), sealed);
    expect(body).toMatch(/- \[ \] \*\*Submit answers\*\*$/m);
    expect(body).not.toContain(ATTESTATION);
  });

  it('shows the attestation and the answer time on a passed quiz', () => {
    const state: QuizState = { ...baseState(), attested: true, status: 'passed' };
    state.result = {
      answers: [1, 0],
      correct: [true, true],
      gradedAt: '2026-09-30T12:02:00Z',
      timing: { shownAt: '2026-09-30T12:00:00Z', firstAnswerAt: '2026-09-30T12:00:38Z', submittedAt: '2026-09-30T12:01:12Z' },
    };
    const body = renderQuiz(state, sealed);
    expect(body).toContain(`@alice confirmed: _${ATTESTATION}_`);
    expect(body).toContain('Attempt 1 · answered in 1 min 12 s ·');
    expect(body).not.toContain(AI_NOTE);
  });

  it('normalizes bodies', () => {
    expect(normalizeBody('a  \r\nb\t\r\n')).toBe('a\nb');
  });

  it('shows explanations and results after grading', () => {
    const state = baseState();
    state.status = 'failed';
    state.result = { answers: [2, 0], correct: [false, true], gradedAt: '2026-09-30T12:01:00Z' };
    state.closingNotes = ["@alice's approval was dismissed."];
    state.followUpUrl = 'https://example.test/quiz-2';
    const body = renderQuiz(state, sealed);
    expect(body).toContain('not passed by @alice (1 of 2 correct)');
    expect(body).toContain('❌ Your answer: **C.** NaN');
    expect(body).toContain('✅ Correct answer: **B.** sum');
    expect(body).toContain('SECRET-EXPLANATION');
    expect(body).toContain('➡️ New quiz: https://example.test/quiz-2');
    expect(readCheckboxes(body)).toHaveLength(0);
  });
});

describe('challenges', () => {
  const codec = new StateCodec('secret', 4242);
  const sealed = 'SEALED_blob-1';
  const record: ChallengeRecord = {
    v: 1,
    kind: 'challenge',
    id: 'c1',
    by: 'bob',
    challengee: 'alice',
    at: '2026-09-30T12:00:00.000Z',
    commandCommentId: 5,
  };
  const withdrawal: ChallengeRecord = { v: 1, kind: 'withdraw', ids: ['c1'], by: 'bob', at: '2026-09-30T12:05:00.000Z' };
  const challenged = (): QuizState => ({
    ...baseState(),
    attested: true,
    challenge: { refs: [{ id: 'c1', by: 'bob', at: '2026-09-30T12:00:00.000Z', commandCommentId: 5 }] },
  });

  it('seals challenge records apart from quiz state', () => {
    const blob = codec.sealChallenge(7, record);
    expect(codec.openChallenge(7, blob)).toEqual(record);
    expect(codec.openChallenge(7, codec.sealChallenge(7, withdrawal))).toEqual(withdrawal);
    expect(codec.open(7, blob)).toBeNull();
    expect(codec.openChallenge(7, codec.seal(7, baseState()))).toBeNull();
    expect(codec.openChallenge(8, blob)).toBeNull();
    expect(codec.openChallenge(7, codec.sealChallenge(7, { ...record, kind: 'x' } as unknown as ChallengeRecord))).toBeNull();
    expect(codec.openChallenge(7, codec.sealChallenge(7, { ...withdrawal, ids: [1] } as unknown as ChallengeRecord))).toBeNull();
    expect(codec.openChallenge(7, 'garbage')).toBeNull();
  });

  it('renders a challenge quiz that parses back intact', () => {
    const state = challenged();
    const body = renderQuiz(state, sealed);
    expect(readCheckboxes(body)).toHaveLength(9);
    expect(parseOpenQuiz(body, state, sealed)).toMatchObject({ readable: true, intact: true, submitted: false });
    expect(parseOpenQuiz(renderQuiz(state, sealed, undefined, true), state, sealed)).toMatchObject({ intact: true, submitted: true });
    expect(body).toContain(AI_NOTE_CHALLENGE);
    expect(body).not.toContain(AI_NOTE);
    expect(body).toContain('## 🎯 PR Quiz challenge for @alice');
    expect(body).toContain('@alice, @bob challenged you to show that you understand this change.');
    expect(body).toContain('If one is wrong, you see the right answers and get new questions; nothing on the pull request is dismissed.');
    expect(body).toContain(`- [ ] **Submit answers**: ${ATTESTATION}`);
    expect(body).toContain('<sub>Attempt 1 · challenge · commit');
    expect(renderQuiz({ ...state, attempt: 2 }, sealed)).toContain('@alice, not all of your previous answers were correct');
    expect(renderQuiz({ ...state, scope: 'incremental' }, sealed)).toContain(
      '@alice, new commits changed this pull request after you passed the challenge quiz.',
    );
    expect(renderPlaceholder('alice', true)).toBe('⏳ Preparing a PR Quiz challenge for @alice…');
    expect(renderPlaceholder('alice')).toBe('⏳ Preparing a PR Quiz for @alice…');
  });

  it('renders closed challenge quizzes', () => {
    const gradedAt = '2026-09-30T12:01:00Z';
    const passed = renderQuiz({ ...challenged(), status: 'passed', result: { answers: [1, 0], correct: [true, true], gradedAt } }, sealed);
    expect(passed).toContain('## ✅ PR Quiz challenge passed by @alice');
    expect(passed).toContain(`@alice confirmed: _${ATTESTATION}_`);
    expect(passed).toContain('This meets the challenge by @bob.');
    const failed = renderQuiz({ ...challenged(), status: 'failed', result: { answers: [1, 2], correct: [true, false], gradedAt } }, sealed);
    expect(failed).toContain('## ❌ PR Quiz challenge not passed by @alice (1 of 2 correct)');
    expect(renderQuiz({ ...challenged(), status: 'outdated' }, sealed)).toContain('## ⏭️ PR Quiz challenge for @alice: no longer active');
    expect(renderQuiz({ ...challenged(), status: 'void' }, sealed)).toContain('## 🚫 PR Quiz challenge for @alice: invalidated');
  });

  it('renders challenge records', () => {
    const info = { command: '/pr-quiz' };
    const body = renderChallengeRecord(record, codec.sealChallenge(7, record), info);
    expect(body).toContain('🎯 **PR Quiz challenge:** @bob challenged @alice to show that they understand this change.');
    expect(body).toContain('@alice, the bot posts a quiz about the change in the conversation.');
    expect(body).toContain('only @bob can withdraw it, with `/pr-quiz withdraw @alice`');
    expect(codec.openChallenge(7, extractChallengeState(body)!)).toEqual(record);
    expect(body).not.toContain(REVIEW_MARKER);
    expect(body).not.toContain(QUIZ_MARKER);
    expect(isQuizBody(body)).toBe(false);
    expect(extractSealedState(body)).toBeNull();

    expect(renderChallengeRecord(record, sealed, { ...info, openQuizUrl: 'https://example.test/quiz' })).toContain(
      "@alice's open challenge quiz covers this challenge too: https://example.test/quiz",
    );
    expect(renderChallengeRecord(record, sealed, { ...info, met: true })).toContain(
      '@alice already passed a challenge quiz on this version of the change, so the challenge is met until new commits change the code.',
    );
    const extra = renderChallengeRecord(record, sealed, { ...info, renewedAttempts: 5, notAuthors: ['carol'], noWriteAccess: ['dave'] });
    expect(extra).toContain('@alice had used all 5 attempts; this challenge gives them 5 new ones.');
    expect(extra).toContain('`carol` is not a human author of this change, so they were not challenged.');
    expect(extra).toContain("`dave` can't answer a quiz here (no write access), so they were not challenged.");

    const withdrawn = renderChallengeRecord(withdrawal, sealed, { ...info, challengees: ['alice'], remaining: ['carol'] });
    expect(withdrawn).toContain('↩️ **PR Quiz challenge withdrawn:** @bob withdrew their challenge for @alice.');
    expect(withdrawn).toContain('The challenge by @carol still applies.');
    expect(extractChallengeState(withdrawn)).toBe(sealed);
    expect(renderChallengeRecord(withdrawal, sealed, { ...info, challengees: ['alice'] })).not.toContain('still applies');
  });
});

describe('formatDuration', () => {
  it('rounds to seconds and drops zero parts', () => {
    expect(formatDuration(-5)).toBe('0 s');
    expect(formatDuration(42_400)).toBe('42 s');
    expect(formatDuration(185_000)).toBe('3 min 5 s');
    expect(formatDuration(120_000)).toBe('2 min');
    expect(formatDuration(7_440_000)).toBe('2 h 4 min');
    expect(formatDuration(3_600_000)).toBe('1 h');
  });
});

describe('inlineText', () => {
  it('keeps generated text on one safe line', () => {
    const text = inlineText('Line one\n- [ ] fake box <!-- pr-quiz:state:x --> <img src=x> ping @alice `Map<K, V>`', 400);
    expect(text).not.toContain('\n');
    expect(text).not.toContain('<!--');
    expect(text).not.toContain('<img');
    expect(text).toContain('@​alice');
    expect(text).toContain('`Map<K, V>`');
  });

  it('only trusts code spans GitHub would recognize', () => {
    // Mismatched backtick runs are not a code span on GitHub, so the comment opener must be escaped.
    expect(inlineText('``oops` <!-- hide the rest', 400)).not.toContain('<!--');
    expect(inlineText('`a` and `<!-- x -->`', 400)).toBe('`a` and `<​!-- x -->`');
    expect(inlineText('``code with ` inside``', 400)).toBe('``code with ` inside``');
    // An escaped backtick is literal, so what follows is not code and must be escaped.
    expect(inlineText('\\`<img src=x onerror=alert(1)>`', 400)).not.toContain('<img');
  });

  it('truncates long text', () => {
    expect(inlineText('x'.repeat(50), 10)).toBe('x'.repeat(9) + '…');
  });
});

describe('grade', () => {
  it('passes only when every question has exactly one correct answer', () => {
    const state = baseState();
    expect(grade(state, [[false, true, false, false], [true, false, false, false]])).toMatchObject({ complete: true, passed: true });
    expect(grade(state, [[true, false, false, false], [true, false, false, false]])).toMatchObject({
      complete: true,
      passed: false,
      correct: [false, true],
    });
  });

  it('reports missing and multiple answers', () => {
    const result = grade(baseState(), [[false, false, false, false], [true, true, false, false]]);
    expect(result.complete).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual(['Q1 has no answer selected.', 'Q2 has 2 answers selected; pick exactly one.']);
  });
});
