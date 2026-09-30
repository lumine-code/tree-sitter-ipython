const assert = require('node:assert');
const { test } = require('node:test');

const Parser = require('tree-sitter');

test('loads the IPython grammar through the Node-API binding', () => {
  const parser = new Parser();
  const IPython = require('.');

  assert.strictEqual(IPython.name, 'ipython');
  assert.doesNotThrow(() => parser.setLanguage(IPython));
  assert.ok(Array.isArray(IPython.nodeTypeInfo));
});

test('exposes a cell marker level and title separately', () => {
  const parser = new Parser();
  parser.setLanguage(require('.'));

  const marker = parser.parse('# %%% Sekcja\n').rootNode.namedChild(0);
  const markerPrefix = marker.childForFieldName('marker');

  assert.strictEqual(marker.type, 'cell_marker');
  assert.strictEqual(markerPrefix.text, '# %%%');
  assert.strictEqual(markerPrefix.text.match(/%+$/)[0], '%%%');
  assert.strictEqual(marker.childForFieldName('name').text, 'Sekcja');
  assert.strictEqual(marker.childForFieldName('metadata'), null);
});

test('excludes CRLF line endings from comment text and end positions', () => {
  const parser = new Parser();
  parser.setLanguage(require('.'));

  const tree = parser.parse('# first\r\nvalue = 1 # second\r\n');
  const comments = tree.rootNode.descendantsOfType('comment');

  assert.deepStrictEqual(
    comments.map((comment) => comment.text),
    ['# first', '# second'],
  );
  assert.deepStrictEqual(
    comments.map((comment) => [comment.endPosition.row, comment.endPosition.column]),
    [
      [0, 7],
      [1, 18],
    ],
  );
});

test('excludes CRLF line endings from format specifier text and end positions', () => {
  const parser = new Parser();
  parser.setLanguage(require('.'));

  const tree = parser.parse('f"""{x:>10\r\n}"""');
  const formatSpecifier = tree.rootNode.descendantsOfType('format_specifier')[0];

  assert.strictEqual(formatSpecifier.text, ':>10');
  assert.deepStrictEqual(
    [formatSpecifier.endPosition.row, formatSpecifier.endPosition.column],
    [0, 10],
  );
});

function parse(source, oldTree) {
  const parser = new Parser();
  parser.setLanguage(require('.'));
  return { parser, tree: parser.parse(source, oldTree) };
}

test('preserves literal bodies, empty cells, and precise CRLF boundaries', () => {
  const source = '# %% [markdown] Notes\r\n# Heading\r\n**bold**\r\n# %% [raw]\r\n# %% Code';
  const { tree } = parse(source);
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.namedChildren.map((node) => node.type),
    ['markdown_cell', 'raw_cell', 'cell_marker'],
  );
  const markdown = tree.rootNode.namedChild(0);
  assert.strictEqual(markdown.childForFieldName('body').text, '# Heading\r\n**bold**\r\n');
  assert.deepStrictEqual(markdown.childForFieldName('body').startPosition, { row: 1, column: 0 });
  assert.deepStrictEqual(markdown.childForFieldName('body').endPosition, { row: 3, column: 0 });
  assert.strictEqual(tree.rootNode.namedChild(1).childForFieldName('body'), null);
});

test('header trailing whitespace cannot consume the first body line', () => {
  for (const header of ['# %% [raw]', '# %% [markdown]', '%%bash', '%%time']) {
    for (const ending of ['\n', '\r\n']) {
      const { tree } = parse(
        `${header} \t  ${ending}value = 1${ending}# %% Next${ending}after = 2${ending}`,
      );
      assert.strictEqual(tree.rootNode.hasError, false, header);
      const first = tree.rootNode.namedChild(0);
      assert.strictEqual(first.childForFieldName('body').text, `value = 1${ending}`);
      assert.strictEqual(tree.rootNode.namedChildren.at(-1).type, 'assignment');
    }
  }
});

