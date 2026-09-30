const { performance } = require('node:perf_hooks');
const Parser = require('tree-sitter');
const language = require('../bindings/node');

const sizes = process.argv.includes('--large') ? [1024 * 1024, 8 * 1024 * 1024] : [1024 * 1024];
const results = [];

function pointAt(source, index) {
  const prefix = source.slice(0, index);
  const row = prefix.split('\n').length - 1;
  return { row, column: index - prefix.lastIndexOf('\n') - 1 };
}

function measure(size, shape) {
  const body = shape === 'long-line' ? 'x'.repeat(size) : 'payload\n'.repeat(Math.ceil(size / 8));
  const source = `# %% [raw]\n${body}\n# %% Next\nvalue = 1\n`;
  const parser = new Parser();
  parser.setLanguage(language);
  const before = performance.now();
  const tree = parser.parse(source);
  const coldMs = performance.now() - before;
  if (tree.rootNode.hasError) throw new Error('Cold parse failed');
  const edits = [];
  for (const fraction of [0, 0.5, 0.99]) {
    const index = '# %% [raw]\n'.length + Math.floor(body.length * fraction);
    for (const kind of ['replace', 'insert', 'delete']) {
      const oldLength = kind === 'insert' ? 0 : 1;
      const replacement = kind === 'delete' ? '' : 'y';
      const edited = parser.parse(source);
      const startPosition = pointAt(source, index);
      edited.edit({
        startIndex: index,
        oldEndIndex: index + oldLength,
        newEndIndex: index + replacement.length,
        startPosition,
        oldEndPosition: pointAt(source, index + oldLength),
        newEndPosition: {
          row: startPosition.row,
          column: startPosition.column + replacement.length,
        },
      });
      const nextSource = source.slice(0, index) + replacement + source.slice(index + oldLength);
      const started = performance.now();
      const next = parser.parse(nextSource, edited);
      const durationMs = performance.now() - started;
      if (next.rootNode.hasError || next.rootNode.namedChildren.at(-1).type !== 'assignment') {
        throw new Error('Incremental parse lost the following code cell');
      }
      edits.push({ fraction, kind, durationMs });
    }
  }
  return { size, shape, coldMs, edits, rss: process.memoryUsage().rss };
}

for (const size of sizes) {
  for (const shape of ['long-line', 'many-lines']) results.push(measure(size, shape));
}
process.stdout.write(`${JSON.stringify({ runtime: process.version, results }, null, 2)}\n`);
