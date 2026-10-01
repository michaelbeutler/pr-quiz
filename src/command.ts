/**
 * What a command comment asks for: a quiz for the commenter (`/pr-quiz`, with or without other words), or to
 * challenge or withdraw a challenge of the @mentioned authors (none: the default authors).
 */
export type Command = { verb: 'quiz' } | { verb: 'challenge' | 'withdraw'; targets: string[] };

/** A GitHub login as an @mention, keeping a `[bot]` suffix so bots are rejected by name. */
const TARGET_RE = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?)[,.;:!?]*$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isCommand(body: string | undefined, command: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(command)}(?:\\s|$)`, 'i').test(body ?? '');
}

/**
 * Reads the first line of a command comment; null when it is not a command. Only an exact `challenge` or
 * `withdraw` after the command selects a subcommand, so `/pr-quiz @bob please look` stays a plain quiz request.
 */
export function parseCommand(body: string | undefined, command: string): Command | null {
  const line = (body ?? '').trimStart().split(/\r?\n/, 1)[0] ?? '';
  if (!isCommand(line, command)) return null;
  const [first = '', ...rest] = line.slice(command.length).trim().split(/\s+/);
  const verb = first.toLowerCase();
  if (verb !== 'challenge' && verb !== 'withdraw') return { verb: 'quiz' };
  // The @mentions right after the verb; the first other word ends them ("challenge @bob please explain …").
  const targets: string[] = [];
  for (const token of rest.join(' ').split(/[\s,]+/)) {
    if (!token) continue;
    const login = TARGET_RE.exec(token)?.[1];
    if (!login) break;
    if (!targets.some((t) => t.toLowerCase() === login.toLowerCase())) targets.push(login);
  }
  return { verb, targets };
}
