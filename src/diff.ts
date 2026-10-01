import { createHash } from 'node:crypto';
import picomatch from 'picomatch';
import type { PullFile } from './github/types.ts';

export interface ReviewableFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  /** Missing for binary files and diffs GitHub considers too large. */
  patch?: string;
  fingerprint: string;
}

export interface ChangeSet {
  /** Changed files that are not ignored (with or without a readable diff). */
  files: ReviewableFile[];
  ignored: string[];
  /** Hash over the changes a quiz can cover: non-ignored files with a readable diff. */
  fingerprint: string;
  /** Hash over every changed file, including ignored and binary ones, so no change goes unnoticed. */
  fullFingerprint: string;
  /** Per-file fingerprints of the files a quiz can cover. */
  fileFingerprints: Record<string, string>;
  /** At least one non-ignored file has a textual diff Claude can read. */
  hasReadableChanges: boolean;
  /** GitHub lists at most 3000 files per pull request. */
  possiblyIncomplete: boolean;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Hunk headers carry line numbers that shift when the base branch moves; they don't change what the PR does. */
function normalizePatch(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('@@'))
    .join('\n');
}

export function fileFingerprint(file: PullFile): string {
  const content = file.patch !== undefined ? normalizePatch(file.patch) : `blob:${file.sha ?? ''}`;
  return sha256(`${file.status}\0${file.previous_filename ?? ''}\0${content}`).slice(0, 16);
}

function hashEntries(entries: Array<[string, string]>): string {
  return sha256(
    entries
      .map(([path, fp]) => `${path}\0${fp}`)
      .sort()
      .join('\n'),
  ).slice(0, 32);
}

export function isReadable(file: ReviewableFile): boolean {
  return !!file.patch && file.patch.trim() !== '';
}

export function buildChangeSet(files: PullFile[], ignoreGlobs: readonly string[]): ChangeSet {
  const isIgnored = picomatch([...ignoreGlobs], { dot: true });
  const reviewable: ReviewableFile[] = [];
  const ignored: string[] = [];
  const everything: Array<[string, string]> = [];
  for (const file of files) {
    if (file.status === 'unchanged') continue;
    const fingerprint = fileFingerprint(file);
    everything.push([file.filename, fingerprint]);
    if (isIgnored(file.filename)) {
      ignored.push(file.filename);
      continue;
    }
    reviewable.push({
      path: file.filename,
      previousPath: file.previous_filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
      fingerprint,
    });
  }
  const quizzable = reviewable.filter(isReadable).map((f): [string, string] => [f.path, f.fingerprint]);
  return {
    files: reviewable,
    ignored,
    fingerprint: hashEntries(quizzable),
    fullFingerprint: hashEntries(everything),
    fileFingerprints: Object.fromEntries(quizzable),
    hasReadableChanges: quizzable.length > 0,
    possiblyIncomplete: files.length >= 3000,
  };
}

/** Quizzable paths whose change differs from an earlier snapshot (changed, new, or removed from the PR). */
export function changedSince(previous: Record<string, string> | undefined, current: ChangeSet): string[] | null {
  if (!previous) return null;
  const changed = Object.entries(current.fileFingerprints)
    .filter(([path, fp]) => previous[path] !== fp)
    .map(([path]) => path);
  const dropped = Object.keys(previous).filter((path) => !(path in current.fileFingerprints));
  return [...changed, ...dropped];
}

// --- Prompt context -------------------------------------------------------------------------------------------

export interface PullRequestInfo {
  title: string;
  body: string | null;
  author: string;
  baseRef: string;
  headRef: string;
}

export interface ContextOptions {
  maxChars: number;
  /** Restrict the diff to these paths (follow-up quizzes after new commits). */
  onlyPaths?: ReadonlySet<string>;
  /** Full post-change file contents to include for context. */
  fileContents?: ReadonlyMap<string, string>;
}

export interface RenderedContext {
  text: string;
  includedPaths: string[];
  truncatedPaths: string[];
  omittedPaths: string[];
}

