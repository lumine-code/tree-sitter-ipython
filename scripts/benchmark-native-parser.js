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
  } else if (name === 'code-comments' || name === 'code-comment-run') {
    prefix = 'def work(value):\n    return value + 1\n';
    const row = `# ${'x'.repeat(77)}\n`;
    // Bound ordinary indentation lookahead without changing either parser's
    // input. An unbroken run is retained separately as a baseline pathology.
    const block = `${row.repeat(16)}chunk_value = 1\n`;
    payload =
      name === 'code-comments'
        ? block.repeat(Math.ceil(size / block.length))
        : row.repeat(Math.ceil(size / row.length));
    suffix = '\nresult = work(1)\n';
  } else {
    opaque = true;
    prefix = '# %% [raw]\n';
    if (name === 'opaque-long-line') payload = 'x'.repeat(size);
    else if (name === 'opaque-many-lines')
      payload = `${'x'.repeat(79)}\n`.repeat(Math.ceil(size / 80));
    else if (name === 'opaque-tiny-lines') payload = 'x\n'.repeat(Math.ceil(size / 2));
    else if (name === 'opaque-crlf') payload = 'x\r\n'.repeat(Math.ceil(size / 3));
    else if (name === 'opaque-emoji') payload = '\u{1f600}\r\n'.repeat(Math.ceil(size / 6));
    else if (name === 'opaque-headings') {
      prefix = '# %% [markdown]\n';
      payload = '# x\n'.repeat(Math.ceil(size / 4));
    } else if (name === 'opaque-hash-rows') payload = '#\n'.repeat(Math.ceil(size / 2));
    else if (name === 'opaque-eof') payload = 'x'.repeat(size);
    else payload = `#${' '.repeat(size)}%% Payload`;
    suffix = name === 'opaque-eof' ? '' : '\n# %% Next\nresult = 1\n';
  }
  const source = prefix + payload + suffix;
  const positions = [0, 0.5, 1].map((fraction) => {
    let at =
      name === 'opaque-pathological-prefix'
        ? 1 + Math.floor((size - 1) * fraction)
        : Math.floor((payload.length - 1) * fraction);
    if (name === 'opaque-eof' && fraction === 1) at = payload.length;
    else if (name === 'opaque-emoji') at -= at % 4;
    else if (name !== 'opaque-pathological-prefix') {
      if (fraction === 1) {
        while (at > 0 && payload[at] !== (name === 'opaque-hash-rows' ? '#' : 'x')) at--;
      } else {
        while (at < payload.length && payload[at] !== (name === 'opaque-hash-rows' ? '#' : 'x'))
          at++;
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
  const finalCell = root.namedChild(root.namedChildCount - 1);
  if (item.name !== 'opaque-eof') {
    assert.equal(finalCell.type, 'code_cell', item.name);
    assert.equal(finalCell.childForFieldName('body')?.type, 'python_cell_body', item.name);
  }
  if (item.opaque) {
    assert.equal(
      root.namedChild(0).type,
      item.name === 'opaque-headings' ? 'markdown_cell' : 'raw_cell',
    );
    if (item.name !== 'opaque-eof')
      assert.equal(finalCell.childForFieldName('marker').childForFieldName('name').text, 'Next');
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

// Sample the scaffold at five deterministic windows. Python syntax is opaque
// here, so controls compare source spans and document structure, not Python AST.
function astDigest(tree, source) {
  const root = tree.rootNode;
  const structure = (node) => [
    node.type,
    node.isNamed,
    node.startIndex,
    node.endIndex,
    node.startPosition,
    node.endPosition,
    node.childCount,
    node.namedChildCount,
  ];
  const proof = { root: structure(root), windows: [] };
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const index = Math.min(source.length - 1, Math.floor(source.length * fraction));
    const leaf = root.descendantForIndex(index);
    const window = { fraction, ancestors: [], nodes: [], extraFlags: [] };
    for (let node = leaf; node; node = node.parent) window.ancestors.push(structure(node));
    const container = leaf.parent?.childCount <= 32 ? leaf.parent : leaf;
    const cursor = container.walk();
    for (let count = 0; count < 128; count++) {
      const node = cursor.currentNode;
      window.nodes.push([...structure(node), cursor.currentFieldName]);
      window.extraFlags.push(node.isExtra);
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) break;
      }
      if (cursor.currentNode.id === container.id) break;
    }
    proof.windows.push(window);
  }
  const extraFlags = proof.windows.map((window) => window.extraFlags);
  const visible = {
    ...proof,
    windows: proof.windows.map(({ extraFlags: _extraFlags, ...window }) => window),
  };
  return {
    sha256: digest(JSON.stringify(visible)),
    extraFlags,
    scope:
      'root metadata and five deterministic leaf/ancestor windows; up to 128 descendants per window; type/named/positions/indices/counts/fields; excludes isExtra',
  };
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
      const editIndex =
        position.index === item.source.length && kind !== 'insert'
          ? position.index - 1
          : position.index;
      const codePointLength = item.source.codePointAt(editIndex) > 0xffff ? 2 : 1;
      const oldLength =
        kind === 'insert' ? 0 : editIndex === item.source.length ? 0 : codePointLength;
      const replacement = kind === 'delete' ? '' : 'y';
      const changed =
        item.source.slice(0, editIndex) + replacement + item.source.slice(editIndex + oldLength);
      const startPosition = pointAt(item.source, editIndex);
      const oldEndPosition = pointAt(item.source, editIndex + oldLength);
      const newEndPosition = {
        row: startPosition.row,
        column: startPosition.column + replacement.length,
      };
      const forward = {
        startIndex: editIndex,
        oldEndIndex: editIndex + oldLength,
        newEndIndex: editIndex + replacement.length,
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
        editIndex,
        oldLength,
        replacement,
        values,
        memoryWithPreviousTree,
        memoryAfterRelease: process.memoryUsage(),
        ...summarize(values),
      });
    }
  }
}

