# tree-sitter-ipython

Parses IPython source files with Tree-sitter.

This parser is derived from `tree-sitter-python` at `26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64`. Its grammar extensions cover IPython magics, shell escapes, help requests, and structured cell markers.

## Features

- **Grammars**: provides a Tree-sitter grammar for IPython source files.
- **Cell markers**: parses `# %% Title`, deeper `%` runs, and bracketed `[markdown]` metadata into separate marker, metadata, and name fields.
- **Magics**: parses line and cell magics as `magic_statement` nodes.
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

## Building

```sh
npm install
npm test
npm run build:wasm
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
