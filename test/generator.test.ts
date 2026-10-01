import { describe, expect, it } from 'vitest';
import { LlmError, parseJsonLoose, supportsAdaptiveThinking } from '../src/llm/backend.ts';
import { buildGenerationTask, generateQuiz, toCandidates, type GenerationInput } from '../src/llm/generator.ts';
import { FakeLlm } from './fakes.ts';

const input = (overrides: Partial<GenerationInput> = {}): GenerationInput => ({
  context: '<pq_pull_request>…</pq_pull_request>',
  reviewer: 'alice',
  questionCount: 3,
  optionCount: 4,
  previousQuestions: [],
  incremental: false,
  extraInstructions: '',
  verify: true,
  ...overrides,
});

describe('toCandidates', () => {
  it('drops malformed questions, removes duplicate options and keeps the key after shuffling', () => {
    const candidates = toCandidates(
      {
        questions: [
          { question: 'Q1?', file: 'a.ts', correct_answer: 'right', distractors: ['w1', 'w2', 'w3'], explanation: 'e' },
          { question: 'Q1?', file: 'a.ts', correct_answer: 'dup', distractors: ['w1', 'w2', 'w3'], explanation: 'e' },
          { question: 'Too few distractors', file: 'a.ts', correct_answer: 'r', distractors: ['w1', 'R', 'w1'], explanation: 'e' },
          { question: '', file: '', correct_answer: 'r', distractors: ['a', 'b', 'c'], explanation: '' },
          { question: 'Multi\nline <b>q</b>', file: '`b.ts`', correct_answer: 'right', distractors: ['a', 'b', 'c', 'd'], explanation: '' },
        ],
      },
      4,
    );
    expect(candidates).toHaveLength(2);
    for (const { question } of candidates) {
      expect(question.options).toHaveLength(4);
      expect(question.options[question.answer]).toBe('right');
    }
    expect(candidates[1]!.question.text).toBe('Multi line &lt;b&gt;q&lt;/b&gt;');
    expect(candidates[1]!.question.file).toBe('b.ts');
    expect(candidates[1]!.question.explanation).toBe('No explanation was provided.');
  });

  it('rejects output without questions', () => {
    expect(() => toCandidates({ nope: [] }, 4)).toThrow(LlmError);
  });

  it('shuffles the correct answer into different positions', () => {
    const positions = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const [c] = toCandidates(
        { questions: [{ question: 'Q?', file: 'a', correct_answer: 'right', distractors: ['a', 'b', 'c'], explanation: 'e' }] },
        4,
      );
      positions.add(c!.question.answer);
    }
    expect(positions.size).toBeGreaterThan(2);
  });
});

describe('generateQuiz', () => {
  it('asks for extra candidates and keeps only questions the blind verifier confirms', async () => {
    const llm = new FakeLlm();
    llm.ambiguousFirst = true;
    const quiz = await generateQuiz(llm, input());
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0]!.task).toContain('Write 5 multiple-choice questions');
    expect(quiz.questions).toHaveLength(3);
    expect(quiz.questions.some((q) => q.text.includes('AMBIGUOUS'))).toBe(false);
    expect(quiz.droppedCount).toBe(1);
    expect(quiz.verifiedCount).toBe(3);
    // Both calls share the cacheable context block.
    expect(llm.requests[1]!.context).toBe(llm.requests[0]!.context);
  });

  it('skips verification when disabled', async () => {
    const llm = new FakeLlm();
    const quiz = await generateQuiz(llm, input({ verify: false }));
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.task).toContain('Write 3 multiple-choice questions');
    expect(quiz.questions).toHaveLength(3);
    expect(quiz.verifiedCount).toBe(0);
  });

  it('falls back to unverified questions when the verification call fails', async () => {
    const llm = new FakeLlm();
    const original = llm.complete.bind(llm);
    llm.complete = async (request) => {
      if (request.task.includes('<pq_questions>')) throw new LlmError('overloaded', true);
      return original(request);
    };
    const quiz = await generateQuiz(llm, input());
    expect(quiz.questions).toHaveLength(3);
    expect(quiz.verifiedCount).toBe(0);
  });

  it('tells the model about earlier questions, follow-ups and maintainer instructions', () => {
    const task = buildGenerationTask(
      input({ previousQuestions: ['Old question?'], incremental: true, extraInstructions: 'Write in German.' }),
      4,
    );
    expect(task).toContain('Write 4 multiple-choice questions for @alice');
    expect(task).toContain('- Old question?');
    expect(task).toContain('follow-up quiz');
    expect(task).toContain('Write in German.');
  });

  it('frames author quizzes and forbids questions about motives', () => {
    const challenge = buildGenerationTask(input({ audience: 'author', challengers: ['carol'] }), 3);
    expect(challenge.split('\n')[1]).toMatch(
      /^Write 3 multiple-choice questions for @alice, an author of this pull request\. @carol, reviewing it, challenged @alice/,
    );
    expect(challenge).toContain('Do not ask about motives');
    expect(challenge).toContain('no question may be answerable by restating them');

    const practice = buildGenerationTask(input({ audience: 'author', challengers: [] }), 3);
    expect(practice).toContain('Write 3 multiple-choice questions for @alice, an author of this pull request');
    expect(practice).toContain('asked to practice');
    expect(practice).toContain('Do not ask about motives');

    const review = buildGenerationTask(input(), 3);
    expect(review).toContain('who is reviewing this pull request');
    expect(review).not.toContain('an author of this pull request');
    expect(review).not.toContain('Do not ask about motives');
  });
});

describe('backend helpers', () => {
  it('parses JSON wrapped in prose or fences', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here you go: {"a":2} done')).toEqual({ a: 2 });
    expect(() => parseJsonLoose('no json')).toThrow(LlmError);
  });

  it('knows which models take adaptive thinking and effort', () => {
    expect(supportsAdaptiveThinking('claude-opus-5-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-sonnet-5-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-opus-4-6')).toBe(true);
    expect(supportsAdaptiveThinking('claude-haiku-4-5')).toBe(false);
    expect(supportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false);
  });
});
