# tree-sitter-ipython

Parses IPython source files with Tree-sitter.

This thin document grammar recognizes .ipy cells and IPython commands. It does not contain a fork of Python's syntax or Python AST rules. The language-ipython editor package injects the original Python grammar into Python bodies and the original Markdown, shell, HTML and other grammars into their corresponding bodies. Notebook cells independently use their original language packages.

## Document structure

The root is module. Each ordinary cell is a code_cell with an optional marker and optional body. Nonempty source before the first marker is an implicit code_cell without a marker. All ordinary Python bodies, known Python wrappers and Python interpreter aliases share python_cell_body so the editor can combine their ranges into one native Python module.

Cell markers must start in column zero outside Python strings, brackets and explicit backslash continuation. They preserve marker, optional metadata and optional name fields. The marker field contains the hash, intervening whitespace and the complete percent run. Names exclude leading and trailing header whitespace. Compact #%% headers and navigation annotations such as #%%$#, #%%$$p# and #%%$$s*_<;# are supported. Navigation flags remain part of the name field, including s, p, v, 1, ?, priority modifiers and the _<; style flags; navigation-panel interprets them independently. A later [markdown] word after navigation flags remains title text. Indented or code-prefixed annotations, and ordinary #$$p# comments, remain Python content.

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

cell_magic preserves name, optional arguments, optional setup and optional body. A cell magic must be the first nonblank line of its cell; a preceding comment or code prevents a cell header. The time, timeit, prun, debug, capture and code_wrap wrappers, and python, python2, python3 and pypy aliases, have python_cell_body. The timeit, prun and debug headers separate leading CLI arguments from an optional python_magic_body in setup. Foreign and unknown cell magics have opaque cell_body; the editor decides their injected language.

Python bodies contain only hidden source chunks and actual magic_statement, shell_statement, help_statement, magic_expression and shell_expression nodes. Suffix help nodes include the full value? or obj.method?? expression. RHS nodes cover only the command after the assignment operator. Python operators, comments and quoted command-like text remain opaque Python source.

Help targets include wildcard names, literal integer subscripts and magic names, such as np.*?, items[-1]?? and %%timeit?. A trailing help suffix takes precedence over calling a line or cell magic. Magic and shell commands include all physical lines joined by a final backslash, including CRLF continuations; command fields retain the original source bytes.

Line magic statements and expressions preserve the percent prefix, optional name as line_magic_name, optional arguments as line_magic_arguments and optional body as python_magic_body. The time, timeit, prun, debug and config magics separate their Python payload from recognized leading options; other magics retain opaque arguments. Unknown options remain opaque for the getopt-based timeit and prun magics, while time and debug preserve unary Python expressions according to their partial argument parsing. Option clusters, attached values, quoted values and the -- boundary are supported. Python payloads remain opaque scaffold nodes for separate host injections, allowing nested IPython syntax in executable wrappers without adding it to the shared Python module.

## Lexical boundaries

Body chunks, commands, names, arguments, marker prefixes and titles consume at most 4096 Unicode codepoints per external token. Ordinary comment rows, Markdown headings and first words are resolved within multi-row body chunks; only marker and suffix-help candidates need separate prefix tokens. Long prefixes and suffix-help names continue through hidden tokens; no marker-length limit is imposed. The scanner stores quote, f-string, bracket, help-target, physical-line and logical-command continuation context, without seeking backwards through a long row. Hidden chunks do not create a public node for every line.

Opaque chunks expose anonymous opaque_fragment tokens. After editing a tree, parseOptions() splits the existing input ranges at those edited fragment ends. These adjacent ranges include every source character; they provide alignment hints rather than exclude text. The scanner stops at a hint before continuing into the next range, so character, newline and whole-row edits reuse the following fragments without a cumulative row counter. Without alignment options, parsing remains correct but an insertion can shift chunk boundaries to EOF.

To bound fragmentation during repeated edits, the helper marks small contiguous groups of 64 fragments dirty with an equal-width tree edit. Each group spans at most 4096 source units and the helper touches at most eight groups per parse. This changes only the old tree's reuse metadata, not source text, so the next parse coalesces the region into bounded larger fragments. A current source string lets the helper protect CRLF and surrogate pairs while preparing cuts and compaction regions.

The scaffold deliberately accepts ordinary malformed Python as a Python body. Native Python injections handle Python syntax and may recover around omitted IPython-only statements. The shared analysis projection in language-ipython keeps statement suites and RHS assignments valid for Python tooling without changing source or execution.

## Usage

```js
const Parser = require('tree-sitter');
const IPython = require('@lumine-code/tree-sitter-ipython');

const parser = new Parser();
parser.setLanguage(IPython);
const tree = parser.parse('# %% Code\nvalue = %pwd\n');
```

For incremental parsing, call tree.edit() with the usual Tree-sitter edit and pass IPython.parseOptions(tree, updatedSource) as the third parser.parse() argument. Pass existing semantic includedRanges as the helper's third argument when parsing only selected source ranges. The same helper accepts a web-tree-sitter tree. Editors can use queries/parse-boundaries.scm to collect the equivalent parse.boundary captures.

## Building

```sh
npm install
npm test
npm run build:wasm
```

The editor's WebAssembly artifact and provenance are built through lem grammar from a pushed immutable parser commit. Corpus and native binding tests cover the document scaffold, lexical boundaries, full command spans, legacy annotations, large bodies and incremental edits. Python grammar coverage belongs to the original tree-sitter-python grammar rather than a second copy here.

## License

MIT. The project originated from tree-sitter-python; its license and source provenance remain in the repository.
