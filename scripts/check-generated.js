const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const generatedFiles = [
  'grammar.json',
  'node-types.json',
  'parser.c',
  'tree_sitter/alloc.h',
  'tree_sitter/array.h',
  'tree_sitter/parser.h',
];

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-sitter-ipython-generated-'));

try {
  const result = spawnSync(
    process.execPath,
    [
      require.resolve('tree-sitter-cli/cli.js'),
      'generate',
      '--output',
      temporaryDirectory,
      path.join(root, 'grammar.js'),
    ],
    { cwd: root, encoding: 'utf8', stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);

  const staleFiles = generatedFiles.filter((file) => {
    const expected = fs.readFileSync(path.join(root, 'src', file));
    const generated = fs.readFileSync(path.join(temporaryDirectory, file));
    return !expected.equals(generated);
  });
  if (staleFiles.length > 0) {
    process.stderr.write(
      `Generated files are stale: ${staleFiles.map((file) => `src/${file}`).join(', ')}\n`,
    );
    process.stderr.write('Run `npm run generate` and commit the resulting files.\n');
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
