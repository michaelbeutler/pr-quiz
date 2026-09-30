export interface StructuredRequest {
  system: string;
  /** Large content shared by the generation and verification calls (cached on the API). */
  context: string;
  /** Instructions for this particular call. */
  task: string;
  /** JSON schema the answer must follow. */
  schema: Record<string, unknown>;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface StructuredResponse {
  data: unknown;
  usage?: Usage;
  /** Model that actually answered (differs when a refusal fallback ran). */
  servedBy?: string;
}

export interface LlmBackend {
  readonly label: string;
  readonly model: string;
  complete(request: StructuredRequest): Promise<StructuredResponse>;
}

export class LlmError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'LlmError';
    this.retryable = retryable;
  }
}

/** Parses JSON that may be wrapped in a code fence or surrounded by prose. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new LlmError('Claude did not return JSON.', true);
  }
}

/** Models that take adaptive thinking and `effort` (Claude 4.6 and newer, except Haiku). */
export function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(opus|sonnet|fable|mythos)-(4-[6-9]|[5-9])/.test(model);
}