const opaqueNames = [
  'opaque-long-line',
  'opaque-many-lines',
  'opaque-tiny-lines',
  'opaque-crlf',
  'opaque-emoji',
  'opaque-headings',
  'opaque-hash-rows',
  'opaque-eof',
  'opaque-pathological-prefix',
];
const names =
  only === 'controls'
    ? ['code-dictionary', 'code-comments']
    : only === 'opaque'
      ? opaqueNames
      : ['code-dictionary', 'code-comments', ...opaqueNames];
fs.writeSync(
  2,
  `phase=setup node=${process.version} fixtures=${names.length} sizes=${sizes.join(',')}\n`,
);
const fixtures = sizes.flatMap((size) => names.map((name) => fixture(name, size)));
for (const item of fixtures) {
  fs.writeSync(2, `phase=proof fixture=${item.name} size=${item.size}\n`);
  const proofs = variants.map((variant) => {
    const parser = new Parser();
    parser.setLanguage(variant.language);
    fs.writeSync(
      2,
      `phase=proof-parse-start variant=${variant.name} fixture=${item.name} size=${item.size}\n`,
    );
    const parseStarted = performance.now();
    let tree = parser.parse(item.source);
    const setupParseMs = performance.now() - parseStarted;
    fs.writeSync(2, `phase=proof-parse-done variant=${variant.name} ms=${setupParseMs}\n`);
    validate(tree, item);
    const proofStarted = performance.now();
    const value = astDigest(tree, item.source);
    const setupProofMs = performance.now() - proofStarted;
    fs.writeSync(2, `phase=proof-done variant=${variant.name} ms=${setupProofMs}\n`);
    releaseTree(tree);
    // eslint-disable-next-line no-useless-assignment -- Release native trees before unmeasured GC.
    tree = null;
    global.gc();
    return { variant: variant.name, ...value, setupParseMs, setupProofMs };
  });
  assert.equal(proofs[0].sha256, proofs[1].sha256, `${item.name} sampled scaffold AST changed`);
  item.astProofs = proofs;
}
for (let series = 1; series <= seriesCount; series++) {
  const order = series % 2 ? variants : [...variants].reverse();
  const corpusOrder = series % 2 ? fixtures : [...fixtures].reverse();
  for (const item of corpusOrder) {
    for (const variant of order) {
      fs.writeSync(
        2,
        `series=${series} variant=${variant.name} fixture=${item.name} size=${item.size}\n`,
      );
      measure(variant, item, series);
      if (options.output)
        fs.writeFileSync(options.output, `${JSON.stringify(snapshot(), null, 2)}\n`);
    }
  }
}
function snapshot() {
  return {
    node: process.version,
    nodeAbi: process.versions.modules,
    platform: process.platform,
    architecture: process.arch,
    parameters: { samples, warmup, series: seriesCount, sizes, only },
    bindings: variants.map(({ name, filename, sha256 }) => ({ name, filename, sha256 })),
    runtimeAddons,
    fixtures: fixtures.map(({ name, size, source, sha256, astProofs, opaque }) => ({
      name,
      size,
      utf16Units: source.length,
      sha256,
      astProofs,
      utf8Bytes: Buffer.byteLength(source),
      opaque,
    })),
    records,
  };
}
const output = snapshot();
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (options.output) fs.writeFileSync(options.output, serialized);
else process.stdout.write(serialized);
