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
