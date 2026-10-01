const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const Parser = require('tree-sitter');
const IPython = require('.');
function parse(source, parser = new Parser(), oldTree) {
  parser.setLanguage(IPython);
  const tree = parser.parse(source, oldTree);
  assert.equal(tree.rootNode.endIndex, source.length, 'The scaffold consumes the complete source.');
  assert.equal(tree.rootNode.hasError, false);
  return { parser, tree };
}
function nodes(tree, type) {
  return tree.rootNode.descendantsOfType(type);
}
function markerNames(tree) {
  return nodes(tree, 'cell_marker').map((node) => node.childForFieldName('name')?.text ?? null);
}
test('loads scaffold metadata without a forked Python AST', () => {
  const parser = new Parser();
  assert.equal(IPython.name, 'ipython');
  assert.doesNotThrow(() => parser.setLanguage(IPython));
  const named = IPython.nodeTypeInfo.filter((item) => item.named).map((item) => item.type);
  assert.ok(named.includes('code_cell') && named.includes('python_cell_body'));
  for (const type of ['assignment', 'function_definition', 'class_definition', 'integer', 'string'])
    assert.equal(named.includes(type), false);
});
test('delegates ordinary and invalid Python to opaque bodies', () => {
  for (const source of [
    'value = 1\n',
    'def work():\n    return [1, 2]\n',
    'value =\n',
    '??? bad Python ???\n',
  ]) {
    const { tree } = parse(source);
    assert.equal(tree.rootNode.namedChildCount, 1);
    assert.equal(tree.rootNode.namedChild(0).type, 'code_cell');
    assert.equal(tree.rootNode.namedChild(0).childForFieldName('marker'), null);
    assert.equal(tree.rootNode.namedChild(0).childForFieldName('body').type, 'python_cell_body');
  }
});
test('preserves explicit marker fields, literal types and code titles', () => {
  const source =
    'before=1\r\n# %%% [markdown] Notes\r\n# Heading\r\n# %% [raw] Data\r\nraw <bytes>\r\n# %% [code] Code\r\nafter=2\r\n# %% markdown\r\nlast=3\r\n';
  const { tree } = parse(source);
  assert.deepEqual(
    tree.rootNode.namedChildren.map((node) => node.type),
    ['code_cell', 'markdown_cell', 'raw_cell', 'code_cell', 'code_cell'],
  );
  assert.deepEqual(markerNames(tree), ['Notes', 'Data', 'Code', 'markdown']);
  assert.deepEqual(
    nodes(tree, 'cell_marker').map((node) => node.childForFieldName('metadata')?.text ?? null),
    ['[markdown]', '[raw]', '[code]', null],
  );
  assert.equal(nodes(tree, 'cell_marker')[0].childForFieldName('marker').text, '# %%%');
  assert.equal(nodes(tree, 'cell_body')[0].text, '# Heading\r\n');
  assert.equal(nodes(tree, 'cell_body')[1].text, 'raw <bytes>\r\n');
});
test('keeps empty and EOF cells without inventing body bytes', () => {
  const { tree } = parse('# %% [raw]\n# %% [markdown]\n# %% [code]');
  assert.deepEqual(
    tree.rootNode.namedChildren.map((node) => node.type),
    ['raw_cell', 'markdown_cell', 'code_cell'],
  );
  for (const node of tree.rootNode.namedChildren)
    assert.equal(node.childForFieldName('body'), null);
  assert.equal(parse('').tree.rootNode.namedChildCount, 0);
});
test('preserves legacy navigation annotations and full flags as marker titles', () => {
  const source =
    '#%%$# Parent\n#%%$$#\n#%%$$p!_<;# Full  title\n#$$p# Ordinary\nx=1 #$$v# Inline\n';
  const { tree } = parse(source);
  assert.deepEqual(markerNames(tree), ['$# Parent', '$$#', '$$p!_<;# Full  title']);
  const body = tree.rootNode.namedChildren.at(-1).childForFieldName('body');
  assert.equal(body.text, '#$$p# Ordinary\nx=1 #$$v# Inline\n');
});
test('continues unlimited marker prefixes, hierarchy and header whitespace', () => {
  const gap = ' '.repeat(10000),
    hierarchy = '%'.repeat(10000);
  const source =
    '#' + gap + hierarchy + gap + '[raw]' + gap + 'Long  title' + gap + '\r\npayload\n';
  const { tree } = parse(source);
  const marker = nodes(tree, 'cell_marker')[0];
  assert.equal(marker.childForFieldName('marker').text, '#' + gap + hierarchy);
  assert.equal(marker.childForFieldName('metadata').text, '[raw]');
  assert.equal(marker.childForFieldName('name').text, 'Long  title');
  assert.equal(nodes(tree, 'cell_body')[0].text, 'payload\n');
});
test('keeps bare md, markdown and raw spellings as ordinary code titles', () => {
  const { tree } = parse('# %% md\nx=1\n# %% markdown\ny=2\n# %% raw\nz=3\n');
  assert.deepEqual(
    tree.rootNode.namedChildren.map((node) => node.type),
    ['code_cell', 'code_cell', 'code_cell'],
  );
  assert.deepEqual(markerNames(tree), ['md', 'markdown', 'raw']);
});
test('shares one public Python body type across prelude, wrappers and interpreters', () => {
  const source = 'x=1\n# %%\n%%time -q\nx=2\n# %%\n%%python3 -u\nx=3\n# %%\n%%pypy\nx=4\n';
  const { tree } = parse(source);
  assert.equal(nodes(tree, 'python_cell_body').length, 4);
  assert.deepEqual(
    nodes(tree, 'cell_magic').map((node) => node.childForFieldName('name').text),
    ['time', 'python3', 'pypy'],
  );
  for (const node of nodes(tree, 'cell_magic'))
    assert.equal(node.childForFieldName('body').type, 'python_cell_body');
});
test('keeps foreign and unknown cell magic headers and literal bodies', () => {
  const source =
    '%%bash -e\nprintf "# %% fake"\n# %%\n%%custom option\nopaque <body>\n# %%\n%%!\necho done';
  const { tree } = parse(source);
  assert.deepEqual(
    nodes(tree, 'cell_magic').map((node) => node.childForFieldName('name').text),
    ['bash', 'custom', '!'],
  );
  assert.deepEqual(
    nodes(tree, 'cell_magic').map((node) => node.childForFieldName('body').type),
    ['cell_body', 'cell_body', 'cell_body'],
  );
  assert.deepEqual(
    nodes(tree, 'cell_magic').map((node) => node.childForFieldName('arguments')?.text ?? null),
    ['-e', 'option', null],
  );
});
test('cell magic eligibility survives blank lines but ends after code or comments', () => {
  assert.equal(nodes(parse('\n \n%%bash\necho yes\n').tree, 'cell_magic').length, 1);
  for (const first of ['x=1', '# ordinary comment', '!echo first']) {
    const { tree } = parse(first + '\n%%bash\necho later\n');
    assert.equal(nodes(tree, 'cell_magic').length, 0);
  }
});
test('preserves exact statement, suffix-help and assignment RHS spans', () => {
  const source =
    'if ready: %pwd\n    !echo hello\r\n?name\r\nvalue?\r\nobj.method??\r\nx = %pwd\r\ny: str = !echo result\r\n';
  const { tree } = parse(source);
  assert.deepEqual(
    nodes(tree, 'magic_statement').map((node) => node.text),
    ['%pwd'],
  );
  assert.deepEqual(
    nodes(tree, 'shell_statement').map((node) => node.text),
    ['!echo hello'],
  );
  assert.deepEqual(
    nodes(tree, 'help_statement').map((node) => node.text),
    ['?name', 'value?', 'obj.method??'],
  );
  assert.deepEqual(
    nodes(tree, 'magic_expression').map((node) => node.text),
    ['%pwd'],
  );
  assert.deepEqual(
    nodes(tree, 'shell_expression').map((node) => node.text),
    ['!echo result'],
  );
});
test('bounded suffix help includes giant names without retrospective lookahead', () => {
  const name = 'identifier'.repeat(2000);
  const { tree } = parse(name + '??\n# %% Next\nx=1\n');
  assert.equal(nodes(tree, 'help_statement')[0].text, name + '??');
  assert.deepEqual(markerNames(tree), ['Next']);
});
test('does not turn Python operators or quoted text into IPython commands', () => {
  const source =
    'x = 4 % 2\nassert x != 1\ntext = "%pwd !echo value?"\nf = f"{x!r}"\ndata = {"a": 1}\n';
  const { tree } = parse(source);
  for (const type of [
    'magic_statement',
    'shell_statement',
    'help_statement',
    'magic_expression',
    'shell_expression',
  ])
    assert.equal(nodes(tree, type).length, 0);
});
test('recognizes markers only outside strings, brackets and real continuation', () => {
  const source =
    "text = '''\n# %% [raw] String\n'''\nvalues = (\n# %% [raw] Bracket\n1)\nx = 1\\\n# %% [raw] Continued\n# %% [raw] Actual\npayload\n";
  const { tree } = parse(source);
  assert.deepEqual(markerNames(tree), ['Actual']);
  assert.equal(nodes(tree, 'raw_cell').length, 1);
});
test('tracks raw strings, f-string fields and modern same-quote nested strings', () => {
  const source = 'text = rf"""{f"{1}"}\n# %% [raw] String\n"""\n# %% [code] Actual\nx=1\n';
  const { tree } = parse(source);
  assert.deepEqual(markerNames(tree), ['Actual']);
});
test('reserved boundaries recover after incomplete Python assignments', () => {
  const { tree } = parse(
    'value =\n# %% [markdown] Notes\n# Heading\n# %% [raw]\nraw bytes\n# %% [code]\ngood=1\n',
  );
  assert.deepEqual(
    tree.rootNode.namedChildren.map((node) => node.type),
    ['code_cell', 'markdown_cell', 'raw_cell', 'code_cell'],
  );
});
test('keeps quoted boundary state correct at chunk ends and incrementally', () => {
  const prefix = 'value = ' + ' '.repeat(4085);
  const source = prefix + '"""\n# %% [raw] Inside\n"""\n# %% Actual\nx=1\n';
  const { parser, tree } = parse(source);
  assert.deepEqual(markerNames(tree), ['Actual']);
  const position = source.indexOf('x=1') + 2;
  tree.edit({
    startIndex: position,
    oldEndIndex: position + 1,
    newEndIndex: position + 1,
    startPosition: { row: 4, column: 2 },
    oldEndPosition: { row: 4, column: 3 },
    newEndPosition: { row: 4, column: 3 },
  });
  const updated = source.slice(0, position) + '2' + source.slice(position + 1);
  const incremental = parse(updated, parser, tree).tree;
  assert.deepEqual(markerNames(incremental), ['Actual']);
  assert.equal(incremental.rootNode.toString(), parse(updated).tree.rootNode.toString());
});
test('keeps large opaque bodies compact across tiny lines, CRLF and Unicode', () => {
  for (const body of ['x'.repeat(1048576), 'x\n'.repeat(524288), '😀\r\n'.repeat(65536)]) {
    const { tree } = parse('# %% [raw]\n' + body + '\n# %% End\nx=1\n');
    assert.equal(nodes(tree, 'cell_body').length, 1);
    assert.equal(nodes(tree, 'cell_body')[0].namedChildCount, 0);
    assert.deepEqual(markerNames(tree), [null, 'End']);
  }
});
test('compiles the scaffold queries without Python node types', () => {
  for (const name of ['highlights.scm', 'tags.scm']) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'queries', name), 'utf8');
    assert.doesNotThrow(() => new Parser.Query(IPython, source));
  }
});

