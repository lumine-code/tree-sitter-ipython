# tree-sitter-ipython

Parses IPython source files with Tree-sitter.

This document parser is derived from `tree-sitter-python` at `26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64`. It parses `.ipy` files containing Python, IPython commands, and literal Markdown or raw cells. A notebook's independently typed cells use their original language parsers.

## Features

- **Grammars**: provides a Tree-sitter grammar for IPython source files.
- **Cell markers**: parses top-level `# %% Title`, deeper `%` runs, and exact Markdown or raw metadata into separate marker, metadata, and name fields.
- **Cell bodies**: preserves literal Markdown and raw content in bounded opaque chunks without parsing it as Python.
- **Magics**: parses line commands, structured cell magic headers, and assignment results from magics and shell escapes.
- **Shell escapes**: parses shell command lines as `shell_statement` nodes.
- **Help requests**: parses prefix and suffix help syntax as `help_statement` nodes.
- **Python compatibility**: preserves the upstream Python tree shape for ordinary source.
- **Bindings**: supports Node-API, source, and WebAssembly builds.

## Installation

```sh
npm install tree-sitter @lumine-code/tree-sitter-ipython
```

## Usage

```js
const Parser = require('tree-sitter');
const IPython = require('@lumine-code/tree-sitter-ipython');

const parser = new Parser();
parser.setLanguage(IPython);
const tree = parser.parse('%matplotlib inline\nvalue = 1\n');
```

Markers must start in column zero. `[markdown]`, `[md]`, and `[raw]` select the cell type; `[code]` explicitly selects code; metadata is case-sensitive and must be the first complete word after the percent run. Every additional `%` is a navigation level. Bare `markdown`, `md`, `raw`, and other words are code-cell titles. Markers inside Python strings, brackets, continued expressions, or indented blocks remain Python content.

```ipy
# %% Setup
directory = %pwd
# %% [markdown] Notes
# Heading
**Markdown** is written literally.
# %% [raw] Payload
Exactly this text, including its # characters.
# %% Shell
%%bash -x
echo hello
```

`markdown_cell` and `raw_cell` expose `marker` and optional `body` fields. The marker retains `marker`, `metadata`, and optional `name` fields. Bodies start after the header's line ending and end immediately before the next marker or EOF. A column-zero marker is reserved even inside an opaque body; indent it when it is literal content.

`cell_magic` exposes `name`, optional `arguments`, and optional `body`. It must be the first nonblank line in its code cell; a preceding comment or Python statement prevents a cell magic. `time`, `timeit`, `prun`, `debug`, `capture`, and `code_wrap` use `python_cell_body` with ordinary Python nodes. Other names use opaque `cell_body`; the editor chooses an embedded language without changing execution. Ordinary Python outside these wrappers keeps its upstream tree shape.

Opaque bodies and marker prefixes, percent runs, header gaps, and titles continue through hidden leaves that consume at most 4096 Unicode code points per scanner call. There is no marker-length limit. Hidden chunks do not create a public node per line. Top-level comments retain their original visible nodes, text, parents and positions; their ancillary `isExtra` flag is false because the bounded prefix is resolved by an explicit comment rule. Inline comments and comments in nested suites or brackets remain extras. Insertion or deletion in a very long line can still require reparsing several chunks.

The scanner serializes whether an opaque chunk ends at a line start. Resuming a middle chunk after an incremental edit does not seek backwards through a long line to determine its column.

Short prefixes and title gaps are classified without grammar ambiguity; longer prefixes continue through bounded chunks. Comment termination leaves serialized state unchanged when it consumes no text, preserving reuse of later cells. Bracket and explicit continuation context is serialized separately; a reserved marker after a noncontinued incomplete assignment starts a new cell and leaves the preceding code erroneous.

## Building

```sh
npm install
npm test
npm run build:wasm
```

`npm run benchmark:cells` reports native cold and incremental parsing for large raw cells, including a single long line. Run it separately from other timing workloads. The editor's committed WebAssembly artifact and provenance are rebuilt through `lem grammar` from a pushed immutable parser commit.

For a native parser comparison, keep an original binding and the candidate binding and run:

```sh
node --expose-gc scripts/benchmark-native-parser.js --baseline=<baseline.node> --candidate=<candidate.node> --series=3 --warmup=5 --samples=30 --sizes=1048576,8388608 --output=<results.json>
```

The matrix compares identical ordinary Python inputs and checks root structure plus five bounded AST windows before measurement. The comment control inserts one simple statement after every 16 short comment rows so indentation lookahead remains bounded; an uninterrupted comment run is retained as a separate baseline pathology diagnostic. Its JSON states the proof properties and records ancillary `isExtra` flags separately; the full corpus verifies ordinary Python syntax. Candidate diagnostics cover long lines, many lines, tiny lines, CRLF, astral Unicode, EOF and unlimited marker prefixes. It records cold parses, replacement, insertion and deletion at the beginning, middle and end, plus file hashes, runtime identity, individual samples and percentiles. AST proof, collection, tree release and retained-memory reads stay outside measured parse latency. Phase progress and partial results are written after each fixture/parser run. Use `--only=controls` or `--only=opaque` to run one part.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
