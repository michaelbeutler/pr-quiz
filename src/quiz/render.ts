import type { QuizState } from './types.ts';

export const QUIZ_MARKER = '<!-- pr-quiz:quiz -->';
export const REVIEW_MARKER = '<!-- pr-quiz:review -->';
const STATE_RE = /<!-- pr-quiz:state:([A-Za-z0-9_-]+) -->/;

export const LIMITS = { question: 400, option: 200, explanation: 700, file: 200 } as const;

export function letter(index: number): string {
  return String.fromCharCode(65 + index);
}

export function mention(login: string): string {
  return `@${login}`;
}

/** An inline code span as CommonMark defines it: a run of N backticks closed by a run of exactly N. */
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;

/**
 * Escapes `<`/`>` outside inline code spans so generated text cannot inject HTML. Inside code spans `<!--` is
 * broken up as well, in case a renderer disagrees about where a span ends.
 */
function escapeHtmlOutsideCode(text: string): string {
  const escape = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '';
  let last = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    out += escape(text.slice(last, match.index)) + match[0].replace(/<!--/g, '<​!--');
    last = match.index + match[0].length;
  }
  return out + escape(text.slice(last));
}

/**
 * Turns model output into a single safe markdown line: no newlines (which could create extra checkboxes),
 * no raw HTML or HTML comments (which could hide text or fake our markers), no accidental @mentions.
 */
export function inlineText(raw: string, maxLength: number): string {
  let text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  text = escapeHtmlOutsideCode(text);
  text = text.replace(/@(?=[A-Za-z0-9_-])/g, '@​');
  if (text.length > maxLength) text = text.slice(0, maxLength - 1).trimEnd() + '…';
  return text;
}

export function extractSealedState(body: string): string | null {
  return STATE_RE.exec(body)?.[1] ?? null;
}

export function isQuizBody(body: string | null | undefined): boolean {
  return !!body && body.includes(QUIZ_MARKER) && STATE_RE.test(body);
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function footer(state: QuizState, sealed: string): string[] {
  const parts = [
    `Attempt ${state.attempt}`,
    `commit \`${shortSha(state.headSha)}\``,
    state.scope === 'incremental' ? 'follow-up on new commits' : undefined,
    `questions by \`${state.model}\``,
    'PR Quiz',
  ].filter(Boolean);
  return ['', `<sub>${parts.join(' · ')}</sub>`, `<!-- pr-quiz:state:${sealed} -->`];
}

function fileLine(file: string | undefined): string[] {
  return file ? [`<sub>📄 \`${file.replace(/`/g, '')}\`</sub>`] : [];
}

/**
 * The open quiz. Rendering is deterministic: re-rendering a state with the checkbox values read from a comment
 * reproduces that comment exactly, which is how edits to anything but the checkboxes are detected.
 */
export function renderOpenQuiz(state: QuizState, sealed: string, selections?: boolean[][], submitted = false): string {
  const who = mention(state.reviewer);
  const lines: string[] = [QUIZ_MARKER, `## 🧠 PR Quiz for ${who}`, ''];

  if (state.scope === 'incremental') {
    lines.push(
      `${who}, new commits changed this pull request after you passed your last quiz. ` +
        'Before your approval counts for the new code, answer these questions about what changed.',
    );
  } else if (state.attempt > 1) {
    lines.push(
      `${who}, not all of your previous answers were correct, so here is a new set of questions about the change. ` +
        'Your approval counts once you answer all of them correctly.',
    );
  } else {
    lines.push(
      `${who}, before your approval of this pull request counts, show that you understand the change by answering ` +
        'these questions. They were generated from the diff.',
    );
  }
  lines.push(
    '',
    '- Tick **exactly one** answer per question, then tick **Submit answers** at the bottom.',
    '- Every answer must be correct. If one is wrong, your approval is dismissed, your review is re-requested and you get new questions.',
    `- Only ${who} can answer this quiz.`,
    '',
    '---',
  );

  state.questions.forEach((q, qi) => {
    lines.push('', `**Q${qi + 1}.** ${q.text}`, ...fileLine(q.file), '');
    q.options.forEach((option, oi) => {
      const checked = selections?.[qi]?.[oi] ? 'x' : ' ';
      lines.push(`- [${checked}] ${letter(oi)}. ${option}`);
    });
  });

  lines.push('', '---', '');
  if (state.notice) lines.push('> [!WARNING]', `> ${state.notice}`, '');
  lines.push(`- [${submitted ? 'x' : ' '}] **Submit answers**`);
  lines.push(...footer(state, sealed));
  return lines.join('\n');
}

