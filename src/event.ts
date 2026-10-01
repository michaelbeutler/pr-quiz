import { isCommand, parseCommand } from './command.ts';
import { QUIZ_MARKER } from './quiz/render.ts';
import type { Trigger } from './reconcile.ts';

export { isCommand } from './command.ts';

interface EventUser {
  login?: string;
  type?: string;
}

interface EventPayload {
  action?: string;
  repository?: { id?: number; full_name?: string };
  sender?: EventUser;
  pull_request?: { number?: number; head?: { repo?: { full_name?: string } | null } };
  review?: { state?: string; user?: EventUser };
  issue?: { number?: number; pull_request?: unknown };
  comment?: { id?: number; body?: string; user?: EventUser };
}

export interface ParsedEvent {
  prNumber?: number;
  trigger?: Trigger;
  /** Set when the event needs no work. */
  skipReason?: string;
}

export function parseEvent(eventName: string, raw: unknown, command: string): ParsedEvent {
  const payload = (raw ?? {}) as EventPayload;
  switch (eventName) {
    case 'pull_request_review': {
      const prNumber = payload.pull_request?.number;
      const headRepo = payload.pull_request?.head?.repo?.full_name;
      const baseRepo = payload.repository?.full_name;
      if (headRepo && baseRepo && headRepo.toLowerCase() !== baseRepo.toLowerCase()) {
        return {
          prNumber,
          skipReason:
            `review events on pull requests from forks run without secrets or write access. ` +
            `The reviewer can comment "${command}" to take the quiz instead.`,
        };
      }
      // The sender caused the event: for a dismissal that is the dismisser, not the review's author.
      if (payload.sender?.type === 'Bot') return { prNumber, skipReason: 'the review event was caused by a bot.' };
      const approved = payload.action === 'submitted' && payload.review?.state?.toLowerCase() === 'approved';
      return { prNumber, trigger: { kind: approved ? 'approval' : 'review', actor: payload.review?.user?.login } };
    }
    case 'pull_request':
    case 'pull_request_target':
      return { prNumber: payload.pull_request?.number, trigger: { kind: 'push', actor: payload.sender?.login } };
    case 'issue_comment': {
      const prNumber = payload.issue?.number;
      if (!payload.issue?.pull_request) return { prNumber, skipReason: 'the comment is on an issue, not a pull request.' };
      if (payload.sender?.type === 'Bot') return { prNumber, skipReason: 'the comment event was caused by a bot.' };
      const body = payload.comment?.body ?? '';
      if (payload.action === 'created' && isCommand(body, command)) {
        const parsed = parseCommand(body, command);
        return {
          prNumber,
          trigger: {
            kind: 'command',
            actor: payload.comment?.user?.login,
            commandCommentId: payload.comment?.id,
            // A plain request keeps the trigger it always had.
            ...(parsed && parsed.verb !== 'quiz' ? { command: parsed } : {}),
          },
        };
      }
      if ((payload.action === 'edited' || payload.action === 'deleted') && body.includes(QUIZ_MARKER)) {
        return { prNumber, trigger: { kind: 'comment-edit', actor: payload.sender?.login } };
      }
      return { prNumber, skipReason: 'the comment is neither a quiz nor a quiz command.' };
    }
    default:
      return { trigger: { kind: 'manual', actor: payload.sender?.login } };
  }
}
