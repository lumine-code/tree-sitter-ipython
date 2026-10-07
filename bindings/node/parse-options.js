const MIN_GAP = 1024;
const COMPACTION_COUNT = 64;
const COMPACTION_SPAN = 4096;
const MAX_COMPACTIONS = 8;

function splitsCharacter(source, index) {
  const previous = source?.charCodeAt(index - 1),
    next = source?.charCodeAt(index);
  return (
    (previous === 13 && next === 10) ||
    (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
  );
}
function coalescingRegions(fragments, source, includedRanges) {
  const regions = [];
  let first = null,
    last = null,
    count = 0;
  for (const fragment of fragments) {
    const short = fragment.endIndex - fragment.startIndex < MIN_GAP;
    if (!short || (last && last.endIndex !== fragment.startIndex)) {
      first = null;
      last = null;
      count = 0;
    }
    if (!short) continue;
    first ||= fragment;
    last = fragment;
    count++;
    if (count < COMPACTION_COUNT) continue;
    const fits = last.endIndex - first.startIndex <= COMPACTION_SPAN;
    const owned = includedRanges.some(
      (range) => first.startIndex >= range.startIndex && last.endIndex <= range.endIndex,
    );
    if (
      fits &&
      owned &&
      !splitsCharacter(source, first.startIndex) &&
      !splitsCharacter(source, last.endIndex)
    ) {
      regions.push({
        startIndex: first.startIndex,
        endIndex: last.endIndex,
        startPosition: first.startPosition,
        endPosition: last.endPosition,
      });
      if (regions.length === MAX_COMPACTIONS) break;
    }
    first = null;
    last = null;
    count = 0;
  }
  return regions;
}

// Call after tree.edit(). Splitting ranges never removes input: every new
// range is adjacent to its neighbour inside the original semantic range.
module.exports = function parseOptions(tree, source, includedRanges) {
  // Edited endpoints alone cannot detect a newly joined CRLF or surrogate
  // pair. Without current text, preserve the caller's semantic ranges only.
  if (!tree || typeof source !== 'string') return includedRanges ? { includedRanges } : undefined;
  let root = tree.rootNode;
  const limits = includedRanges || [
    {
      startIndex: 0,
      startPosition: { row: 0, column: 0 },
      endIndex: root.endIndex,
      endPosition: root.endPosition,
    },
  ];
  // Capture plain coordinates before invalidating anything: node handles
  // themselves are stale after tree.edit(), even for an equal-width edit.
  let fragments = root.descendantsOfType('opaque_fragment').map((node) => ({
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startPosition: node.startPosition,
    endPosition: node.endPosition,
  }));
  if (typeof tree.edit === 'function') {
    const regions = coalescingRegions(fragments, source, limits);
    for (const region of regions)
      tree.edit({
        startIndex: region.startIndex,
        oldEndIndex: region.endIndex,
        newEndIndex: region.endIndex,
        startPosition: region.startPosition,
        oldEndPosition: region.endPosition,
        newEndPosition: region.endPosition,
      });
    if (regions.length) {
      root = tree.rootNode;
      fragments = root.descendantsOfType('opaque_fragment').map((node) => ({
        endIndex: node.endIndex,
        endPosition: node.endPosition,
      }));
    }
  }
  const boundaries = fragments.map((fragment) => ({
    index: fragment.endIndex,
    position: fragment.endPosition,
  }));
  if (!boundaries.length) return includedRanges ? { includedRanges } : undefined;
  const result = [];
  let cursor = 0;
  for (const range of limits) {
    let index = range.startIndex,
      position = range.startPosition;
    while (cursor < boundaries.length && boundaries[cursor].index <= range.startIndex) cursor++;
    while (cursor < boundaries.length && boundaries[cursor].index < range.endIndex) {
      const boundary = boundaries[cursor++];
      if (boundary.index - index < MIN_GAP) continue;
      if (splitsCharacter(source, boundary.index)) continue;
      result.push({
        startIndex: index,
        startPosition: position,
        endIndex: boundary.index,
        endPosition: boundary.position,
      });
      index = boundary.index;
      position = boundary.position;
    }
    if (index < range.endIndex)
      result.push({
        startIndex: index,
        startPosition: position,
        endIndex: range.endIndex,
        endPosition: range.endPosition,
      });
  }
  return { includedRanges: result };
};
module.exports.MIN_GAP = MIN_GAP;
module.exports.coalescingRegions = coalescingRegions;