function renderAnswerBlock(state: QuizState, qi: number, showCorrect: boolean): string[] {
  const q = state.questions[qi]!;
  const chosen = state.result?.answers[qi] ?? -1;
  const lines = ['', `**Q${qi + 1}.** ${q.text}`, ...fileLine(q.file)];
  const optionText = (i: number) => (i >= 0 && i < q.options.length ? `**${letter(i)}.** ${q.options[i]}` : '_no answer_');
  if (chosen === q.answer) {
    lines.push(`✅ ${optionText(chosen)}`);
  } else {
    lines.push(`❌ Your answer: ${optionText(chosen)}`);
    if (showCorrect) lines.push(`✅ Correct answer: ${optionText(q.answer)}`);
  }
  lines.push('', `> ${q.explanation}`);
  return lines;
}

function renderClosingNotes(state: QuizState): string[] {
  const notes = [...(state.closingNotes ?? [])];
  if (state.followUpUrl) notes.push(`➡️ New quiz: ${state.followUpUrl}`);
  return notes.length ? ['', ...notes.map((n) => `- ${n}`)] : [];
}

export function renderPassedQuiz(state: QuizState, sealed: string): string {
  const who = mention(state.reviewer);
  const n = state.questions.length;
  const lines = [
    QUIZ_MARKER,
    `## ✅ PR Quiz passed by ${who}`,
    '',
    `${who} answered ${n === 1 ? 'the question' : `all ${n} questions`} correctly on attempt ${state.attempt} ` +
      `(commit \`${shortSha(state.headSha)}\`).`,
    '',
    '<details>',
    '<summary>Questions, answers and explanations</summary>',
  ];
  state.questions.forEach((_, qi) => lines.push(...renderAnswerBlock(state, qi, true)));
  lines.push('', '</details>', ...renderClosingNotes(state), ...footer(state, sealed));
  return lines.join('\n');
}

export function renderFailedQuiz(state: QuizState, sealed: string): string {
  const who = mention(state.reviewer);
  const correct = state.result?.correct ?? [];
  const right = correct.filter(Boolean).length;
  const lines = [
    QUIZ_MARKER,
    `## ❌ PR Quiz not passed by ${who} (${right} of ${state.questions.length} correct)`,
    '',
    'These answers were wrong. The explanations should help with the next set of questions:',
  ];
  state.questions.forEach((_, qi) => {
    if (!correct[qi]) lines.push(...renderAnswerBlock(state, qi, true));
  });
  if (right > 0) {
    lines.push('', '<details>', `<summary>Correctly answered (${right})</summary>`);
    state.questions.forEach((_, qi) => {
      if (correct[qi]) lines.push(...renderAnswerBlock(state, qi, true));
    });
    lines.push('', '</details>');
  }
  lines.push(...renderClosingNotes(state), ...footer(state, sealed));
  return lines.join('\n');
}

export function renderOutdatedQuiz(state: QuizState, sealed: string): string {
  const who = mention(state.reviewer);
  const lines = [
    QUIZ_MARKER,
    `## ⏭️ PR Quiz for ${who}: no longer active`,
    '',
    state.closedReason ??
      `New commits changed this pull request after the quiz was generated at \`${shortSha(state.headSha)}\`, ` +
        'so it no longer applies.',
    ...renderClosingNotes(state),
    ...footer(state, sealed),
  ];
  return lines.join('\n');
}

export function renderVoidQuiz(state: QuizState, sealed: string): string {
  const who = mention(state.reviewer);
  const culprits = (state.voidedBy ?? []).map((login) => `\`${login}\``).join(', ') || 'someone else';
  const lines = [
    QUIZ_MARKER,
    `## 🚫 PR Quiz for ${who}: invalidated`,
    '',
    state.closedReason ?? `This quiz was edited by ${culprits}. Only ${who} may answer it, so it was replaced with a fresh copy.`,
    ...renderClosingNotes(state),
    ...footer(state, sealed),
  ];
  return lines.join('\n');
}

export function renderQuiz(state: QuizState, sealed: string, selections?: boolean[][], submitted = false): string {
  switch (state.status) {
    case 'open':
      return renderOpenQuiz(state, sealed, selections, submitted);
    case 'passed':
      return renderPassedQuiz(state, sealed);
    case 'failed':
      return renderFailedQuiz(state, sealed);
    case 'outdated':
      return renderOutdatedQuiz(state, sealed);
    case 'void':
      return renderVoidQuiz(state, sealed);
  }
}
