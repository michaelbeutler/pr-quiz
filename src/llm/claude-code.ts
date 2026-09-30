import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Effort } from '../config.ts';
import { log } from '../util/action.ts';
import {
  LlmError,
  parseJsonLoose,
  supportsAdaptiveThinking,
  type LlmBackend,
  type StructuredRequest,
  type StructuredResponse,
} from './backend.ts';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number },
) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function parseCliOutput(stdout: string): CliResult | null {
  const candidates = [stdout.trim(), ...stdout.trim().split('\n').reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as CliResult | CliResult[];
      const result = Array.isArray(parsed) ? parsed.findLast((m) => m?.type === 'result') : parsed;
      if (result && typeof result === 'object' && result.type === 'result') return result;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Generates questions through the Claude Code CLI, which is how a Claude subscription (CLAUDE_CODE_OAUTH_TOKEN
 * from `claude setup-token`) can be used in CI. All tools are disabled and Claude Code runs in an empty
 * directory with a minimal environment, so the untrusted diff cannot make it read files or secrets.
 */
export class ClaudeCodeBackend implements LlmBackend {
  readonly label = 'Claude Code (Claude subscription)';
  readonly model: string;
  /** Empty string: reuse the local Claude Code login (for local testing only). */
  private readonly oauthToken: string;
  private readonly effort: Effort;
  private readonly version: string;
  private readonly run: ProcessRunner;
  private binary: string | null = null;

  constructor(oauthToken: string, model: string, effort: Effort, version = 'stable', run: ProcessRunner = runProcess) {
    this.oauthToken = oauthToken;
    this.model = model;
    this.effort = effort;
    this.version = version;
    this.run = run;
  }

  private async ensureBinary(): Promise<string> {
    if (this.binary) return this.binary;
    const existing = process.env.CLAUDE_CODE_PATH || findOnPath('claude');
    if (existing) return (this.binary = existing);

    if (!/^[A-Za-z0-9._-]+$/.test(this.version)) throw new LlmError(`Invalid claude-code-version "${this.version}".`, false);
    log.info(`Installing Claude Code (${this.version}) with the official installer…`);
    const install = await this.run('bash', ['-c', `curl -fsSL https://claude.ai/install.sh | bash -s ${this.version}`], {
      // No INPUT_* variables: the installer has no business seeing the action's secrets.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), LANG: process.env.LANG || 'C.UTF-8' },
      timeoutMs: 5 * 60_000,
    });
    const installed = [join(homedir(), '.local', 'bin', 'claude'), findOnPath('claude')].find((p) => p && existsSync(p));
    if (install.code !== 0 || !installed) {
      throw new LlmError(`Installing Claude Code failed (exit ${install.code}): ${install.stderr.slice(-500)}`, false);
    }
    return (this.binary = installed);
  }

  async complete(request: StructuredRequest): Promise<StructuredResponse> {
    const binary = await this.ensureBinary();
    const workDir = mkdtempSync(join(tmpdir(), 'pr-quiz-'));
    const quiet = {
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    let env: NodeJS.ProcessEnv;
    if (this.oauthToken) {
      // CI: a minimal environment, so neither the GitHub token nor other INPUT_* secrets reach the subprocess,
      // and a fresh config dir, so no settings, hooks, plugins or MCP servers from the runner leak in.
      env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: tmpdir(),
        LANG: process.env.LANG || 'C.UTF-8',
        CLAUDE_CODE_OAUTH_TOKEN: this.oauthToken,
        CLAUDE_CONFIG_DIR: join(workDir, '.claude-config'),
        ...quiet,
      };
    } else {
      // Local testing: reuse the developer's own Claude Code login.
      env = { ...process.env, ...quiet };
      for (const key of Object.keys(env)) {
        if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_ENTRY') || key.startsWith('INPUT_')) delete env[key];
      }
    }

    const args = [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(request.schema),
      '--model',
      this.model,
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--system-prompt',
      request.system,
      ...(supportsAdaptiveThinking(this.model) ? ['--effort', this.effort] : []),
    ];

    try {
      const result = await this.run(binary, args, {
        cwd: workDir,
        env,
        input: `${request.context}\n\n${request.task}`,
        timeoutMs: 20 * 60_000,
      });
      const output = parseCliOutput(result.stdout);
      if (!output || output.is_error || result.code !== 0) {
        const detail = (output?.result || result.stderr || result.stdout).trim().slice(-800);
        const authProblem = /auth|login|token|401|403|credential/i.test(detail);
        throw new LlmError(
          authProblem
            ? `Claude Code could not authenticate. Check the claude-code-oauth-token secret (create one with \`claude setup-token\`). Details: ${detail}`
            : `Claude Code failed (exit ${result.code}): ${detail}`,
          !authProblem,
        );
      }
      const data = output.structured_output ?? parseJsonLoose(output.result ?? '');
      return {
        data,
        usage: {
          inputTokens: output.usage?.input_tokens,
          outputTokens: output.usage?.output_tokens,
          cacheReadTokens: output.usage?.cache_read_input_tokens,
          cacheWriteTokens: output.usage?.cache_creation_input_tokens,
          costUsd: output.total_cost_usd,
        },
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}
