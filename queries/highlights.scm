(cell_marker) @comment
(cell_marker_metadata) @attribute
(cell_magic name: (cell_magic_name) @function.builtin)
(cell_magic_arguments) @string
["%" "%%"] @operator
[(magic_statement name: (line_magic_name) @function.builtin)
 (magic_expression name: (line_magic_name) @function.builtin)]
(line_magic_arguments) @string
[(shell_statement) (shell_expression)] @string.special
(help_statement) @keyword
