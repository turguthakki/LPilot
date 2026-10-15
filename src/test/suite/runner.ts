import * as vscode from 'vscode';
import './index';
import { getSetups, getTests } from './registry';

async function withTimeout(fn: () => Promise<void> | void, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => fn())(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Entry point called by VS Code's extension test host.
 * VS Code requires the test module to export `run(root, done)`.
 */
export function run(_root: vscode.WorkspaceFolder[], done: (error: unknown, failures?: number) => void): void {
  void (async () => {
    const tests = getTests();
    const setups = getSetups();
    let failures = 0;
    console.log(`LPilot integration tests: ${tests.length} test(s)`);

    for (const setupFn of setups) {
      try {
        await withTimeout(setupFn, 60_000);
      } catch (err) {
        failures++;
        console.error(`SETUP FAILED: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }

    if (failures === 0) {
      for (const testCase of tests) {
        const started = Date.now();
        try {
          await withTimeout(testCase.fn, testCase.timeoutMs);
          console.log(`ok - ${testCase.title} (${Date.now() - started}ms)`);
        } catch (err) {
          failures++;
          console.error(`FAIL - ${testCase.title}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
    }

    console.log(`LPilot integration tests finished with ${failures} failure(s)`);
    done(failures > 0 ? new Error(`${failures} test(s) failed`) : null, failures);
  })();
}
