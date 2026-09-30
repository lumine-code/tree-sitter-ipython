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

Markers must start in column zero. `[markdown]`, `[md]`, `[raw]`, and the legacy bare `markdown`, `md`, and `raw` select the cell type; metadata is case-sensitive and must be the first complete word after the percent run. Every additional `%` is a navigation level. Other words are code-cell titles. Markers inside Python strings, brackets, continued expressions, or indented blocks remain Python content.

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

Opaque body leaves consume at most 4096 Unicode code points per scanner call, including speculative marker lookahead. Recognition of the `#` and whitespace before the first two `%` characters has the same bound; a longer prefix remains body text. Hidden chunks do not create a public node per line. Insertion or deletion in a very long line can still require reparsing several chunks.

## Building

```sh
npm install
npm test
npm run build:wasm
```

`npm run benchmark:cells` reports native cold and incremental parsing for large raw cells, including a single long line. Run it separately from other timing workloads. The editor's committed WebAssembly artifact and provenance are rebuilt through `lem grammar` from a pushed immutable parser commit.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
