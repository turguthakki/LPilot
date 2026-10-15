export interface TestCase {
  title: string;
  fn: () => Promise<void> | void;
  timeoutMs: number;
}

const tests: TestCase[] = [];
const setups: Array<() => Promise<void> | void> = [];

/** Registers a test (mocha-compatible shape, flattened). */
export function test(title: string, fn: () => Promise<void> | void): void {
  tests.push({ title, fn, timeoutMs: 30_000 });
}

/** Registers a test with a custom timeout. */
export function testWithTimeout(title: string, timeoutMs: number, fn: () => Promise<void> | void): void {
  tests.push({ title, fn, timeoutMs });
}

/** Groups are flattened; the callback runs immediately. */
export function suite(_title: string, fn: () => void): void {
  fn();
}

/** Runs once before all tests of the run. */
export function setup(fn: () => Promise<void> | void): void {
  setups.push(fn);
}

export function getTests(): readonly TestCase[] {
  return tests;
}

export function getSetups(): readonly Array<() => Promise<void> | void> {
  return setups;
}
