const { performance } = require('node:perf_hooks');
const Parser = require('tree-sitter');
const language = require('../bindings/node');

const sizes = process.argv.includes('--large') ? [1024 * 1024, 8 * 1024 * 1024] : [1024 * 1024];
const results = [];
const shapes = {
  'long-line': (size) => 'x'.repeat(size),
  'many-lines': (size) => 'payload\n'.repeat(Math.ceil(size / 8)),
  'hash-rows': (size) => '# x\n'.repeat(Math.ceil(size / 4)),
};

function pointAt(source, index) {
  const prefix = source.slice(0, index);
  const row = prefix.split('\n').length - 1;
  return { row, column: index - prefix.lastIndexOf('\n') - 1 };
}

function measure(size, shape) {
  const body = shapes[shape](size);
  const source = `# %% [raw]\n${body}\n# %% Next\nvalue = 1\n`;
  const parser = new Parser();
  parser.setLanguage(language);
  const before = performance.now();
  const tree = parser.parse(source);
  const coldMs = performance.now() - before;
  validate(tree, source);
  const edits = [];
  for (const fraction of [0, 0.5, 0.99]) {
    let at = Math.floor(body.length * fraction);
    if (shape === 'hash-rows') at = at - (at % 4) + 2;
    const index = '# %% [raw]\n'.length + at;
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
      validate(next, nextSource);
      edits.push({ fraction, kind, durationMs });
    }
  }
  return { size, shape, coldMs, edits, rss: process.memoryUsage().rss };
}
function validate(tree, source) {
  const root = tree.rootNode;
  const cell = root.namedChildren.at(-1);
  if (
    root.hasError ||
    root.endIndex !== source.length ||
    cell?.type !== 'code_cell' ||
    cell.childForFieldName('marker')?.childForFieldName('name')?.text !== 'Next' ||
    cell.childForFieldName('body')?.type !== 'python_cell_body' ||
    cell.childForFieldName('body').text !== 'value = 1\n'
  )
    throw new Error('Parse lost the following code cell');
}

for (const size of sizes) {
  for (const shape of Object.keys(shapes)) results.push(measure(size, shape));
}
process.stdout.write(`${JSON.stringify({ runtime: process.version, results }, null, 2)}\n`);
