const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Parser = require('tree-sitter');

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')),
);
const samples = Number(options.samples || 30);
const warmup = Number(options.warmup || 5);
const seriesCount = Number(options.series || 3);
const sizes = (options.sizes || '1048576,8388608').split(',').map(Number);
const only = options.only || 'all';
if (!options.baseline || !options.candidate)
  throw new Error('Pass --baseline=<binding.node> and --candidate=<binding.node>');
if (!global.gc)
  throw new Error('Run Node with --expose-gc for collection outside measured samples');
for (const value of [samples, warmup, seriesCount, ...sizes]) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error('Counts and sizes must be positive integers');
}

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const variants = ['baseline', 'candidate'].map((name) => {
  const filename = fs.realpathSync(path.resolve(options[name]));
  const binding = require(filename);
  return {
    name,
    filename,
    sha256: digest(fs.readFileSync(filename)),
    language: { language: binding.language },
  };
});
const runtimeAddons = Object.keys(require.cache)
  .filter(
    (filename) =>
      filename.endsWith('.node') && !variants.some((variant) => variant.filename === filename),
  )
  .map((filename) => ({ filename, sha256: digest(fs.readFileSync(filename)) }));

function fixture(name, size) {
  let prefix;
  let payload;
  let suffix;
  let opaque = false;
  if (name === 'code-dictionary') {
    prefix = 'values = {\n';
    const row = `  "value": "${'x'.repeat(64)}",\n`;
    payload = row.repeat(Math.ceil(size / row.length));
    suffix = '}\nresult = len(values)\n';
  } else if (name === 'code-comments') {
    prefix = 'def work(value):\n    return value + 1\n';
    const row = `# ${'x'.repeat(77)}\n`;
    payload = row.repeat(Math.ceil(size / row.length));
    suffix = '\nresult = work(1)\n';
  } else {
    opaque = true;
    prefix = '# %% [raw]\n';
    if (name === 'opaque-long-line') payload = 'x'.repeat(size);
    else if (name === 'opaque-many-lines')
      payload = `${'x'.repeat(79)}\n`.repeat(Math.ceil(size / 80));
    else payload = `#${' '.repeat(size)}%% Payload`;
    suffix = '\n# %% Next\nresult = 1\n';
  }
  const source = prefix + payload + suffix;
  const positions = [0, 0.5, 1].map((fraction) => {
    let at =
      name === 'opaque-pathological-prefix'
        ? 1 + Math.floor((size - 1) * fraction)
        : Math.floor((payload.length - 1) * fraction);
    if (name !== 'opaque-pathological-prefix') {
      if (fraction === 1) {
        while (at > 0 && payload[at] !== 'x') at--;
      } else {
        while (at < payload.length && payload[at] !== 'x') at++;
      }
    }
    return { fraction, index: prefix.length + at };
  });
  return { name, size, source, opaque, positions, sha256: digest(source) };
}

function pointAt(source, index) {
  const before = source.slice(0, index);
  return { row: before.split('\n').length - 1, column: index - before.lastIndexOf('\n') - 1 };
}

function validate(tree, item) {
  const root = tree.rootNode;
  assert.equal(root.hasError, false, item.name);
  assert.equal(root.namedChild(root.namedChildCount - 1).type, 'assignment', item.name);
  if (item.opaque) {
    assert.equal(root.namedChild(0).type, 'raw_cell');
    assert.equal(root.namedChild(1).childForFieldName('name').text, 'Next');
  }
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    samples: values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}

// Cursor scalar access avoids materializing either a giant AST string or an
// array of SyntaxNode wrappers. Proof traversal happens once, before timing.
function astDigest(tree) {
  const hash = crypto.createHash('sha256');
  const cursor = tree.walk();
  for (;;) {
    hash.update(
      JSON.stringify([
        cursor.nodeType,
        cursor.nodeIsNamed,
        cursor.startIndex,
        cursor.endIndex,
        cursor.currentFieldName,
        cursor.currentDepth,
      ]),
    );
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) return hash.digest('hex');
    }
  }
}

function releaseTree(tree) {
  // web-tree-sitter has delete(); the native peer in this matrix is reclaimed
  // by clearing the JS reference and collecting outside the measured parse.
  tree?.delete?.();
}

