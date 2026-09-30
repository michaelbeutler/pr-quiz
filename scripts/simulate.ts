// Walks through the review flow against an in-memory GitHub and a fake Claude, printing what the bot posts.
//   npm run simulate
import { StateCodec } from '../src/quiz/crypto.ts';
import { reconcile, type Trigger } from '../src/reconcile.ts';
import { log } from '../src/util/action.ts';
import { FakeGitHub, FakeLlm, pickRight, pickWrongFirst, testConfig } from '../test/fakes.ts';

log.info = () => {};
log.warning = () => {};

const gh = new FakeGitHub();
const llm = new FakeLlm();
const config = testConfig();
const codec = new StateCodec(config.stateSecret, 4242);
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function step(title: string, trigger: Trigger, before?: () => void): Promise<void> {
  console.log(`\n${bold(`━━ ${title} ━━`)}`);
  before?.();
  const result = await reconcile({ gh, codec, config, llm }, 7, trigger);
  for (const action of result.actions) console.log(`  • ${action.type}: ${action.detail}`);
  const status = gh.latestStatus();
  console.log(dim(`  status ${status?.context}: ${status?.state} · ${status?.description}`));
  console.log(dim(`  bot review: ${gh.botReviewState() ?? 'none'} · alice's review: ${gh.reviewStateOf('alice') ?? 'none'}`));
}

function show(commentId: number): void {
  const body = gh.comments.find((c) => c.id === commentId)!.body.replace(/\r\n/g, '\n');
  const pretty = body.replace(/<!-- pr-quiz:state:[\w-]+ -->/, '<!-- pr-quiz:state:<encrypted answer key> -->');
  console.log(pretty.split('\n').map((line) => `  │ ${line}`).join('\n'));
}

await step('1. @author opens pull request #7', { kind: 'push', actor: 'author' });

await step('2+3. @alice reviews the code and approves', { kind: 'approval', actor: 'alice' }, () => gh.approve('alice'));
const quiz1 = gh.latestQuizFor('alice')!;
console.log(bold('\n4. The bot posted this quiz and requested changes until it is passed:'));
show(quiz1.id);

await step('5. @alice ticks her answers (Q1 wrong) and ticks "Submit answers"', { kind: 'comment-edit', actor: 'alice' }, () =>
  gh.answerQuiz('alice', quiz1.id, pickWrongFirst),
);
console.log(bold('\n6. The first quiz now shows the results; her approval was dismissed and her review re-requested:'));
show(quiz1.id);
const quiz2 = gh.latestQuizFor('alice')!;
console.log(bold('\n7. New questions:'));
show(quiz2.id);

await step('8. @alice answers every question correctly', { kind: 'comment-edit', actor: 'alice' }, () =>
  gh.answerQuiz('alice', quiz2.id, pickRight),
);
console.log(bold('\n9. The bot approved. Final quiz comment:'));
show(quiz2.id);
