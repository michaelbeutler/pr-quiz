import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicBackend } from '../src/llm/anthropic.ts';
import { LlmError } from '../src/llm/backend.ts';

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

/** Real SDK, fake transport: records the request and answers with a canned SSE stream. */
function fakeClient(text: string, stopReason = 'end_turn', model = 'claude-opus-5-5') {
  const captured: Captured[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const events: Array<[string, unknown]> = [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
          },
        },
      ],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: {
            stop_reason: stopReason,
            stop_sequence: null,
            ...(stopReason === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } } : {}),
          },
          usage: { output_tokens: 42 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ];
    const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { client: new Anthropic({ apiKey: 'sk-test', fetch, maxRetries: 0 }), captured };
}

const request = {
  system: 'SYSTEM',
  context: 'CONTEXT',
  task: 'TASK',
  schema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
};

describe('AnthropicBackend', () => {
  it('streams a structured-output request with adaptive thinking, effort, fallbacks and a cache breakpoint', async () => {
    const { client, captured } = fakeClient('{"value": 5}');
    const response = await new AnthropicBackend('sk-test', 'claude-opus-5-5', 'high', client).complete(request);

    expect(response.data).toEqual({ value: 5 });
    expect(response.usage).toMatchObject({ outputTokens: 42, cacheReadTokens: 900 });
    const [sent] = captured;
    expect(sent!.url).toContain('/v1/messages');
    expect(sent!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(sent!.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: request.schema } },
      system: 'SYSTEM',
    });
    expect(sent!.body.betas).toBeUndefined(); // sent as a header, not in the body
    expect(sent!.body.messages[0].content).toEqual([
      { type: 'text', text: 'CONTEXT', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'TASK' },
    ]);
  });

  it('omits thinking, effort and fallbacks for models that do not take them', async () => {
    const { client, captured } = fakeClient('{"value": 1}', 'end_turn', 'claude-haiku-4-5');
    await new AnthropicBackend('sk-test', 'claude-haiku-4-5', 'high', client).complete(request);
    const body = captured[0]!.body;
    expect(body.thinking).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema: request.schema } });
    expect(captured[0]!.headers.get('anthropic-beta')).toBeNull();
  });

  it('turns a refusal into a non-retryable error that names the category', async () => {
    const { client } = fakeClient('', 'refusal');
    const error = await new AnthropicBackend('sk-test', 'claude-opus-5-5', 'high', client).complete(request).catch((e) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.message).toContain('cyber');
    expect(error.retryable).toBe(false);
  });

  it('reports truncated output', async () => {
    const { client } = fakeClient('{"value": ', 'max_tokens');
    await expect(new AnthropicBackend('sk-test', 'claude-opus-5-5', 'high', client).complete(request)).rejects.toThrow(
      /output token limit/,
    );
  });
});
