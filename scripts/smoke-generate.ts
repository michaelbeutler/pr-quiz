// Generates a real quiz for a public pull request with Claude and prints it with the answer key.
//   GITHUB_TOKEN=$(gh auth token) npm run smoke -- sindresorhus/ky 880 [model]
// Uses ANTHROPIC_API_KEY when set, otherwise your local Claude Code login (`claude` on PATH).
import { DEFAULT_IGNORE_PATHS } from '../src/config.ts';
import { buildChangeSet, contextCandidates, renderPullRequestContext } from '../src/diff.ts';
import { RestGitHub } from '../src/github/client.ts';
import { AnthropicBackend } from '../src/llm/anthropic.ts';
import type { LlmBackend } from '../src/llm/backend.ts';
import { ClaudeCodeBackend } from '../src/llm/claude-code.ts';
import { generateQuiz } from '../src/llm/generator.ts';
import { letter } from '../src/quiz/render.ts';

const [repoArg = 'sindresorhus/ky', prArg = '880', model = 'claude-opus-5-5'] = process.argv.slice(2);
const [owner, repo] = repoArg.split('/');
const prNumber = Number(prArg);
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!owner || !repo || !prNumber || !token) {
  console.error('Usage: GITHUB_TOKEN=$(gh auth token) npm run smoke -- owner/repo <pr-number> [model]');
  process.exit(1);
}

const gh = new RestGitHub({ token, owner, repo });
const pr = await gh.getPull(prNumber);
const changes = buildChangeSet(await gh.listFiles(prNumber), DEFAULT_IGNORE_PATHS);
const fileContents = new Map<string, string>();
for (const file of contextCandidates(changes).slice(0, 5)) {
  const text = await gh.getFileText(file.path, pr.head.sha);
  if (text && text.length < 60_000) fileContents.set(file.path, text);
}
const context = renderPullRequestContext(
  { title: pr.title, body: pr.body, author: pr.user?.login ?? 'unknown', baseRef: pr.base.ref, headRef: pr.head.ref },
  changes,
  { maxChars: 200_000, fileContents },
);

const llm: LlmBackend = process.env.ANTHROPIC_API_KEY
  ? new AnthropicBackend(process.env.ANTHROPIC_API_KEY, model, 'high')
  : new ClaudeCodeBackend('', model, 'high');
console.log(`${repoArg}#${prNumber}: ${pr.title}`);
console.log(`${changes.files.length} reviewable file(s), ${context.text.length} context chars, ${llm.label} · ${model}\n`);

const started = Date.now();
const quiz = await generateQuiz(llm, {
  context: context.text,
  reviewer: 'reviewer',
  questionCount: 3,
  optionCount: 4,
  previousQuestions: [],
  incremental: false,
  extraInstructions: '',
  verify: true,
});

quiz.questions.forEach((q, i) => {
  console.log(`Q${i + 1}. ${q.text}${q.file ? `  [${q.file}]` : ''}`);
  q.options.forEach((option, o) => console.log(`   ${o === q.answer ? '✔' : ' '} ${letter(o)}. ${option}`));
  console.log(`   ↳ ${q.explanation}\n`);
});
const cost = quiz.usage.reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
const tokens = quiz.usage.reduce((sum, u) => sum + (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0), 0);
console.log(
  `verified ${quiz.verifiedCount}, dropped ${quiz.droppedCount} · ${quiz.usage.length} calls · ~${tokens} tokens` +
    `${cost ? ` · $${cost.toFixed(3)}` : ''} · ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