test('classifies exact marker metadata and keeps titles separate', () => {
  const headers = [
    '[markdown]',
    '[md]',
    'markdown',
    'md',
    '[raw]',
    'raw',
    'markdownish',
    '[notes]',
  ];
  const { tree } = parse(headers.map((metadata) => `# %%% ${metadata} Title\n`).join(''));
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.namedChildren.map((node) => node.type),
    [
      'markdown_cell',
      'markdown_cell',
      'markdown_cell',
      'markdown_cell',
      'raw_cell',
      'raw_cell',
      'cell_marker',
      'cell_marker',
    ],
  );
  for (const node of tree.rootNode.namedChildren.slice(0, 6)) {
    const marker = node.childForFieldName('marker');
    assert.strictEqual(marker.childForFieldName('marker').text, '# %%%');
    assert.strictEqual(marker.childForFieldName('name').text, 'Title');
  }
});

test('parses known Python magics and isolates all foreign and unknown bodies', () => {
  for (const name of ['time', 'timeit', 'prun', 'debug', 'capture', 'code_wrap']) {
    const { tree } = parse(`%%${name} argument\nvalue = 1\n# %%\nafter = 2\n`);
    assert.strictEqual(tree.rootNode.hasError, false, name);
    const magic = tree.rootNode.namedChild(0);
    assert.strictEqual(magic.type, 'cell_magic');
    assert.strictEqual(magic.childForFieldName('name').text, name);
    assert.strictEqual(magic.childForFieldName('arguments').text, 'argument');
    assert.strictEqual(magic.childForFieldName('body').type, 'python_cell_body');
    assert.strictEqual(tree.rootNode.namedChild(2).type, 'assignment');
  }
  for (const name of [
    'bash',
    'sh',
    '!',
    'html',
    'HTML',
    'latex',
    'markdown',
    'js',
    'svg',
    'SVG',
    'python',
    'script',
    'writefile',
    'custom',
    'TIME',
  ]) {
    const { tree } = parse(`%%${name}\nanything } <not Python>\n# %%\nafter = 2\n`);
    assert.strictEqual(tree.rootNode.hasError, false, name);
    assert.strictEqual(tree.rootNode.namedChild(0).childForFieldName('body').type, 'cell_body');
    assert.strictEqual(tree.rootNode.namedChild(2).type, 'assignment');
  }
});

test('cell magics only consume the first nonblank line of a code cell', () => {
  assert.strictEqual(parse('\n\n%%bash\necho hello\n').tree.rootNode.hasError, false);
  for (const source of [
    'value = 1\n%%bash\necho hello\n',
    '# comment\n%%bash\necho hello\n',
    'if ready:\n    %%bash\n    echo hello\n',
  ]) {
    assert.strictEqual(parse(source).tree.rootNode.hasError, true, source);
  }
});

test('opaque chunks preserve Unicode and oversized nonmarker prefixes', () => {
  for (const body of [
    'x'.repeat(1024 * 1024),
    `${'x'.repeat(4095)}😀${'λ'.repeat(8192)}`,
    `#${' '.repeat(10000)}payload\n`,
  ]) {
    const { tree } = parse(`# %% [raw]\n${body}\n# %%\nafter = 1\n`);
    assert.strictEqual(tree.rootNode.hasError, false);
    assert.strictEqual(tree.rootNode.namedChild(0).childForFieldName('body').text, `${body}\n`);
    assert.strictEqual(tree.rootNode.namedChild(2).type, 'assignment');
  }
});

test('incremental raw-body edits preserve the next marker and assignment', () => {
  const prefix = '# %% [raw]\n';
  const body = 'x'.repeat(65536);
  let source = `${prefix}${body}\n# %% Next\nafter = 1\n`;
  const { parser, tree } = parse(source);
  const index = prefix.length + 4095;
  tree.edit({
    startIndex: index,
    oldEndIndex: index,
    newEndIndex: index + 1,
    startPosition: { row: 1, column: 4095 },
    oldEndPosition: { row: 1, column: 4095 },
    newEndPosition: { row: 1, column: 4096 },
  });
  source = `${source.slice(0, index)}y${source.slice(index)}`;
  const edited = parser.parse(source, tree);
  assert.strictEqual(edited.rootNode.hasError, false);
  assert.strictEqual(
    edited.rootNode.namedChild(0).childForFieldName('body').text,
    `${body.slice(0, 4095)}y${body.slice(4095)}\n`,
  );
  assert.strictEqual(edited.rootNode.namedChild(1).childForFieldName('name').text, 'Next');
  assert.strictEqual(edited.rootNode.namedChild(2).childForFieldName('left').text, 'after');
});
