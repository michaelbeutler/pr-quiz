// Minimal replacement for @actions/core: inputs, logging, masking, outputs and job summary.
import { appendFileSync } from 'node:fs';
import { EOL } from 'node:os';
import { randomUUID } from 'node:crypto';

export function getInput(name: string): string {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return (process.env[key] ?? '').trim();
}

function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function command(name: string, message: string): void {
  process.stdout.write(`::${name}::${escapeData(message)}${EOL}`);
}

export const log = {
  info(message: string): void {
    process.stdout.write(message + EOL);
  },
  debug(message: string): void {
    command('debug', message);
  },
  warning(message: string): void {
    command('warning', message);
  },
  error(message: string): void {
    command('error', message);
  },
  group<T>(title: string, fn: () => Promise<T>): Promise<T> {
    process.stdout.write(`::group::${escapeData(title)}${EOL}`);
    return fn().finally(() => process.stdout.write(`::endgroup::${EOL}`));
  },
};

export function setSecret(value: string): void {
  if (value) command('add-mask', value);
}

function appendFileCommand(envVar: string, name: string, value: string): boolean {
  const file = process.env[envVar];
  if (!file) return false;
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
  return true;
}

export function setOutput(name: string, value: string): void {
  if (!appendFileCommand('GITHUB_OUTPUT', name, value)) {
    process.stdout.write(`${EOL}::set-output name=${name}::${escapeData(value)}${EOL}`);
  }
}

export function appendSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, markdown + EOL);
}

export function setFailed(message: string): void {
  process.exitCode = 1;
  log.error(message);
}
