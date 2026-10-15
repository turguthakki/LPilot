const path = require('path');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

const VSCODE_VERSION = process.env.VSCODE_VERSION || '1.141.2';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const vscodeExecutablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(extensionDevelopmentPath, 'out', 'test', 'suite.js'),
    launchArgs: [
      '--disable-workspace-trust',
      '--no-sandbox',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-extensions',
      extensionDevelopmentPath,
    ],
  });
}

main().catch((err) => {
  console.error('Failed to run tests');
  console.error(err);
  process.exit(1);
});