/** Our wrapper tags must not be closable from inside untrusted content. */
function neutralize(text: string): string {
  return text.replace(/<(\/?)pq_/gi, '<$1pq​_');
}

const STATUS_LETTER: Record<string, string> = {
  added: 'A',
  removed: 'D',
  modified: 'M',
  renamed: 'R',
  copied: 'C',
  changed: 'M',
};

function describe(file: ReviewableFile): string {
  const path = file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ${file.path}` : file.path;
  return `${STATUS_LETTER[file.status] ?? '?'} ${path} (+${file.additions} -${file.deletions})`;
}

export function renderPullRequestContext(pr: PullRequestInfo, changes: ChangeSet, options: ContextOptions): RenderedContext {
  const scoped = options.onlyPaths ? changes.files.filter((f) => options.onlyPaths!.has(f.path)) : changes.files;
  const diffBudget = Math.floor(options.maxChars * (options.fileContents?.size ? 0.7 : 1));
  const perFileCap = Math.max(4_000, Math.floor(diffBudget / 3));

  const includedPaths: string[] = [];
  const truncatedPaths: string[] = [];
  const omittedPaths: string[] = [];
  const diffParts: string[] = [];
  let used = 0;
  for (const file of scoped) {
    if (!file.patch) {
      diffParts.push(`### ${describe(file)}\n(binary file or diff too large to display)`);
      continue;
    }
    if (used >= diffBudget) {
      omittedPaths.push(file.path);
      continue;
    }
    let patch = file.patch;
    const room = Math.min(perFileCap, diffBudget - used);
    if (patch.length > room) {
      patch = `${patch.slice(0, room)}\n… (diff truncated: ${patch.length - room} more characters not shown)`;
      truncatedPaths.push(file.path);
    }
    used += patch.length;
    includedPaths.push(file.path);
    diffParts.push(`### ${describe(file)}\n${patch}`);
  }

  const lines: string[] = [
    '<pq_pull_request>',
    `<pq_title>${neutralize(pr.title.slice(0, 300))}</pq_title>`,
    `<pq_author>${neutralize(pr.author)}</pq_author>`,
    `<pq_branches>${neutralize(pr.headRef)} → ${neutralize(pr.baseRef)}</pq_branches>`,
    '<pq_description>',
    neutralize((pr.body ?? '').trim().slice(0, 10_000)) || '(no description)',
    '</pq_description>',
    '<pq_changed_files>',
    ...changes.files.map((f) => neutralize(describe(f))),
    '</pq_changed_files>',
  ];
  if (changes.ignored.length) {
    lines.push(`<pq_ignored_files>${neutralize(changes.ignored.join(', '))}</pq_ignored_files>`);
  }
  if (options.onlyPaths) {
    lines.push(
      '<pq_scope>The person taking this quiz already passed a quiz on an earlier version of this pull request. ' +
        'The diff below only contains the files that changed since then.</pq_scope>',
    );
  }
  lines.push('<pq_diff>', neutralize(diffParts.join('\n\n')), '</pq_diff>');
  if (omittedPaths.length) {
    lines.push(`<pq_omitted>Diff not shown (size budget): ${neutralize(omittedPaths.join(', '))}</pq_omitted>`);
  }
  for (const [path, content] of options.fileContents ?? []) {
    lines.push(`<pq_file path="${neutralize(path)}">`, neutralize(content), '</pq_file>');
  }
  lines.push('</pq_pull_request>');
  return { text: lines.join('\n'), includedPaths, truncatedPaths, omittedPaths };
}

/** Modified files worth sending in full for context, biggest changes first. */
export function contextCandidates(changes: ChangeSet, onlyPaths?: ReadonlySet<string>): ReviewableFile[] {
  return changes.files
    .filter((f) => (f.status === 'modified' || f.status === 'renamed' || f.status === 'changed') && !!f.patch)
    .filter((f) => !onlyPaths || onlyPaths.has(f.path))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
}
