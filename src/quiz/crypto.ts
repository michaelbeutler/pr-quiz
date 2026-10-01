import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { ChallengeRecord, QuizState } from './types.ts';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Seals quiz state with AES-256-GCM. The additional authenticated data binds every blob to one repository
 * (by numeric id, which survives renames) and one pull request, so a passed quiz cannot be replayed elsewhere
 * and any modification of the blob is detected. Challenge records use their own AAD, so a quiz blob can't pass
 * for a record or the other way round.
 */
export class StateCodec {
  private readonly key: Buffer;
  private readonly repositoryId: number | string;

  constructor(secret: string, repositoryId: number | string) {
    if (!secret) throw new Error('StateCodec needs a non-empty secret');
    this.repositoryId = repositoryId;
    this.key = Buffer.from(hkdfSync('sha256', secret, 'pr-quiz', 'pr-quiz quiz-state v1', 32));
  }

  private aad(pr: number): string {
    return `pr-quiz:v1:${this.repositoryId}#${pr}`;
  }

  private challengeAad(pr: number): string {
    return `pr-quiz:v1:challenge:${this.repositoryId}#${pr}`;
  }

  private encrypt(aad: string, value: unknown): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const plaintext = deflateRawSync(Buffer.from(JSON.stringify(value), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
  }

  /** The sealed value, or null when the blob was not produced by this key with this AAD, or was tampered with. */
  private decrypt(aad: string, blob: string): unknown {
    try {
      const raw = Buffer.from(blob, 'base64url');
      if (raw.length < IV_BYTES + TAG_BYTES + 1) return null;
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(raw.length - TAG_BYTES);
      const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(inflateRawSync(plaintext).toString('utf8')) as unknown;
    } catch {
      return null;
    }
  }

  seal(pr: number, state: QuizState): string {
    return this.encrypt(this.aad(pr), state);
  }

  /** Returns null when the blob was not produced by this key for this pull request, or was tampered with. */
  open(pr: number, blob: string): QuizState | null {
    const state = this.decrypt(this.aad(pr), blob) as QuizState | null;
    return state && state.v === 1 && Array.isArray(state.questions) ? state : null;
  }

  sealChallenge(pr: number, record: ChallengeRecord): string {
    return this.encrypt(this.challengeAad(pr), record);
  }

  /** Like `open`, for challenge records. */
  openChallenge(pr: number, blob: string): ChallengeRecord | null {
    const record = this.decrypt(this.challengeAad(pr), blob) as Record<string, unknown> | null;
    if (!record || typeof record !== 'object' || record.v !== 1) return null;
    if (typeof record.by !== 'string' || typeof record.at !== 'string') return null;
    if (record.commandCommentId !== undefined && typeof record.commandCommentId !== 'number') return null;
    const valid =
      record.kind === 'challenge'
        ? typeof record.id === 'string' && typeof record.challengee === 'string'
        : record.kind === 'withdraw' && Array.isArray(record.ids) && record.ids.every((id) => typeof id === 'string');
    return valid ? (record as unknown as ChallengeRecord) : null;
  }
}
