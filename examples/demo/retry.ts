/**
 * Retries a flaky async operation with exponential backoff and full jitter.
 *
 * Meant for calls to third-party APIs that occasionally time out or rate-limit us.
 */

export interface RetryOptions {
  /** Total number of attempts, including the first one. Default: 4. */
  attempts?: number;
  /** Delay cap before the first retry; it doubles for every further retry. Default: 200 ms. */
  baseDelayMs?: number;
  /** Upper bound for any single delay. Default: 5 s. */
  maxDelayMs?: number;
  /** Decides whether an error is worth another attempt. Default: {@link isTransient}. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Stops the remaining attempts and any pending delay. */
  signal?: AbortSignal;
  /** Injectable for tests. */
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class RetryError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    super(`Operation failed after ${attempts} attempt(s)`, { cause: lastError });
    this.name = 'RetryError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/** Network errors (no HTTP status), 429 and 5xx are worth retrying; other 4xx are not. */
export function isTransient(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status === undefined) return true;
  return status === 429 || status >= 500;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export async function retry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 4,
    baseDelayMs = 200,
    maxDelayMs = 5_000,
    shouldRetry = isTransient,
    signal,
    random = Math.random,
    sleep = defaultSleep,
  } = options;
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts must be a positive integer');

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) break;
      // Full jitter: wait a random time between 0 and the exponential cap.
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.floor(random() * cap), signal);
    }
  }
  throw new RetryError(attempts, lastError);
}
