const assert = require('node:assert/strict');
const { test } = require('node:test');
const parseOptions = require('../bindings/node/parse-options');

const CHUNK = 4096;
const pointAt = (source, index) => ({
  row: source.slice(0, index).split('\n').length - 1,
  column: index - source.lastIndexOf('\n', index - 1) - 1,
});
const namedGeometry = (tree) => {
  const result = [];
  const pending = [tree.rootNode];
  while (pending.length) {
    const node = pending.pop();
    result.push([node.type, node.startIndex, node.endIndex, node.startPosition, node.endPosition]);
    pending.push(...node.namedChildren);
  }
  return result;
};

module.exports = function scannerRegressions(runtime, createParser) {
  function parse(source, parser = createParser(), oldTree) {
    const tree = parser.parse(source, oldTree, oldTree ? parseOptions(oldTree, source) : undefined);
    assert.equal(tree.rootNode.hasError, false, source.slice(0, 160));
    assert.equal(tree.rootNode.endIndex, source.length);
    return tree;
  }
  function release(tree, parser) {
    tree?.delete?.();
    parser?.delete?.();
  }
  function incremental(source, offset, removed, replacement) {
    const parser = createParser();
    const tree = parse(source, parser);
    const changed = source.slice(0, offset) + replacement + source.slice(offset + removed);
    tree.edit({
      startIndex: offset,
      oldEndIndex: offset + removed,
      newEndIndex: offset + replacement.length,
      startPosition: pointAt(source, offset),
      oldEndPosition: pointAt(source, offset + removed),
      newEndPosition: pointAt(changed, offset + replacement.length),
    });
    const next = parse(changed, parser, tree);
    const freshParser = createParser();
    const fresh = parse(changed, freshParser);
    assert.equal(next.rootNode.toString(), fresh.rootNode.toString());
    assert.deepEqual(namedGeometry(next), namedGeometry(fresh));
    release(tree);
    release(fresh, freshParser);
    release(next, parser);
  }

  test(`${runtime}: template and format string interpolation protects nested marker text`, () => {
    for (const prefix of ['t', 'T', 'rt', 'tr', 'rT', 'tR', 'RT', 'TR', 'f', 'F', 'rf', 'fr']) {
      const parser = createParser();
      const source =
        'value = ' + prefix + '"""{f"""\n# %% [raw] Inside\n"""}\n"""\n# %% Actual\nx=1\n';
      const tree = parse(source, parser);
      assert.deepEqual(
        tree.rootNode.descendantsOfType('cell_marker').map((node) => node.text),
        ['# %% Actual'],
        prefix,
      );
      assert.equal(tree.rootNode.descendantsOfType('raw_cell').length, 0, prefix);
      release(tree, parser);
      const at = 'value = '.length;
      incremental(source, at, prefix.length, 'f');
      incremental(source, at, prefix.length, 't');
      incremental(source, at, prefix.length, 'r');
    }
  });
  test(`${runtime}: template interpolation survives quote and nested-field chunk crossings`, () => {
    for (const prefix of ['t', 'T', 'rt', 'tr']) {
      for (const quoteAt of [CHUNK - 2, CHUNK - 1, CHUNK, CHUNK + 1]) {
        const source =
          'value = ' +
          ' '.repeat(quoteAt - 8 - prefix.length) +
          prefix +
          '"""' +
          'x'.repeat(CHUNK * 2) +
          '{f"""\n# %% [raw] Inside\n' +
          'y'.repeat(CHUNK * 2) +
          '\n"""}\n"""\n# %% Actual\nx=1\n';
        const parser = createParser();
        const tree = parse(source, parser);
        assert.deepEqual(
          tree.rootNode.descendantsOfType('cell_marker').map((node) => node.text),
          ['# %% Actual'],
        );
        release(tree, parser);
        incremental(source, quoteAt - prefix.length, prefix.length, 'fr');
        incremental(source, source.indexOf('Inside'), 1, 'i');
        incremental(source, source.indexOf('y'.repeat(8)) + CHUNK, 0, 'z');
      }
    }
  });

  test(`${runtime}: suffix help covers magic, wildcard and integer-subscript targets`, () => {
    for (const target of [
      'np.*?',
      'foo[0]?',
      'foo[-1].attr[23]??',
      '*zip?',
      '%timeit?',
      '%%timeit?',
      '%%bash??',
      'name'.repeat(3000) + '[-12].*??',
      '%%' + 'custom'.repeat(3000) + '?',
    ]) {
      const parser = createParser();
      const source = target + '\n# %% Next\nx=1\n';
      const tree = parse(source, parser);
      assert.deepEqual(
        tree.rootNode.descendantsOfType('help_statement').map((node) => node.text),
        [target],
      );
      assert.equal(tree.rootNode.descendantsOfType('cell_magic').length, 0);
      assert.equal(tree.rootNode.descendantsOfType('magic_statement').length, 0);
      assert.equal(
        tree.rootNode.namedChildren.at(-1).childForFieldName('marker').childForFieldName('name')
          .text,
        'Next',
      );
      release(tree, parser);
      incremental(source, target.indexOf('?'), 1, '');
      incremental(source, Math.floor(target.length / 2), 0, 'a');
    }
  });
  test(`${runtime}: help probing preserves ordinary operators and noninteger subscripts`, () => {
    for (const row of [
      'foo*bar + 1',
      'foo[bar] + 2',
      'foo[0] + 2',
      'foo["?"]',
      'foo[1:2]?',
      'foo[+1]?',
      'foo(1)?',
      'foo..bar?',
      'x = 2 * foo',
    ]) {
      const parser = createParser();
      const source = row + '\n# %% Next\nx=1\n';
      const tree = parse(source, parser);
      assert.equal(tree.rootNode.descendantsOfType('help_statement').length, 0, row);
      release(tree, parser);
    }
  });
  test(`${runtime}: commands follow logical lines through CRLF and chunk boundaries`, () => {
    for (const ending of ['\n', '\r\n']) {
      const join = '\\' + ending;
      for (const [command, type] of [
        ['!echo one ' + join + '  two', 'shell_statement'],
        ['value = !echo one ' + join + '  two', 'shell_expression'],
        ['%custom one ' + join + '  two', 'magic_statement'],
        ['?obj ' + join + '  name', 'help_statement'],
        ['%timeit -n1 ' + join + '  f()', 'magic_statement'],
        ['%timeit -n ' + join + '  2 f()', 'magic_statement'],
        ['result = %timeit -n1 ' + join + '  f()', 'magic_expression'],
        ['!echo ' + 'x'.repeat(CHUNK - 7) + join + '  two', 'shell_statement'],
        ['!echo ' + 'x'.repeat(CHUNK - 8) + join + '  two', 'shell_statement'],
      ]) {
        const source = command + ending + '# %% Next' + ending + 'x=1' + ending;
        const parser = createParser();
        const tree = parse(source, parser);
        const node = tree.rootNode.descendantsOfType(type)[0];
        assert.equal(
          node.text,
          command.slice(
            type.endsWith('expression')
              ? command.indexOf('%') >= 0
                ? command.indexOf('%')
                : command.indexOf('!')
              : 0,
          ),
        );
        if (command.includes('timeit')) assert.equal(node.childForFieldName('body').text, 'f()');
        release(tree, parser);
        incremental(source, command.indexOf('\\'), 1, '');
        incremental(source, command.length - 1, 1, 'y');
      }
    }
    const source = '!echo one\n  two\n# %% Next\nx=1\n';
    incremental(source, source.indexOf('\n'), 0, '\\');
  });
  test(`${runtime}: embedded NUL remains data instead of truncating header classification`, () => {
    for (const source of [
      '# %% [raw]\0suffix\n%pwd\n',
      '# %% [raw]\nabc\0def\n# %% Next\nx=1\n',
      '%debug --break\0point=file.py:10 f()\n# %% Next\nx=1\n',
    ]) {
      const parser = createParser();
      const tree = parse(source, parser);
      if (source.startsWith('# %% [raw]\0'))
        assert.equal(tree.rootNode.namedChild(0).type, 'code_cell');
      release(tree, parser);
      incremental(source, source.indexOf('\0'), 1, 'a');
    }
  });
  test(`${runtime}: ordinary opaque hash rows use bounded multi-row chunks and suffix reuse`, (context) => {
    for (const header of ['# %% [markdown]\n', '# %% [raw]\n', '%%bash\n']) {
      const source = header + '# x\n'.repeat(262144) + '# %% End\nx=1\n';
      const parser = createParser();
      let lexed = 0,
        chunks = 0;
      parser.setLogger((message, data) => {
        if (message.startsWith('lexed_lookahead')) {
          lexed++;
          if (data?.sym === 'opaque_fragment' || message.includes('sym:opaque_fragment')) chunks++;
        }
      });
      const tree = parse(source, parser);
      assert.ok(lexed < 320, `${header}: ${lexed} tokens for 1 MiB`);
      assert.equal(chunks, 256);
      parser.setLogger(null);
      const offset = header.length + 2;
      tree.edit({
        startIndex: offset,
        oldEndIndex: offset + 1,
        newEndIndex: offset + 1,
        startPosition: pointAt(source, offset),
        oldEndPosition: pointAt(source, offset + 1),
        newEndPosition: pointAt(source, offset + 1),
      });
      lexed = 0;
      parser.setLogger((message) => {
        if (message.startsWith('lexed_lookahead')) lexed++;
      });
      const changed = source.slice(0, offset) + 'y' + source.slice(offset + 1);
      const next = parse(changed, parser, tree);
      parser.setLogger(null);
      assert.ok(lexed < 24, `${header}: ${lexed} re-lexed tokens after one ordinary edit`);
      const freshParser = createParser();
      const fresh = parse(changed, freshParser);
      assert.deepEqual(namedGeometry(next), namedGeometry(fresh));
      context.diagnostic(
        JSON.stringify({
          header: header.trim(),
          bytes: source.length,
          chunks,
          incrementalTokens: lexed,
        }),
      );
      release(tree);
      release(next, parser);
      release(fresh, freshParser);
    }
  });
  test(`${runtime}: aligned opaque fragments keep character and row edits local at 1 and 8 MiB`, (context) => {
    const header = '# %% [raw]\n';
    for (const size of [1048576, 8388608]) {
      const source = header + '# x\n'.repeat(size / 4) + '# %% End\nx=1\n';
      const parser = createParser();
      for (const [kind, at, removed, replacement] of [
        ['replace', 2, 1, 'y'],
        ['insert', 2, 0, 'y'],
        ['delete', 2, 1, ''],
        ['enter', 3, 0, '\n'],
        ['join', 3, 1, ''],
        ['insert-row', 0, 0, '# x\n'],
        ['delete-row', 0, 4, ''],
      ]) {
        const offset = header.length + at;
        const tree = parse(source, parser);
        const changed = source.slice(0, offset) + replacement + source.slice(offset + removed);
        tree.edit({
          startIndex: offset,
          oldEndIndex: offset + removed,
          newEndIndex: offset + replacement.length,
          startPosition: pointAt(source, offset),
          oldEndPosition: pointAt(source, offset + removed),
          newEndPosition: pointAt(changed, offset + replacement.length),
        });
        let lexed = 0;
        parser.setLogger((message) => {
          if (message.startsWith('lexed_lookahead')) lexed++;
        });
        const next = parse(changed, parser, tree);
        parser.setLogger(null);
        assert.ok(lexed < 24, `${size} ${kind}: ${lexed} re-lexed tokens`);
        const freshParser = createParser();
        const fresh = parse(changed, freshParser);
        assert.deepEqual(namedGeometry(next), namedGeometry(fresh));
        assert.equal(next.rootNode.descendantsOfType('cell_body')[0].namedChildCount, 0);
        context.diagnostic(JSON.stringify({ size, kind, lexed }));
        release(tree);
        release(next);
        release(fresh, freshParser);
      }
      parser.delete?.();
    }
  });
  test(`${runtime}: fragment alignment preserves CRLF, Unicode and long-row budget splits`, () => {
    const header = '# %% [raw]\n';
    for (const row of [
      '# x\r\n',
      '# x\r',
      '# 😀\n',
      'x'.repeat(CHUNK - 1) + '\r\n',
      'x'.repeat(CHUNK + 1) + '\n',
    ]) {
      const source = header + row.repeat(2050) + '# %% End\nx=1\n';
      incremental(source, header.length, 0, 'y');
      incremental(source, header.length + 2, 1, '');
    }
  });
  test(`${runtime}: adding or joining opaque physical rows preserves a fresh scaffold`, (context) => {
    const header = '# %% [raw]\n';
    for (const size of [1048576, 8388608]) {
      const source = header + '# x\n'.repeat(size / 4) + '# %% End\nx=1\n';
      for (const [kind, removed, replacement] of [
        ['split', 0, '\n'],
        ['join', 1, ''],
      ]) {
        const offset = header.length + 3;
        incremental(source, offset, removed, replacement);
        context.diagnostic(
          `${size} ${kind}: aligned incremental geometry matches a fresh scaffold`,
        );
      }
    }
  });
  test(`${runtime}: repeated Enter edits coalesce local fragments without changing source ownership`, (context) => {
    const parser = createParser();
    let source = '# %% [raw]\n' + '# x\n'.repeat(262144) + '# %% End\nx=1\n';
    let tree = parse(source, parser);
    let maximum = 0,
      maxLexed = 0;
    for (let step = 0; step < 300; step++) {
      const offset = 14;
      tree.edit({
        startIndex: offset,
        oldEndIndex: offset,
        newEndIndex: offset + 1,
        startPosition: { row: 1, column: 3 },
        oldEndPosition: { row: 1, column: 3 },
        newEndPosition: { row: 2, column: 0 },
      });
      source = source.slice(0, offset) + '\n' + source.slice(offset);
      let lexed = 0;
      parser.setLogger((message) => {
        if (message.startsWith('lexed_lookahead')) lexed++;
      });
      const next = parse(source, parser, tree);
      parser.setLogger(null);
      release(tree);
      tree = next;
      maximum = Math.max(maximum, tree.rootNode.descendantsOfType('opaque_fragment').length);
      maxLexed = Math.max(maxLexed, lexed);
      if (step % 50 === 0) {
        const reference = createParser();
        const fresh = parse(source, reference);
        assert.deepEqual(namedGeometry(tree), namedGeometry(fresh));
        release(fresh, reference);
      }
    }
    assert.ok(maximum < 350, `Local compaction bounds fragments: ${maximum}`);
    assert.ok(maxLexed < 24, `Compaction stays local: ${maxLexed}`);
    context.diagnostic(JSON.stringify({ maximum, maxLexed }));
    release(tree, parser);
  });
};
