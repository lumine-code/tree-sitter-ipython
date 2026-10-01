# tree-sitter-ipython

Parses IPython source files with Tree-sitter.

This thin document grammar recognizes .ipy cells and IPython commands. It does not contain a fork of Python's syntax or Python AST rules. The language-ipython editor package injects the original Python grammar into Python bodies and the original Markdown, shell, HTML and other grammars into their corresponding bodies. Notebook cells independently use their original language packages.

## Document structure

The root is module. Each ordinary cell is a code_cell with an optional marker and optional body. Nonempty source before the first marker is an implicit code_cell without a marker. All ordinary Python bodies, known Python wrappers and Python interpreter aliases share python_cell_body so the editor can combine their ranges into one native Python module.

Cell markers must start in column zero outside Python strings, brackets and explicit backslash continuation. They preserve marker, optional metadata and optional name fields. The marker field contains the hash, intervening whitespace and the complete percent run. Names exclude leading and trailing header whitespace. The compact navigation annotations #%%$#, #%%$$# and their existing flags remain marker titles; ordinary #$$p# comments remain Python content.

The case-sensitive first complete bracketed word selects a type: [markdown] or [md], [raw], and [code]. Bare md, markdown and raw are ordinary code-cell titles.

```ipy
# %% Setup
directory = %pwd
# %% [markdown] Notes
# Heading
**Markdown** is written literally.
# %% [raw] Payload
Exactly these bytes.
# %% Shell
%%bash -e
echo hello
```

markdown_cell and raw_cell preserve marker and optional body fields. Their cell_body starts after the header newline and ends immediately before the next marker or EOF. A column-zero marker is reserved even inside an opaque body or Markdown fence; indent literal marker text.

cell_magic preserves name, optional arguments and optional body. A cell magic must be the first nonblank line of its cell; a preceding comment or code prevents a cell header. The time, timeit, prun, debug, capture and code_wrap wrappers, and python, python2, python3 and pypy aliases, have python_cell_body. Foreign and unknown cell magics have opaque cell_body; the editor decides their injected language.

Python bodies contain only hidden source chunks and actual magic_statement, shell_statement, help_statement, magic_expression and shell_expression nodes. Suffix help nodes include the full value? or obj.method?? expression. RHS nodes cover only the command after the assignment operator. Python operators, comments and quoted command-like text remain opaque Python source.

## Lexical boundaries

Body chunks, commands, names, arguments, marker prefixes and titles consume at most 4096 Unicode codepoints per external token. Long prefixes and suffix-help names continue through hidden tokens; no marker-length limit is imposed. The scanner stores quote, f-string, bracket, physical-line and continuation context, without seeking backwards through a long row. Hidden chunks do not create a public node for every line.

The scaffold deliberately accepts ordinary malformed Python as a Python body. Native Python injections handle Python syntax and may recover around omitted IPython-only statements. The shared analysis projection in language-ipython keeps statement suites and RHS assignments valid for Python tooling without changing source or execution.

## Usage

```js
const Parser = require('tree-sitter');
const IPython = require('@lumine-code/tree-sitter-ipython');

const parser = new Parser();
parser.setLanguage(IPython);
const tree = parser.parse('# %% Code\nvalue = %pwd\n');
```

## Building

```sh
npm install
npm test
npm run build:wasm
```

The editor's WebAssembly artifact and provenance are built through lem grammar from a pushed immutable parser commit. Corpus and native binding tests cover the document scaffold, lexical boundaries, full command spans, legacy annotations, large bodies and incremental edits. Python grammar coverage belongs to the original tree-sitter-python grammar rather than a second copy here.

## License

MIT. The project originated from tree-sitter-python; its license and source provenance remain in the repository.
