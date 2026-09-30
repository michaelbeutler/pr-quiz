import { readFileSync } from 'node:fs';
import { readConfig } from './config.ts';
import { parseEvent } from './event.ts';
import { RestGitHub } from './github/client.ts';
import { AnthropicBackend } from './llm/anthropic.ts';
import type { LlmBackend } from './llm/backend.ts';
import { ClaudeCodeBackend } from './llm/claude-code.ts';
import { StateCodec } from './quiz/crypto.ts';
import { reconcile, type ReconcileResult } from './reconcile.ts';
import { appendSummary, getInput, log, setFailed, setOutput } from './util/action.ts';

const GATE_ICON: Record<ReconcileResult['gate'], string> = { passed: '✅', pending: '⏳', error: '❌', skipped: '⏭️' };

function writeSummary(prNumber: number, result: ReconcileResult): void {
  const rows = result.actions.map((a) => `| \`${a.type}\` | ${a.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  appendSummary(
    [
      `### 🧠 PR Quiz · #${prNumber}`,
      '',
      `**Gate:** ${GATE_ICON[result.gate]} ${result.gate} · ${result.description}`,
      '',
      ...(rows.length ? ['| Action | Detail |', '| --- | --- |', ...rows] : ['_No changes were needed._']),
    ].join('\n'),
  );
}

async function run(): Promise<void> {
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  const payload: unknown = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is not set.');

  const event = parseEvent(eventName, payload, getInput('command') || '/pr-quiz');
  if (event.skipReason && !getInput('pr-number')) {
    log.info(`Nothing to do: ${event.skipReason}`);
    setOutput('gate', 'skipped');
    setOutput('actions', '[]');
    return;
  }

  const config = readConfig();
  const prNumber = config.prNumber ?? event.prNumber;
  if (!prNumber) throw new Error(`Could not determine the pull request for a "${eventName}" event; set the pr-number input.`);

  const gh = new RestGitHub({
    token: config.githubToken,
    owner,
    repo,
    apiUrl: process.env.GITHUB_API_URL,
    graphqlUrl: process.env.GITHUB_GRAPHQL_URL,
  });
  const repositoryId =
    process.env.GITHUB_REPOSITORY_ID || (payload as { repository?: { id?: number } }).repository?.id || repository.toLowerCase();
  const codec = new StateCodec(config.stateSecret, repositoryId);
  const llm: LlmBackend = config.anthropicApiKey
    ? new AnthropicBackend(config.anthropicApiKey, config.model, config.effort)
    : new ClaudeCodeBackend(config.claudeCodeOAuthToken ?? '', config.model, config.effort, config.claudeCodeVersion);

  const trigger = event.trigger ?? { kind: 'manual' as const };
  log.info(`PR #${prNumber} · trigger: ${trigger.kind}${trigger.actor ? ` by ${trigger.actor}` : ''} · questions by ${llm.label} (${llm.model})`);

  const result = await reconcile({ gh, codec, config, llm }, prNumber, trigger);
  log.info(`Gate: ${result.gate} · ${result.description}`);
  setOutput('gate', result.gate);
  setOutput('actions', JSON.stringify(result.actions));
  writeSummary(prNumber, result);
  if (result.gate === 'error') setFailed(result.description);
}

run().catch((error: unknown) => {
  setFailed(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
