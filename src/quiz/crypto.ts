import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { QuizState } from './types.ts';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Seals quiz state with AES-256-GCM. The additional authenticated data binds every blob to one repository
 * (by numeric id, which survives renames) and one pull request, so a passed quiz cannot be replayed elsewhere
 * and any modification of the blob is detected.
 */
export class StateCodec {
  private readonly key: Buffer;
  private readonly repositoryId: number | string;

  constructor(secret: string, repositoryId: number | string) {
    if (!secret) throw new Error('StateCodec needs a non-empty secret');
    this.repositoryId = repositoryId;
    this.key = Buffer.from(hkdfSync('sha256', secret, 'pr-quiz', 'pr-quiz quiz-state v1', 32));
  }

  private aad(pr: number): Buffer {
    return Buffer.from(`pr-quiz:v1:${this.repositoryId}#${pr}`);
  }

  seal(pr: number, state: QuizState): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(pr));
    const plaintext = deflateRawSync(Buffer.from(JSON.stringify(state), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
  }

  /** Returns null when the blob was not produced by this key for this pull request, or was tampered with. */
  open(pr: number, blob: string): QuizState | null {
    try {
      const raw = Buffer.from(blob, 'base64url');
      if (raw.length < IV_BYTES + TAG_BYTES + 1) return null;
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(raw.length - TAG_BYTES);
      const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(this.aad(pr));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const state = JSON.parse(inflateRawSync(plaintext).toString('utf8')) as QuizState;
      return state && state.v === 1 && Array.isArray(state.questions) ? state : null;
    } catch {
      return null;
    }
  }
}