test('incremental code edits reuse suffix cells and agree with a fresh scaffold', () => {
  const source = Array.from(
    { length: 100 },
    (_, index) => '# %% Code ' + index + '\nvalue_' + index + '=1\n',
  ).join('');
  const { parser, tree } = parse(source);
  const offset = source.indexOf('=1') + 1;
  tree.edit({
    startIndex: offset,
    oldEndIndex: offset + 1,
    newEndIndex: offset + 1,
    startPosition: { row: 1, column: 8 },
    oldEndPosition: { row: 1, column: 9 },
    newEndPosition: { row: 1, column: 9 },
  });
  let reused = 0;
  parser.setLogger((message) => {
    if (message === 'reuse_node') reused++;
  });
  const updated = source.slice(0, offset) + '2' + source.slice(offset + 1);
  const incremental = parse(updated, parser, tree).tree;
  parser.setLogger(null);
  assert.ok(reused > 50, 'Suffix cells remain reusable after an ordinary code edit.');
  assert.equal(incremental.rootNode.toString(), parse(updated).tree.rootNode.toString());
});

test('one large Python body uses multi-row chunks and reuses its untouched suffix', (context) => {
  const block = ('# ' + 'x'.repeat(77) + '\n').repeat(16) + 'value = 1\n';
  const source = block.repeat(Math.ceil(1048576 / block.length)) + 'last_value = 1\n';
  const parser = new Parser();
  parser.setLanguage(IPython);
  let chunks = 0;
  parser.setLogger((message, data) => {
    if (message === 'lexed_lookahead' && data.sym === '_python_chunk') chunks++;
  });
  const tree = parse(source, parser).tree;
  parser.setLogger(null);
  assert.equal(tree.rootNode.namedChildCount, 1);
  assert.equal(nodes(tree, 'python_cell_body').length, 1);
  assert.ok(chunks < 512, 'Ordinary comment rows do not create per-line scaffold tokens.');
  const offset = source.indexOf('value = 1') + 8;
  tree.edit({
    startIndex: offset,
    oldEndIndex: offset + 1,
    newEndIndex: offset + 1,
    startPosition: { row: 16, column: 8 },
    oldEndPosition: { row: 16, column: 9 },
    newEndPosition: { row: 16, column: 9 },
  });
  let reused = 0,
    lexed = 0;
  parser.setLogger((message) => {
    if (message === 'reuse_node') reused++;
    if (message === 'lexed_lookahead') lexed++;
  });
  const updated = source.slice(0, offset) + '2' + source.slice(offset + 1);
  const incremental = parse(updated, parser, tree).tree;
  parser.setLogger(null);
  assert.ok(reused > 5, 'The large body reuses internal repeat subtrees.');
  assert.ok(lexed < 32, 'An early ordinary edit does not re-lex the whole body.');
  assert.equal(incremental.rootNode.toString(), parse(updated).tree.rootNode.toString());
  context.diagnostic(JSON.stringify({ bytes: source.length, pythonChunks: chunks, reused, lexed }));
});
