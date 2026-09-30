import Anthropic from '@anthropic-ai/sdk';
import type { Effort } from '../config.ts';
import {
  LlmError,
  parseJsonLoose,
  supportsAdaptiveThinking,
  type LlmBackend,
  type StructuredRequest,
  type StructuredResponse,
} from './backend.ts';

/** Models that accept server-side refusal fallbacks with `fallbacks: "default"` on the Claude API. */
const DEFAULT_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** Calls the Messages API with an Anthropic API key. */
export class AnthropicBackend implements LlmBackend {
  readonly label = 'Anthropic API';
  readonly model: string;
  private readonly effort: Effort;
  private readonly client: Anthropic;

  constructor(apiKey: string, model: string, effort: Effort, client?: Anthropic) {
    this.model = model;
    this.effort = effort;
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 4 });
  }

  async complete(request: StructuredRequest): Promise<StructuredResponse> {
    const adaptive = supportsAdaptiveThinking(this.model);
    const withFallback = DEFAULT_FALLBACK_MODELS.has(this.model);
    const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: 64000,
      stream: true,
      system: request.system,
      messages: [
        {
          role: 'user',
          content: [
            // Identical for generation and verification, so the second call reads it from the prompt cache.
            { type: 'text', text: request.context, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: request.task },
          ],
        },
      ],
      output_config: {
        ...(adaptive ? { effort: this.effort } : {}),
        format: { type: 'json_schema', schema: request.schema },
      },
      ...(adaptive ? { thinking: { type: 'adaptive' } } : {}),
      // If a safety classifier declines (e.g. security-heavy code), rerun on Anthropic's recommended fallback model.
      ...(withFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    };

    let message: Anthropic.Beta.Messages.BetaMessage;
    try {
      message = await this.client.beta.messages.stream(params).finalMessage();
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new LlmError(`Anthropic API rejected the credentials (${error.status}). Check the anthropic-api-key secret.`, false);
      }
      if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
        throw new LlmError(`Anthropic API rejected the request (${error.status}): ${error.message}`, false);
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new LlmError('Anthropic API rate limit reached; retry later.', true);
      }
      if (error instanceof Anthropic.APIError) {
        throw new LlmError(`Anthropic API error ${error.status ?? ''}: ${error.message}`, true);
      }
      throw error;
    }

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category ?? 'unspecified';
      throw new LlmError(`Claude declined to write questions for this change (refusal category: ${category}).`, false);
    }
    if (message.stop_reason === 'max_tokens') {
      throw new LlmError('Claude hit the output token limit before finishing the questions.', true);
    }
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    return {
      data: parseJsonLoose(text),
      servedBy: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? undefined,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? undefined,
      },
    };
  }
}
