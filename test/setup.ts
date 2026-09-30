import { vi } from 'vitest';

// The code under test prints GitHub workflow commands (::add-mask::, ::warning::, ...). Printed from a CI test step
// they would turn into real annotations, or mask test strings like "t" in the rest of the log, so drop them here.
const write = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) =>
  typeof chunk === 'string' && chunk.includes('::') && /^::[a-z-]+/m.test(chunk)
    ? true
    : write(chunk, ...rest)) as typeof process.stdout.write);
