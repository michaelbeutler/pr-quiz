import { renderOpenQuiz } from './render.ts';
import type { QuizState } from './types.ts';

const CHECKBOX_RE = /^[ \t]*[-*+][ \t]+\[([ xX])\](?=[ \t]|$)/;

/** GitHub may convert line endings and strip trailing whitespace when a checkbox is toggled in the UI. */
export function normalizeBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

export function readCheckboxes(body: string): boolean[] {
  const boxes: boolean[] = [];
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const match = CHECKBOX_RE.exec(line);
    if (match) boxes.push(match[1] !== ' ');
  }
  return boxes;
}

export interface ParsedQuiz {
  /** The checkbox count matches the quiz, so the answers can be read. */
  readable: boolean;
  /** Everything except the checkbox marks is exactly what the bot rendered. */
  intact: boolean;
  selections: boolean[][];
  submitted: boolean;
}

export function parseOpenQuiz(body: string, state: QuizState, sealed: string): ParsedQuiz {
  const boxes = readCheckboxes(body);
  const expected = state.questions.reduce((sum, q) => sum + q.options.length, 0) + 1;
  const empty = state.questions.map((q) => q.options.map(() => false));
  if (boxes.length !== expected) {
    return { readable: false, intact: false, selections: empty, submitted: false };
  }
  let i = 0;
  const selections = state.questions.map((q) => q.options.map(() => boxes[i++]!));
  const submitted = boxes[i]!;
  const intact = normalizeBody(renderOpenQuiz(state, sealed, selections, submitted)) === normalizeBody(body);
  return { readable: true, intact, selections, submitted };
}
