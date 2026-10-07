const assert = require('node:assert/strict');
const { test } = require('node:test');
const parseOptions = require('./parse-options');

const point = (index) => ({ row: 0, column: index });
function tree(length, ends) {
  return {
    rootNode: {
      endIndex: length,
      endPosition: point(length),
      descendantsOfType: () => ends.map((endIndex) => ({ endIndex, endPosition: point(endIndex) })),
    },
  };
}
const range = (startIndex, endIndex) => ({
  startIndex,
  startPosition: point(startIndex),
  endIndex,
  endPosition: point(endIndex),
});

test('parse options keep a complete adjacent union and prune tiny fragment cuts', () => {
  const ranges = parseOptions(
    tree(9000, [4096, 4097, 8192, 9000]),
    'x'.repeat(9000),
  ).includedRanges;
  assert.deepEqual(ranges, [range(0, 4096), range(4096, 8192), range(8192, 9000)]);
});
test('parse options preserve semantic holes rather than restore excluded input', () => {
  const semantic = [range(0, 4500), range(5000, 9000)];
  const result = parseOptions(tree(9000, [4096, 4097, 8192, 9000]), 'x'.repeat(9000), semantic);
  assert.deepEqual(result.includedRanges, [
    range(0, 4096),
    range(4096, 4500),
    range(5000, 8192),
    range(8192, 9000),
  ]);
});
test('parse options drop a cut inside an edited UTF16 surrogate pair', () => {
  const source = 'x'.repeat(4095) + '😀' + 'x'.repeat(5000);
  const result = parseOptions(tree(source.length, [4096, 8192, source.length]), source);
  assert.deepEqual(result.includedRanges, [range(0, 8192), range(8192, source.length)]);
});
test('parse options leave existing ranges unchanged when there are no fragments', () => {
  const semantic = [range(100, 200)];
  assert.equal(parseOptions(tree(9000, []), 'x'.repeat(9000)), undefined);
  assert.deepEqual(parseOptions(tree(9000, []), 'x'.repeat(9000), semantic), {
    includedRanges: semantic,
  });
  assert.equal(parseOptions(null), undefined);
  assert.deepEqual(parseOptions(null, undefined, semantic), { includedRanges: semantic });
});
test('parse options do not split an edited CRLF pair', () => {
  const source = 'x'.repeat(4095) + '\r\n' + 'x'.repeat(5000);
  const result = parseOptions(tree(source.length, [4096, 8192, source.length]), source);
  assert.deepEqual(result.includedRanges, [range(0, 8192), range(8192, source.length)]);
});
test('local compaction selects bounded contiguous short fragments without semantic holes', () => {
  const fragments = Array.from({ length: 128 }, (_, i) => ({
    startIndex: 4096 + i,
    endIndex: 4097 + i,
    startPosition: point(4096 + i),
    endPosition: point(4097 + i),
  }));
  const regions = parseOptions.coalescingRegions(fragments, 'x'.repeat(9000), [range(0, 9000)]);
  assert.deepEqual(
    regions.map((r) => [r.startIndex, r.endIndex]),
    [
      [4096, 4160],
      [4160, 4224],
    ],
  );
  assert.equal(
    parseOptions.coalescingRegions(fragments, 'x'.repeat(9000), [range(0, 4100), range(4200, 9000)])
      .length,
    0,
  );
});
