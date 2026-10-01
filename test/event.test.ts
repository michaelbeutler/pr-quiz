import { describe, expect, it } from 'vitest';
import { parseCommand, type Command } from '../src/command.ts';
import { ConfigError, readConfig } from '../src/config.ts';
import { isCommand, parseEvent } from '../src/event.ts';

const repository = { id: 1, full_name: 'acme/shop' };

describe('parseEvent', () => {
  it('turns an approval into an approval trigger', () => {
    const parsed = parseEvent(
      'pull_request_review',
      {
        action: 'submitted',
        repository,
        pull_request: { number: 7, head: { repo: { full_name: 'acme/shop' } } },
        review: { state: 'approved', user: { login: 'alice', type: 'User' } },
      },
      '/pr-quiz',
    );
    expect(parsed).toEqual({ prNumber: 7, trigger: { kind: 'approval', actor: 'alice' } });
  });

  it('skips reviews on fork pull requests and points to the command', () => {
    const parsed = parseEvent(
      'pull_request_review',
      {
        action: 'submitted',
        repository,
        pull_request: { number: 7, head: { repo: { full_name: 'someone/shop' } } },
        review: { state: 'approved', user: { login: 'alice', type: 'User' } },
      },
      '/pr-quiz',
    );
    expect(parsed.skipReason).toContain('/pr-quiz');
  });

  it('decides about bot review events by who caused them, not by who wrote the review', () => {
    const base = { repository, pull_request: { number: 7, head: { repo: { full_name: 'acme/shop' } } } };
    // A human dismisses the bot's blocking review: re-evaluate so the block comes back.
    expect(
      parseEvent(
        'pull_request_review',
        { ...base, action: 'dismissed', sender: { login: 'alice', type: 'User' }, review: { state: 'dismissed', user: { login: 'github-actions[bot]', type: 'Bot' } } },
        '/pr-quiz',
      ).trigger,
    ).toEqual({ kind: 'review', actor: 'github-actions[bot]' });
    // The bot dismissing a human's approval (App token) is its own doing: skip.
    expect(
      parseEvent(
        'pull_request_review',
        { ...base, action: 'dismissed', sender: { login: 'pr-quiz[bot]', type: 'Bot' }, review: { state: 'dismissed', user: { login: 'alice', type: 'User' } } },
        '/pr-quiz',
      ).skipReason,
    ).toBeDefined();
  });

  it('recognizes quiz edits and commands, and ignores other comments', () => {
    const base = { repository, issue: { number: 7, pull_request: {} }, sender: { login: 'alice', type: 'User' } };
    expect(parseEvent('issue_comment', { ...base, action: 'edited', comment: { body: '<!-- pr-quiz:quiz -->' } }, '/pr-quiz').trigger).toEqual({
      kind: 'comment-edit',
      actor: 'alice',
    });
    expect(
      parseEvent('issue_comment', { ...base, action: 'created', comment: { id: 5, body: '/pr-quiz please', user: { login: 'bob' } } }, '/pr-quiz')
        .trigger,
    ).toEqual({ kind: 'command', actor: 'bob', commandCommentId: 5 });
    expect(parseEvent('issue_comment', { ...base, action: 'created', comment: { body: 'nice work' } }, '/pr-quiz').skipReason).toBeDefined();
    expect(
      parseEvent('issue_comment', { ...base, sender: { login: 'x[bot]', type: 'Bot' }, action: 'edited', comment: { body: '<!-- pr-quiz:quiz -->' } }, '/pr-quiz')
        .skipReason,
    ).toBeDefined();
    expect(parseEvent('issue_comment', { action: 'created', issue: { number: 3 }, comment: { body: '/pr-quiz' } }, '/pr-quiz').skipReason).toBeDefined();
  });

  it('treats pushes as reconcile triggers', () => {
    expect(parseEvent('pull_request_target', { pull_request: { number: 9 }, sender: { login: 'dev' } }, '/pr-quiz')).toEqual({
      prNumber: 9,
      trigger: { kind: 'push', actor: 'dev' },
    });
  });

  it('matches commands case-insensitively and as a whole word', () => {
    expect(isCommand('/PR-QUIZ', '/pr-quiz')).toBe(true);
    expect(isCommand('  /pr-quiz\nthanks', '/pr-quiz')).toBe(true);
    expect(isCommand('/pr-quizzes', '/pr-quiz')).toBe(false);
    expect(isCommand('please /pr-quiz', '/pr-quiz')).toBe(false);
  });

  it('parses subcommands', () => {
    const cases: Array<[string, Command | null]> = [
      ['/pr-quiz', { verb: 'quiz' }],
      ['/pr-quiz please', { verb: 'quiz' }],
      ['/pr-quiz challenger', { verb: 'quiz' }],
      ['/pr-quiz @bob please look', { verb: 'quiz' }],
      ['/PR-QUIZ Challenge @Bob, @carol please', { verb: 'challenge', targets: ['Bob', 'carol'] }],
      ['/pr-quiz challenge @bob please explain the retry path', { verb: 'challenge', targets: ['bob'] }],
      ['/pr-quiz challenge @bob,@carol. @BOB', { verb: 'challenge', targets: ['bob', 'carol'] }],
      ['/pr-quiz challenge the author @bob', { verb: 'challenge', targets: [] }],
      ['/pr-quiz challenge\n@bob', { verb: 'challenge', targets: [] }],
      ['/pr-quiz challenge @dependabot[bot]', { verb: 'challenge', targets: ['dependabot[bot]'] }],
      ['/pr-quiz withdraw @bob', { verb: 'withdraw', targets: ['bob'] }],
      ['  /pr-quiz WITHDRAW', { verb: 'withdraw', targets: [] }],
      // Answering by reply is not supported: this is a plain quiz request.
      ['/pr-quiz answer B D A', { verb: 'quiz' }],
      ['please /pr-quiz challenge', null],
      ['/pr-quizzes challenge', null],
    ];
    for (const [body, expected] of cases) expect(parseCommand(body, '/pr-quiz'), body).toEqual(expected);
    expect(parseCommand('/quiz challenge', '/quiz')).toEqual({ verb: 'challenge', targets: [] });
  });

  it('attaches the subcommand to command triggers', () => {
    const base = { repository, issue: { number: 7, pull_request: {} }, sender: { login: 'alice', type: 'User' } };
    const created = (body: string) =>
      parseEvent('issue_comment', { ...base, action: 'created', comment: { id: 5, body, user: { login: 'alice' } } }, '/pr-quiz').trigger;
    expect(created('/pr-quiz challenge @bob')).toEqual({
      kind: 'command',
      actor: 'alice',
      commandCommentId: 5,
      command: { verb: 'challenge', targets: ['bob'] },
    });
    expect(created('/pr-quiz please')).toEqual({ kind: 'command', actor: 'alice', commandCommentId: 5 });
    expect(created('/pr-quiz please')).not.toHaveProperty('command');
    expect(parseEvent('issue_comment', { ...base, action: 'edited', comment: { id: 5, body: '/pr-quiz challenge' } }, '/pr-quiz').skipReason).toBeDefined();
  });
});

