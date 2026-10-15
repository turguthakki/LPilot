const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const production = process.argv.includes('--production');

/** @type {esbuild.BuildOptions} */
const baseOptions = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
  external: ['vscode'],
  target: 'node20',
  platform: 'node',
};

async function main() {
  const outdir = path.join(__dirname, 'out');
  fs.mkdirSync(outdir, { recursive: true });

  await esbuild.build({
    ...baseOptions,
    entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
    outfile: path.join(outdir, 'extension.js'),
  });

  await esbuild.build({
    ...baseOptions,
    entryPoints: [path.join(__dirname, 'src', 'test', 'suite', 'runner.ts')],
    outfile: path.join(outdir, 'test', 'suite.js'),
    external: ['vscode', 'mocha'],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
