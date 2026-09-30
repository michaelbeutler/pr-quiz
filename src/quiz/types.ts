export type QuizStatus =
  /** Waiting for the reviewer to answer. */
  | 'open'
  /** Every answer was correct. */
  | 'passed'
  /** At least one answer was wrong. */
  | 'failed'
  /** New commits changed the code after the quiz was generated. */
  | 'outdated'
  /** Invalidated (e.g. someone other than the reviewer ticked boxes) and replaced by a fresh copy. */
  | 'void';

export interface Question {
  /** One paragraph of markdown, already sanitized for rendering. */
  text: string;
  /** Most relevant changed file. */
  file?: string;
  /** Answer options in display order (already shuffled). */
  options: string[];
  /** Index into `options` of the correct answer. */
  answer: number;
  /** Why the correct answer is right. Revealed only after grading. */
  explanation: string;
}

export interface QuizResult {
  /** Selected option per question; -1 when none. */
  answers: number[];
  correct: boolean[];
  gradedAt: string;
}

/**
 * Everything the bot needs to grade a quiz. Stored AES-GCM encrypted inside the quiz comment, so the
 * answer key stays secret and cannot be forged or copied to another repository or pull request.
 */
export interface QuizState {
  v: 1;
  id: string;
  /** Login of the only person allowed to answer. */
  reviewer: string;
  /** 1-based attempt number of this reviewer on this pull request. */
  attempt: number;
  /** Pull request head when the quiz was generated. */
  headSha: string;
  /** Fingerprint of all reviewable changes when the quiz was generated. */
  fingerprint: string;
  /** Per-file fingerprints (omitted for very large pull requests). Used to scope follow-up quizzes. */
  files?: Record<string, string>;
  /** 'incremental' quizzes only cover files that changed since the reviewer last passed. */
  scope: 'full' | 'incremental';
  status: QuizStatus;
  questions: Question[];
  model: string;
  createdAt: string;
  result?: QuizResult;
  /** Warning shown above the submit checkbox (e.g. a question without an answer). */
  notice?: string;
  /** Link to the quiz that replaced this one. */
  followUpUrl?: string;
  /** Extra lines appended to a graded/closed quiz, e.g. what happened to the approval. */
  closingNotes?: string[];
  /** Who caused a quiz to be voided. */
  voidedBy?: string[];
  /** Why an outdated/void quiz was closed, when the default wording does not fit. */
  closedReason?: string;
}

/** A quiz comment on the pull request together with its decrypted state. */
export interface QuizComment {
  commentId: number;
  nodeId: string;
  url: string;
  body: string;
  createdAt: string;
  /** Login of the bot account that posted the comment. */
  author: string;
  state: QuizState;
}