describe('readConfig', () => {
  const inputs = (values: Record<string, string>) => (name: string) => values[name] ?? '';

  it('requires a Claude credential', () => {
    expect(() => readConfig(inputs({ 'github-token': 't' }))).toThrow(ConfigError);
  });

  it('applies defaults and derives the state secret from the credential', () => {
    const config = readConfig(inputs({ 'github-token': 't', 'claude-code-oauth-token': 'oauth', 'ignore-paths': 'docs/**, *.md' }));
    expect(config).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'high',
      questionCount: 3,
      optionCount: 4,
      requireAllApprovers: true,
      maxAttempts: 5,
      stateSecret: 'oauth',
      statusContext: 'pr-quiz',
    });
    expect(config.ignorePaths).toContain('docs/**');
    expect(config.ignorePaths).toContain('**/package-lock.json');
  });

  it('turns challenges on by default', () => {
    const base = { 'github-token': 't', 'anthropic-api-key': 'k' };
    expect(readConfig(inputs(base)).allowChallenges).toBe(true);
    expect(readConfig(inputs({ ...base, 'allow-challenges': 'false' })).allowChallenges).toBe(false);
    expect(() => readConfig(inputs({ ...base, 'allow-challenges': 'nope' }))).toThrow(/true or false/);
  });

  it('validates numbers and booleans', () => {
    expect(() => readConfig(inputs({ 'github-token': 't', 'anthropic-api-key': 'k', questions: '0' }))).toThrow(/between 1 and 10/);
    expect(() => readConfig(inputs({ 'github-token': 't', 'anthropic-api-key': 'k', 'verify-questions': 'maybe' }))).toThrow(
      /true or false/,
    );
  });
});
