import type { QuizState } from './types.ts';

export interface Grade {
  /** Every question has exactly one selected option. */
  complete: boolean;
  /** Human-readable reasons why the submission is incomplete. */
  problems: string[];
  /** Selected option per question, -1 when not exactly one is selected. */
  answers: number[];
  correct: boolean[];
  passed: boolean;
}

export function grade(state: QuizState, selections: boolean[][]): Grade {
  const problems: string[] = [];
  const answers = state.questions.map((q, qi) => {
    const picked = (selections[qi] ?? []).flatMap((on, oi) => (on ? [oi] : []));
    if (picked.length === 0) problems.push(`Q${qi + 1} has no answer selected.`);
    if (picked.length > 1) problems.push(`Q${qi + 1} has ${picked.length} answers selected; pick exactly one.`);
    return picked.length === 1 ? picked[0]! : -1;
  });
  const correct = state.questions.map((q, qi) => answers[qi] === q.answer);
  const complete = problems.length === 0;
  return { complete, problems, answers, correct, passed: complete && correct.every(Boolean) };
}
