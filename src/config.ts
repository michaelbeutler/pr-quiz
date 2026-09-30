import { getInput, setSecret } from './util/action.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Files that rarely say anything about a change's behavior. Users can add more via `ignore-paths`. */
export const DEFAULT_IGNORE_PATHS: readonly string[] = [
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/go.sum',
  '**/poetry.lock',
  '**/Pipfile.lock',
  '**/uv.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/packages.lock.json',
  '**/gradle.lockfile',
  '**/flake.lock',
  '**/Package.resolved',
  '**/pubspec.lock',
  '**/mix.lock',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.snap',
  '**/__snapshots__/**',
];

export interface Config {
  githubToken: string;
  anthropicApiKey?: string;
  claudeCodeOAuthToken?: string;
  model: string;
  effort: Effort;
  questionCount: number;
  optionCount: number;
  verifyQuestions: boolean;
  requireAllApprovers: boolean;
  /** 0 = unlimited */
  maxAttempts: number;
  submitReviews: boolean;
  statusContext: string;
  command: string;
  ignorePaths: string[];
  maxDiffChars: number;
  includeFileContext: boolean;
  extraInstructions: string;
  stateSecret: string;
  prNumber?: number;
  claudeCodeVersion: string;
}

export class ConfigError extends Error {}

export function parseBool(name: string, raw: string, fallback: boolean): boolean {
  if (raw === '') return fallback;
  if (/^(true|yes|on|1)$/i.test(raw)) return true;
  if (/^(false|no|off|0)$/i.test(raw)) return false;
  throw new ConfigError(`Input "${name}" must be true or false, got "${raw}".`);
}

export function parseIntInRange(name: string, raw: string, fallback: number, min: number, max: number): number {
  if (raw === '') return fallback;
  if (!/^-?\d+$/.test(raw)) throw new ConfigError(`Input "${name}" must be an integer, got "${raw}".`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`Input "${name}" must be between ${min} and ${max}, got ${value}.`);
  return value;
}

export function splitList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith('#'));
}

export function readConfig(input: (name: string) => string = getInput): Config {
  const githubToken = input('github-token') || process.env.GITHUB_TOKEN || '';
  if (!githubToken) throw new ConfigError('No GitHub token available. Pass `github-token` or grant the workflow a GITHUB_TOKEN.');

  const anthropicApiKey = input('anthropic-api-key') || undefined;
  const claudeCodeOAuthToken = input('claude-code-oauth-token') || undefined;
  const explicitStateSecret = input('state-secret');
  for (const secret of [githubToken, anthropicApiKey, claudeCodeOAuthToken, explicitStateSecret]) {
    if (secret) setSecret(secret);
  }
  if (!anthropicApiKey && !claudeCodeOAuthToken) {
    throw new ConfigError(
      'Connect Claude first: set the `anthropic-api-key` input (Anthropic API key) or the `claude-code-oauth-token` input ' +
        '(Claude subscription token from `claude setup-token`). See the README for details.',
    );
  }

  const effort = (input('effort') || 'high').toLowerCase() as Effort;
  if (!EFFORTS.includes(effort)) throw new ConfigError(`Input "effort" must be one of ${EFFORTS.join(', ')}.`);

  const prNumberRaw = input('pr-number');
  const prNumber = prNumberRaw ? parseIntInRange('pr-number', prNumberRaw, 0, 1, Number.MAX_SAFE_INTEGER) : undefined;

  const command = (input('command') || '/pr-quiz').trim();
  if (!/^\S+$/.test(command)) throw new ConfigError('Input "command" must be a single word such as /pr-quiz.');

  return {
    githubToken,
    anthropicApiKey,
    claudeCodeOAuthToken,
    model: input('model') || 'claude-opus-5-5',
    effort,
    questionCount: parseIntInRange('questions', input('questions'), 3, 1, 10),
    optionCount: parseIntInRange('options-per-question', input('options-per-question'), 4, 3, 6),
    verifyQuestions: parseBool('verify-questions', input('verify-questions'), true),
    requireAllApprovers: parseBool('require-all-approvers', input('require-all-approvers'), true),
    maxAttempts: parseIntInRange('max-attempts', input('max-attempts'), 5, 0, 1000),
    submitReviews: parseBool('submit-reviews', input('submit-reviews'), true),
    statusContext: input('status-context') || 'pr-quiz',
    command,
    ignorePaths: [...DEFAULT_IGNORE_PATHS, ...splitList(input('ignore-paths'))],
    maxDiffChars: parseIntInRange('max-diff-chars', input('max-diff-chars'), 200_000, 5_000, 3_000_000),
    includeFileContext: parseBool('include-file-context', input('include-file-context'), true),
    extraInstructions: input('extra-instructions'),
    stateSecret: explicitStateSecret || anthropicApiKey || claudeCodeOAuthToken || '',
    prNumber,
    claudeCodeVersion: input('claude-code-version') || 'stable',
  };
}
