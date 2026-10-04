const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const Parser = require('tree-sitter');
const IPython = require('.');
test('external scanner state is canonical and hash tokens respect valid symbols', () => {
  const executable = path.resolve(
    __dirname,
    '../../build/Release/scanner_state_test' + (process.platform === 'win32' ? '.exe' : ''),
  );
  require('node:child_process').execFileSync(executable);
});
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
test('preserves every compact navigation flag family, nameless headers and CRLF field spans', () => {
  const titles = [
    null,
    '$#',
    '$$p#',
    '$$s*_<;# String',
    '$$v+<;_# Variable',
    '$$1-;_<# First',
    '$$P!# Uppercase',
    '?_<;# (2, "Named")',
    '$# [markdown] stays a title',
  ];
  const source = titles.map((title) => '#%%' + (title ?? '') + '\r\n').join('') + '#%%$$p#';
  const { tree } = parse(source);
  assert.deepEqual(markerNames(tree), [...titles, '$$p#']);
  const markers = nodes(tree, 'cell_marker');
  for (let index = 0; index < markers.length; ++index) {
    const marker = markers[index],
      prefix = marker.childForFieldName('marker');
    assert.equal(prefix.text, '#%%');
    assert.deepEqual(prefix.startPosition, { row: index, column: 0 });
    assert.deepEqual(prefix.endPosition, { row: index, column: 3 });
    assert.equal(marker.childForFieldName('metadata'), null);
    const name = marker.childForFieldName('name');
    if (name) {
      assert.deepEqual(name.startPosition, { row: index, column: 3 });
      assert.equal(name.text.includes('\r'), false);
    }
  }
  assert.ok(tree.rootNode.namedChildren.every((cell) => cell.type === 'code_cell'));
});
test('keeps indented and code-prefixed navigation annotations inside Python bodies', () => {
  const source = '#%% Root\n    #%%$$p# Indented\ndef work(): #%%$p# Inline\n    pass\n';
  const { tree } = parse(source);
  assert.deepEqual(markerNames(tree), ['Root']);
  const body = tree.rootNode.namedChild(0).childForFieldName('body');
  assert.equal(body.text, '    #%%$$p# Indented\ndef work(): #%%$p# Inline\n    pass\n');
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

test('separates Python line magic names, options and executable statements', () => {
  const cases = [
    ['%timeit prs.spt(9)', 'timeit', null, 'prs.spt(9)'],
    [
      '%timeit -n100 -r 3 -p2 -v0.1 -tcqo factory()',
      'timeit',
      '-n100 -r 3 -p2 -v0.1 -tcqo ',
      'factory()',
    ],
    ['%timeit -qr3 factory()', 'timeit', '-qr3 ', 'factory()'],
    ['%timeit -- -value', 'timeit', '-- ', '-value'],
    ['%timeit print("-q", 1)', 'timeit', null, 'print("-q", 1)'],
    ['%time --no-raise-error factory()', 'time', '--no-raise-error ', 'factory()'],
    [
      '%time --no-raise-error --no-raise-error factory()',
      'time',
      '--no-raise-error --no-raise-error ',
      'factory()',
    ],
    ['%time -value', 'time', null, '-value'],
    ['%time -1', 'time', null, '-1'],
    [
      '%prun -Dprofile.dump -l 10 -s cumulative -T "profile results.txt" -rq factory()',
      'prun',
      '-Dprofile.dump -l 10 -s cumulative -T "profile results.txt" -rq ',
      'factory()',
    ],
    ['%debug -b "my file.py:10" factory()', 'debug', '-b "my file.py:10" ', 'factory()'],
    ['%debug --break="my file.py:10" factory()', 'debug', '--break="my file.py:10" ', 'factory()'],
    ['%debug -value', 'debug', null, '-value'],
    ['%debug -1', 'debug', null, '-1'],
    ['%debug -b file.py:10 -value', 'debug', '-b file.py:10 ', '-value'],
    [
      '%debug --breakpoint="my file.py:10" factory()',
      'debug',
      '--breakpoint="my file.py:10" ',
      'factory()',
    ],
    ['%config Foo.bar = [1, 2]', 'config', null, 'Foo.bar = [1, 2]'],
    ['%time values = !echo hi', 'time', null, 'values = !echo hi'],
    ['%time np.mean?', 'time', null, 'np.mean?'],
    ['%timeit %time factory()', 'timeit', null, '%time factory()'],
  ];
  for (const [source, name, args, body] of cases) {
    const { tree } = parse(source + '\r\n');
    const node = nodes(tree, 'magic_statement')[0];
    assert.equal(node.text, source);
    assert.equal(node.child(0).type, '%');
    assert.equal(node.child(0).text, '%');
    assert.equal(node.childForFieldName('name').text, name);
    assert.equal(node.childForFieldName('arguments')?.text ?? null, args, source);
    assert.equal(node.childForFieldName('body')?.text ?? null, body, source);
    assert.deepEqual(node.endPosition, { row: 0, column: source.length });
    const rhs = nodes(parse('result = ' + source + '\n').tree, 'magic_expression')[0];
    assert.equal(rhs.text, source);
    assert.equal(rhs.childForFieldName('body')?.text ?? null, body);
  }
});

test('keeps non-Python magics and unknown or unfinished options opaque', () => {
  for (const source of [
    '%matplotlib inline',
    '%run -i "my script.py"',
    '%pinfo object.*',
    '%pfile "my file.py"',
    '%custom factory()',
    '%timeitcustom factory()',
    '%timeit -x factory()',
    '%prun --unknown factory()',
    '%debug --unknown factory()',
    '%timeit -n',
    '%debug -b "unfinished factory()',
  ]) {
    const { tree } = parse(source + '\n# %% Next\nx=1\n');
    const node = nodes(tree, 'magic_statement')[0];
    assert.equal(node.text, source);
    assert.equal(node.childForFieldName('body'), null, source);
    assert.deepEqual(markerNames(tree), ['Next']);
  }
  for (const source of ['%', '%%', '%   ']) {
    const node = nodes(parse(source + '\n').tree, 'magic_statement')[0];
    assert.equal(node.text, source);
    assert.equal(node.childForFieldName('name'), null);
  }
});

test('separates cell setup statements while leaving non-code headers opaque', () => {
  for (const [header, name, args, setup] of [
    ['%%timeit -n1 setup = 1', 'timeit', '-n1 ', 'setup = 1'],
    ['%%timeit setup = 1', 'timeit', null, 'setup = 1'],
    ['%%prun -q prepare()', 'prun', '-q ', 'prepare()'],
    [
      '%%debug --breakpoint="my file.py:10" prepare()',
      'debug',
      '--breakpoint="my file.py:10" ',
      'prepare()',
    ],
    ['%%time --no-raise-error', 'time', '--no-raise-error', null],
    ['%%capture output --no-stderr', 'capture', 'output --no-stderr', null],
    ['%%code_wrap wrapper', 'code_wrap', 'wrapper', null],
    ['%%bash -e', 'bash', '-e', null],
    ['%%custom option', 'custom', 'option', null],
  ]) {
    const source = header + '\r\nprint(1)\r\n# %% Next\nx=1\n';
    const node = nodes(parse(source).tree, 'cell_magic')[0];
    assert.equal(node.childForFieldName('name').text, name);
    assert.equal(node.childForFieldName('arguments')?.text ?? null, args, header);
    assert.equal(node.childForFieldName('setup')?.text ?? null, setup, header);
    assert.equal(node.childForFieldName('body').text, 'print(1)\r\n');
    if (setup)
      assert.deepEqual(node.childForFieldName('setup').endPosition, {
        row: 0,
        column: header.length,
      });
  }
});

test('bounds long magic names, quoted values and bodies across incremental edits', () => {
  const filename = 'path '.repeat(3000);
  const gap = ' '.repeat(10000);
  const cases = [
    '%prun -T "' + filename + '"' + gap + 'factory()',
    '%debug --breakpoint="' + filename + ':10" factory()',
    '%timeit -n1 ' + 'factory() + '.repeat(2000) + '1',
    '%' + 'custom'.repeat(2000) + ' factory()',
    '%%timeit -n1 ' + 'setup = "' + filename + '"\nprint(setup)',
    '%%' + 'custom'.repeat(2000) + ' option\nopaque body',
  ];
  for (const first of cases) {
    const source = first + '\n# %% Next\nx=1\n';
    const { parser, tree } = parse(source);
    assert.deepEqual(markerNames(tree), ['Next']);
    const offset = source.indexOf('path') + 1;
    const changedAt = offset > 0 ? offset : source.indexOf('1');
    const point = (index) => ({
      row: source.slice(0, index).split('\n').length - 1,
      column: index - source.lastIndexOf('\n', index - 1) - 1,
    });
    tree.edit({
      startIndex: changedAt,
      oldEndIndex: changedAt + 1,
      newEndIndex: changedAt + 1,
      startPosition: point(changedAt),
      oldEndPosition: point(changedAt + 1),
      newEndPosition: point(changedAt + 1),
    });
    const updated = source.slice(0, changedAt) + '2' + source.slice(changedAt + 1);
    const incremental = parse(updated, parser, tree).tree;
    const fresh = parse(updated).tree;
    assert.equal(incremental.rootNode.toString(), fresh.rootNode.toString());
    for (const type of [
      'line_magic_name',
      'line_magic_arguments',
      'python_magic_body',
      'cell_magic_name',
      'cell_magic_arguments',
    ])
      assert.deepEqual(
        nodes(incremental, type).map((node) => [node.text, node.startIndex, node.endIndex]),
        nodes(fresh, type).map((node) => [node.text, node.startIndex, node.endIndex]),
      );
  }
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

test('highlights magic names and raw arguments without capturing Python payloads', () => {
  const query = new Parser.Query(
    IPython,
    fs.readFileSync(path.join(__dirname, '..', '..', 'queries', 'highlights.scm'), 'utf8'),
  );
  const source = '%timeit -n1 factory(2)\n%matplotlib inline\n';
  const captures = query
    .captures(parse(source).tree.rootNode)
    .map(({ name, node }) => [name, node.text]);
  assert.deepEqual(captures, [
    ['operator', '%'],
    ['function.builtin', 'timeit'],
    ['string', '-n1 '],
    ['operator', '%'],
    ['function.builtin', 'matplotlib'],
    ['string', 'inline'],
  ]);
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

test('mixed cells keep reusable boundaries for EOF, opaque and identifier edits', (context) => {
  const count = 100;
  const source =
    Array.from({ length: count }, (_, index) => {
      switch (index % 5) {
        case 0:
          return '# %% Code ' + index + '\nvalue_' + index + ' = 1\n';
        case 1:
          return '# %% [markdown] Notes ' + index + '\nFOREIGN_MARKDOWN **😀**\n';
        case 2:
          return '# %% [raw] Data ' + index + '\nFOREIGN_RAW <bytes>\n';
        case 3:
          return '# %% Shell ' + index + '\n%%bash -e\necho FOREIGN_SHELL\n';
        default:
          return '# %% Timed ' + index + '\n%%time -q\nvalue_' + index + ' = !x\n%pwd\n';
      }
    }).join('') + '# %% Final\nlast_value = 1\n';
  const controls = [
    ['EOF code', source.indexOf('last_value = 1') + 'last_value = '.length, '2'],
    ['initial identifier', source.indexOf('value_0'), 'x'],
    ['Markdown body', source.indexOf('FOREIGN_MARKDOWN') + 1, 'x'],
    ['raw body', source.indexOf('FOREIGN_RAW') + 1, 'x'],
    ['EOF marker title', source.indexOf('# %% Final') + '# %% Fina'.length, 'L'],
  ];
  const point = (index) => ({
    row: source.slice(0, index).split('\n').length - 1,
    column: index - source.lastIndexOf('\n', index - 1) - 1,
  });
  const geometry = (tree) => {
    const result = [];
    const pending = [tree.rootNode];
    while (pending.length) {
      const node = pending.pop();
      result.push([
        node.type,
        node.text,
        node.startIndex,
        node.endIndex,
        node.startPosition,
        node.endPosition,
        node.isNamed,
        node.isExtra,
        node.childCount,
      ]);
      for (let child = node.childCount - 1; child >= 0; --child) pending.push(node.child(child));
    }
    return result;
  };
  for (const [operation, offset, replacement] of controls) {
    const { parser, tree } = parse(source);
    tree.edit({
      startIndex: offset,
      oldEndIndex: offset + 1,
      newEndIndex: offset + 1,
      startPosition: point(offset),
      oldEndPosition: point(offset + 1),
      newEndPosition: point(offset + 1),
    });
    let reused = 0,
      lexed = 0;
    parser.setLogger((message) => {
      if (message === 'reuse_node') ++reused;
      if (message === 'lexed_lookahead') ++lexed;
    });
    const updated = source.slice(0, offset) + replacement + source.slice(offset + 1);
    const incremental = parse(updated, parser, tree).tree;
    parser.setLogger(null);
    assert.ok(reused > count, operation + ': untouched cell nodes remain reusable.');
    assert.ok(lexed < count * 4, operation + ': known markers do not re-lex every scaffold token.');
    const fresh = parse(updated).tree;
    assert.equal(incremental.rootNode.toString(), fresh.rootNode.toString());
    assert.deepEqual(geometry(incremental), geometry(fresh));
    context.diagnostic(JSON.stringify({ operation, reused, lexed }));
  }
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
