/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// IPython document syntax only; Python is delegated to the original grammar.
module.exports = grammar({
  name: 'ipython',
  extras: _ => [],
  externals: $ => [
    $._prefix_hash, $._marker_hash, $._body_hash, $._prefix_space,
    $._prefix_percent_start, $._prefix_percent_more,
    $._header_space, $._title_space, $._trailing_space, $._uncertain_space,
    $._markdown_cell_type, $._raw_cell_type, $._code_cell_type,
    $._header_title_chunk, $._cell_header_end,
    $._python_cell_magic, $._foreign_cell_magic, $._magic_name_chunk, $._arguments_chunk,
    $._line_magic_name_chunk, $._line_magic_space, $._line_magic_arguments_chunk, $._python_magic_body_chunk,
    $._padding_chunk, $._python_chunk, $._cell_body_chunk,
    $._magic_statement_start, $._shell_statement_start, $._help_statement_start,
    $._magic_expression_start, $._shell_expression_start, $._command_tail,
    $._help_prefix_chunk, $._help_suffix, $._document_end,
  ],
  conflicts: $ => [
    [$._initial_padding_before_marker, $._initial_code_cell, $.python_cell_body],
    [$.code_cell], [$.python_cell_body], [$.cell_body],
    [$.code_cell, $.python_cell_body],
    [$.python_cell_body, $.help_statement],
    [$.markdown_cell], [$.raw_cell], [$.cell_magic],
    [$.cell_marker_name],
    [$._leading_header_space, $._trailing_header_space],
  ],
  rules: {
    module: $ => seq(
      optional(choice(
        alias($._initial_code_cell, $.code_cell),
        seq(alias($._initial_padding_before_marker, $.code_cell),
          choice($.code_cell, $.markdown_cell, $.raw_cell)),
      )),
      repeat(choice($.code_cell, $.markdown_cell, $.raw_cell)),
      $._document_end,
    ),
    _initial_padding_before_marker: $ => prec.dynamic(1, repeat1($._padding_chunk)),
    _initial_code_cell: $ => choice(
      field('body', $.python_cell_body),
      seq(repeat($._padding_chunk), field('body', $.cell_magic)),
    ),
    code_cell: $ => seq(
      field('marker', $.cell_marker), $._cell_header_end,
      optional(choice(
        field('body', $.python_cell_body),
        seq(repeat($._padding_chunk), field('body', $.cell_magic)),
      )),
    ),
    markdown_cell: $ => seq(
      field('marker', alias($._markdown_cell_header, $.cell_marker)), $._cell_header_end,
      optional(field('body', $.cell_body)),
    ),
    raw_cell: $ => seq(
      field('marker', alias($._raw_cell_header, $.cell_marker)), $._cell_header_end,
      optional(field('body', $.cell_body)),
    ),
    python_cell_body: $ => repeat1(choice(
      $._padding_chunk, $._python_chunk, $._body_prefix, $._help_prefix_chunk,
      $.magic_statement, $.shell_statement, $.help_statement,
      $.magic_expression, $.shell_expression,
    )),
    cell_body: $ => repeat1(choice($._cell_body_chunk, $._body_prefix)),
    _body_prefix: $ => seq(choice($._prefix_hash, $._body_hash), repeat($._prefix_space)),
    cell_magic: $ => choice(
      seq(alias($._python_cell_magic, '%%'), field('name', $.cell_magic_name),
        optional(seq(repeat1($._header_space), optional(field('arguments', $.cell_magic_arguments)),
          optional(field('setup', $.python_magic_body)))),
        $._cell_header_end, optional(field('body', $.python_cell_body))),
      seq(alias($._foreign_cell_magic, '%%'), field('name', $.cell_magic_name),
        optional(seq(repeat1($._header_space), optional(field('arguments', $.cell_magic_arguments)),
          optional(field('setup', $.python_magic_body)))),
        $._cell_header_end, optional(field('body', $.cell_body))),
    ),
    cell_magic_name: $ => repeat1($._magic_name_chunk),
    cell_magic_arguments: $ => repeat1($._arguments_chunk),
    line_magic_name: $ => repeat1($._line_magic_name_chunk),
    line_magic_arguments: $ => repeat1($._line_magic_arguments_chunk),
    python_magic_body: $ => repeat1($._python_magic_body_chunk),
    magic_statement: $ => seq(alias($._magic_statement_start, '%'),
      optional(field('name', $.line_magic_name)), repeat($._line_magic_space),
      optional(field('arguments', $.line_magic_arguments)), optional(field('body', $.python_magic_body))),
    shell_statement: $ => seq($._shell_statement_start, repeat($._command_tail)),
    help_statement: $ => choice(
      seq($._help_statement_start, repeat($._command_tail)),
      seq(repeat1($._help_prefix_chunk), $._help_suffix),
    ),
    magic_expression: $ => seq(alias($._magic_expression_start, '%'),
      optional(field('name', $.line_magic_name)), repeat($._line_magic_space),
      optional(field('arguments', $.line_magic_arguments)), optional(field('body', $.python_magic_body))),
    shell_expression: $ => seq($._shell_expression_start, repeat($._command_tail)),
    cell_marker_marker: $ => seq(
      choice($._prefix_hash, $._marker_hash), repeat($._prefix_space), $._prefix_percent_start, repeat($._prefix_percent_more),
    ),
    cell_marker: $ => choice(
      seq(field('marker', $.cell_marker_marker), optional(seq(
        repeat($._leading_header_space), field('name', $.cell_marker_name),
      )), repeat($._trailing_header_space)),
      seq(field('marker', $.cell_marker_marker), repeat1($._leading_header_space),
        field('metadata', alias($._code_cell_type, $.cell_marker_metadata)),
        optional(seq(repeat1($._leading_header_space), field('name', $.cell_marker_name))),
        repeat($._trailing_header_space)),
    ),
    _markdown_cell_header: $ => seq(
      field('marker', $.cell_marker_marker), repeat1($._leading_header_space),
      field('metadata', alias($._markdown_cell_type, $.cell_marker_metadata)),
      optional(seq(repeat1($._leading_header_space), field('name', $.cell_marker_name))),
      repeat($._trailing_header_space),
    ),
    _raw_cell_header: $ => seq(
      field('marker', $.cell_marker_marker), repeat1($._leading_header_space),
      field('metadata', alias($._raw_cell_type, $.cell_marker_metadata)),
      optional(seq(repeat1($._leading_header_space), field('name', $.cell_marker_name))),
      repeat($._trailing_header_space),
    ),
    _leading_header_space: $ => choice($._header_space, $._uncertain_space),
    _trailing_header_space: $ => choice($._trailing_space, $._uncertain_space),
    cell_marker_name: $ => seq(repeat1($._header_title_chunk), repeat(seq(
      repeat1(choice($._title_space, $._uncertain_space)), repeat1($._header_title_chunk),
    ))),
  },
});