const records = [];
function measure(variant, item, series) {
  const parser = new Parser();
  parser.setLanguage(variant.language);
  global.gc();
  const memoryBefore = process.memoryUsage();
  const cold = [];
  for (let sample = -warmup; sample < samples; sample++) {
    global.gc();
    const started = performance.now();
    let tree = parser.parse(item.source);
    const duration = performance.now() - started;
    validate(tree, item);
    if (sample >= 0) cold.push(duration);
    releaseTree(tree);
    // eslint-disable-next-line no-useless-assignment -- Release native trees before unmeasured GC.
    tree = null;
  }
  global.gc();
  records.push({
    variant: variant.name,
    fixture: item.name,
    size: item.size,
    series,
    operation: 'cold',
    values: cold,
    memoryBefore,
    memoryAfterRelease: process.memoryUsage(),
    ...summarize(cold),
  });
  for (const position of item.positions) {
    for (const kind of ['replace', 'insert', 'delete']) {
      const oldLength = kind === 'insert' ? 0 : 1;
      const replacement = kind === 'delete' ? '' : 'y';
      const changed =
        item.source.slice(0, position.index) +
        replacement +
        item.source.slice(position.index + oldLength);
      const startPosition = pointAt(item.source, position.index);
      const oldEndPosition = pointAt(item.source, position.index + oldLength);
      const newEndPosition = {
        row: startPosition.row,
        column: startPosition.column + replacement.length,
      };
      const forward = {
        startIndex: position.index,
        oldEndIndex: position.index + oldLength,
        newEndIndex: position.index + replacement.length,
        startPosition,
        oldEndPosition,
        newEndPosition,
      };
      const reverse = {
        ...forward,
        oldEndIndex: forward.newEndIndex,
        newEndIndex: forward.oldEndIndex,
        oldEndPosition: newEndPosition,
        newEndPosition: oldEndPosition,
      };
      let tree = parser.parse(item.source);
      const memoryWithPreviousTree = process.memoryUsage();
      const values = [];
      for (let sample = -warmup; sample < samples; sample++) {
        global.gc();
        tree.edit(forward);
        const started = performance.now();
        let next = parser.parse(changed, tree);
        const duration = performance.now() - started;
        validate(next, item);
        if (sample >= 0) values.push(duration);
        releaseTree(tree);
        // eslint-disable-next-line no-useless-assignment -- Release native trees before unmeasured GC.
        tree = null;
        next.edit(reverse);
        tree = parser.parse(item.source, next);
        releaseTree(next);
        // eslint-disable-next-line no-useless-assignment -- Release native trees before unmeasured GC.
        next = null;
      }
      releaseTree(tree);
      // eslint-disable-next-line no-useless-assignment -- Release native trees before unmeasured GC.
      tree = null;
      global.gc();
      records.push({
        variant: variant.name,
        fixture: item.name,
        size: item.size,
        series,
        operation: kind,
        fraction: position.fraction,
        values,
        memoryWithPreviousTree,
        memoryAfterRelease: process.memoryUsage(),
        ...summarize(values),
      });
    }
  }
}

const names =
  only === 'controls'
    ? ['code-dictionary', 'code-comments']
    : only === 'opaque'
      ? ['opaque-long-line', 'opaque-many-lines', 'opaque-pathological-prefix']
      : [
          'code-dictionary',
          'code-comments',
          'opaque-long-line',
          'opaque-many-lines',
          'opaque-pathological-prefix',
        ];
const fixtures = sizes.flatMap((size) => names.map((name) => fixture(name, size)));
for (const item of fixtures.filter((item) => !item.opaque)) {
  const hashes = variants.map((variant) => {
    const parser = new Parser();
    parser.setLanguage(variant.language);
    let tree = parser.parse(item.source);
    const value = astDigest(tree);
    releaseTree(tree);
    // eslint-disable-next-line no-useless-assignment -- Release native trees before unmeasured GC.
    tree = null;
    global.gc();
    return value;
  });
  assert.equal(hashes[0], hashes[1], `${item.name} AST changed`);
  item.astSha256 = hashes[0];
}
for (let series = 1; series <= seriesCount; series++) {
  const order = series % 2 ? variants : [...variants].reverse();
  const corpusOrder = series % 2 ? fixtures : [...fixtures].reverse();
  for (const item of corpusOrder) {
    for (const variant of item.opaque
      ? variants.filter((entry) => entry.name === 'candidate')
      : order) {
      process.stderr.write(
        `series=${series} variant=${variant.name} fixture=${item.name} size=${item.size}\n`,
      );
      measure(variant, item, series);
    }
  }
}
const output = {
  node: process.version,
  nodeAbi: process.versions.modules,
  platform: process.platform,
  architecture: process.arch,
  parameters: { samples, warmup, series: seriesCount, sizes, only },
  bindings: variants.map(({ name, filename, sha256 }) => ({ name, filename, sha256 })),
  runtimeAddons,
  fixtures: fixtures.map(({ name, size, source, sha256, astSha256, opaque }) => ({
    name,
    size,
    utf16Units: source.length,
    sha256,
    astSha256,
    opaque,
  })),
  records,
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (options.output) fs.writeFileSync(options.output, serialized);
else process.stdout.write(serialized);
