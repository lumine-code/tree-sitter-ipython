#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

enum TokenType {
    NEWLINE,
    INDENT,
    DEDENT,
    STRING_START,
    STRING_CONTENT,
    ESCAPE_INTERPOLATION,
    STRING_END,
    COMMENT,
    CLOSE_PAREN,
    CLOSE_BRACKET,
    CLOSE_BRACE,
    EXCEPT,
    CODE_CELL_MARKER,
    MARKDOWN_CELL_MARKER,
    RAW_CELL_MARKER,
    PYTHON_CELL_MAGIC,
    FOREIGN_CELL_MAGIC,
    CELL_HEADER_END,
    CELL_BODY_CHUNK,
};

typedef enum {
    SingleQuote = 1 << 0,
    DoubleQuote = 1 << 1,
    BackQuote = 1 << 2,
    Raw = 1 << 3,
    Format = 1 << 4,
    Triple = 1 << 5,
    Bytes = 1 << 6,
} Flags;

typedef struct {
    char flags;
} Delimiter;

static inline Delimiter new_delimiter() { return (Delimiter){0}; }

static inline bool is_format(Delimiter *delimiter) { return delimiter->flags & Format; }

static inline bool is_raw(Delimiter *delimiter) { return delimiter->flags & Raw; }

static inline bool is_triple(Delimiter *delimiter) { return delimiter->flags & Triple; }

static inline bool is_bytes(Delimiter *delimiter) { return delimiter->flags & Bytes; }

static inline int32_t end_character(Delimiter *delimiter) {
    if (delimiter->flags & SingleQuote) {
        return '\'';
    }
    if (delimiter->flags & DoubleQuote) {
        return '"';
    }
    if (delimiter->flags & BackQuote) {
        return '`';
    }
    return 0;
}

static inline void set_format(Delimiter *delimiter) { delimiter->flags |= Format; }

static inline void set_raw(Delimiter *delimiter) { delimiter->flags |= Raw; }

static inline void set_triple(Delimiter *delimiter) { delimiter->flags |= Triple; }

static inline void set_bytes(Delimiter *delimiter) { delimiter->flags |= Bytes; }

static inline void set_end_character(Delimiter *delimiter, int32_t character) {
    switch (character) {
        case '\'':
            delimiter->flags |= SingleQuote;
            break;
        case '"':
            delimiter->flags |= DoubleQuote;
            break;
        case '`':
            delimiter->flags |= BackQuote;
            break;
        default:
            assert(false);
    }
}

typedef struct {
    Array(uint16_t) indents;
    Array(Delimiter) delimiters;
    bool inside_interpolated_string;
    bool cell_start;
    bool body_line_start;
} Scanner;

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

// The bound covers speculative marker lookahead as well as body content. A
// longer marker prefix is literal body text instead of an uninterruptible scan.
#define CELL_CHUNK_LIMIT 4096

typedef enum { NotMarker, Marker, IncompleteMarker } MarkerProbe;

static MarkerProbe probe_marker(TSLexer *lexer, uint32_t limit, uint32_t *consumed) {
    *consumed = 0;
    if (lexer->lookahead != '#') return NotMarker;
    advance(lexer);
    ++*consumed;
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
        if (*consumed == limit) return IncompleteMarker;
        advance(lexer);
        ++*consumed;
    }
    if (lexer->lookahead != '%') return NotMarker;
    if (*consumed == limit) return IncompleteMarker;
    advance(lexer);
    ++*consumed;
    if (lexer->lookahead != '%') return NotMarker;
    if (*consumed == limit) return IncompleteMarker;
    advance(lexer);
    ++*consumed;
    return Marker;
}

static bool finish_cell_marker(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols, uint32_t consumed) {
    while (lexer->lookahead == '%' && consumed < CELL_CHUNK_LIMIT) {
        advance(lexer);
        ++consumed;
    }
    lexer->mark_end(lexer);
    bool has_space = lexer->lookahead == ' ' || lexer->lookahead == '\t';
    while ((lexer->lookahead == ' ' || lexer->lookahead == '\t') && consumed < CELL_CHUNK_LIMIT) {
        advance(lexer);
        ++consumed;
    }
    char metadata[16] = {0};
    uint32_t length = 0;
    while (length < sizeof(metadata) - 1 && consumed < CELL_CHUNK_LIMIT &&
           lexer->lookahead && lexer->lookahead != ' ' && lexer->lookahead != '\t' &&
           lexer->lookahead != '\r' && lexer->lookahead != '\n') {
        if (lexer->lookahead > 127) break;
        metadata[length++] = (char)lexer->lookahead;
        advance(lexer);
        ++consumed;
    }
    bool delimited = lexer->eof(lexer) || lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
                     lexer->lookahead == '\r' || lexer->lookahead == '\n';
    enum TokenType type = CODE_CELL_MARKER;
    if (has_space && delimited) {
        if (!strcmp(metadata, "[markdown]") || !strcmp(metadata, "[md]") ||
            !strcmp(metadata, "markdown") || !strcmp(metadata, "md")) type = MARKDOWN_CELL_MARKER;
        if (!strcmp(metadata, "[raw]") || !strcmp(metadata, "raw")) type = RAW_CELL_MARKER;
    }
    if (!valid_symbols[type]) return false;
    scanner->cell_start = type == CODE_CELL_MARKER;
    scanner->body_line_start = false;
    lexer->result_symbol = type;
    return true;
}

static bool scan_cell_marker(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    if (lexer->get_column(lexer) != 0 || scanner->delimiters.size > 0 ||
        scanner->indents.size > 1) return false;
    uint32_t consumed;
    if (probe_marker(lexer, CELL_CHUNK_LIMIT, &consumed) != Marker) return false;
    return finish_cell_marker(scanner, lexer, valid_symbols, consumed);
}

static bool scan_cell_magic(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    if (!scanner->cell_start || lexer->get_column(lexer) != 0 || scanner->delimiters.size > 0 ||
        scanner->indents.size > 1 || lexer->lookahead != '%') return false;
    advance(lexer);
    if (lexer->lookahead != '%') return false;
    advance(lexer);
    lexer->mark_end(lexer);
    char name[32] = {0};
    uint32_t length = 0;
    while (length < sizeof(name) - 1 &&
           ((lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
            (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
            (lexer->lookahead >= '0' && lexer->lookahead <= '9') ||
            lexer->lookahead == '_' || lexer->lookahead == '!')) {
        name[length++] = (char)lexer->lookahead;
        advance(lexer);
    }
    if (!length) return false;
    bool python = !strcmp(name, "time") || !strcmp(name, "timeit") || !strcmp(name, "prun") ||
                  !strcmp(name, "debug") || !strcmp(name, "capture") || !strcmp(name, "code_wrap");
    enum TokenType type = python ? PYTHON_CELL_MAGIC : FOREIGN_CELL_MAGIC;
    if (!valid_symbols[type]) return false;
    scanner->cell_start = false;
    scanner->body_line_start = false;
    lexer->result_symbol = type;
    return true;
}

static bool scan_cell_body(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    uint32_t count = 0;
    // get_column can seek back to the start of a megabyte-long line after an
    // incremental subtree reuse. Track this at token ends instead, so seeking
    // to a middle chunk never performs work outside the chunk's budget.
    bool line_start = scanner->body_line_start;
    lexer->mark_end(lexer);
    while (!lexer->eof(lexer) && count < CELL_CHUNK_LIMIT) {
        if (line_start && lexer->lookahead == '#') {
            uint32_t consumed;
            MarkerProbe probe = probe_marker(lexer, CELL_CHUNK_LIMIT - count, &consumed);
            if (probe == Marker || (probe == IncompleteMarker && count > 0)) {
                if (!count) return finish_cell_marker(scanner, lexer, valid_symbols, consumed);
                scanner->body_line_start = true;
                lexer->result_symbol = CELL_BODY_CHUNK;
                return true;
            }
            count += consumed;
            line_start = false;
            lexer->mark_end(lexer);
            continue;
        }
        line_start = lexer->lookahead == '\r' || lexer->lookahead == '\n';
        advance(lexer);
        ++count;
        lexer->mark_end(lexer);
    }
    if (!count) return false;
    scanner->body_line_start = line_start;
    lexer->result_symbol = CELL_BODY_CHUNK;
    return true;
}

bool tree_sitter_ipython_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;

    bool error_recovery_mode = valid_symbols[STRING_CONTENT] && valid_symbols[INDENT];

    if (!error_recovery_mode && valid_symbols[CELL_HEADER_END]) {
        while (lexer->lookahead == ' ' || lexer->lookahead == '\t') advance(lexer);
        if (lexer->lookahead != '\r' && lexer->lookahead != '\n' && !lexer->eof(lexer)) return false;
        if (lexer->lookahead == '\r') advance(lexer);
        if (lexer->lookahead == '\n') advance(lexer);

        lexer->mark_end(lexer);
        scanner->body_line_start = true;
        lexer->result_symbol = CELL_HEADER_END;
        return true;
    }
    if (!error_recovery_mode && valid_symbols[CELL_BODY_CHUNK]) return scan_cell_body(scanner, lexer, valid_symbols);
    if (!error_recovery_mode && (valid_symbols[CODE_CELL_MARKER] || valid_symbols[MARKDOWN_CELL_MARKER] ||
         valid_symbols[RAW_CELL_MARKER]) && lexer->lookahead == '#') {
        if (scan_cell_marker(scanner, lexer, valid_symbols)) return true;
        if (!scanner->cell_start || !valid_symbols[COMMENT]) return false;
        while (lexer->lookahead && lexer->lookahead != '\r' && lexer->lookahead != '\n') advance(lexer);
        lexer->mark_end(lexer);
        scanner->cell_start = false;
        lexer->result_symbol = COMMENT;
        return true;
    }
    if (!error_recovery_mode && (valid_symbols[PYTHON_CELL_MAGIC] || valid_symbols[FOREIGN_CELL_MAGIC]) &&
        lexer->lookahead == '%') return scan_cell_magic(scanner, lexer, valid_symbols);
    if (!error_recovery_mode && scanner->cell_start && scanner->indents.size == 1 &&
        valid_symbols[COMMENT] && lexer->lookahead == '#' &&
        lexer->get_column(lexer) == 0) {
        while (lexer->lookahead && lexer->lookahead != '\r' && lexer->lookahead != '\n') advance(lexer);
        lexer->mark_end(lexer);
        scanner->cell_start = false;
        lexer->result_symbol = COMMENT;
        return true;
    }

    bool within_brackets = valid_symbols[CLOSE_BRACE] || valid_symbols[CLOSE_PAREN] || valid_symbols[CLOSE_BRACKET];

    bool advanced_once = false;
    if (valid_symbols[ESCAPE_INTERPOLATION] && scanner->delimiters.size > 0 &&
        (lexer->lookahead == '{' || lexer->lookahead == '}') && !error_recovery_mode) {
        Delimiter *delimiter = array_back(&scanner->delimiters);
        if (is_format(delimiter)) {
            lexer->mark_end(lexer);
            bool is_left_brace = lexer->lookahead == '{';
            advance(lexer);
            advanced_once = true;
            if ((lexer->lookahead == '{' && is_left_brace) || (lexer->lookahead == '}' && !is_left_brace)) {
                advance(lexer);
                lexer->mark_end(lexer);
                lexer->result_symbol = ESCAPE_INTERPOLATION;
                return true;
            }
            return false;
        }
    }

    if (valid_symbols[STRING_CONTENT] && scanner->delimiters.size > 0 && !error_recovery_mode) {
        Delimiter *delimiter = array_back(&scanner->delimiters);
        int32_t end_char = end_character(delimiter);
        bool has_content = advanced_once;
        while (lexer->lookahead) {
            if ((advanced_once || lexer->lookahead == '{' || lexer->lookahead == '}') && is_format(delimiter)) {
                lexer->mark_end(lexer);
                lexer->result_symbol = STRING_CONTENT;
                return has_content;
            }
            if (lexer->lookahead == '\\') {
                if (is_raw(delimiter)) {
                    // Step over the backslash.
                    advance(lexer);
                    // Step over any escaped quotes.
                    if (lexer->lookahead == end_character(delimiter) || lexer->lookahead == '\\') {
                        advance(lexer);
                    }
                    // Step over newlines
                    if (lexer->lookahead == '\r') {
                        advance(lexer);
                        if (lexer->lookahead == '\n') {
                            advance(lexer);
                        }
                    } else if (lexer->lookahead == '\n') {
                        advance(lexer);
                    }
                    continue;
                }
                if (is_bytes(delimiter)) {
                    lexer->mark_end(lexer);
                    advance(lexer);
                    if (lexer->lookahead == 'N' || lexer->lookahead == 'u' || lexer->lookahead == 'U') {
                        // In bytes string, \N{...}, \uXXXX and \UXXXXXXXX are
                        // not escape sequences
                        // https://docs.python.org/3/reference/lexical_analysis.html#string-and-bytes-literals
                        advance(lexer);
                    } else {
                        lexer->result_symbol = STRING_CONTENT;
                        return has_content;
                    }
                } else {
                    lexer->mark_end(lexer);
                    lexer->result_symbol = STRING_CONTENT;
                    return has_content;
                }
            } else if (lexer->lookahead == end_char) {
                if (is_triple(delimiter)) {
                    lexer->mark_end(lexer);
                    advance(lexer);
                    if (lexer->lookahead == end_char) {
                        advance(lexer);
                        if (lexer->lookahead == end_char) {
                            if (has_content) {
                                lexer->result_symbol = STRING_CONTENT;
                            } else {
                                advance(lexer);
                                lexer->mark_end(lexer);
                                array_pop(&scanner->delimiters);
                                lexer->result_symbol = STRING_END;
                                scanner->inside_interpolated_string = false;
                            }
                            return true;
                        }
                        lexer->mark_end(lexer);
                        lexer->result_symbol = STRING_CONTENT;
                        return true;
                    }
                    lexer->mark_end(lexer);
                    lexer->result_symbol = STRING_CONTENT;
                    return true;
                }
                if (has_content) {
                    lexer->result_symbol = STRING_CONTENT;
                } else {
                    advance(lexer);
                    array_pop(&scanner->delimiters);
                    lexer->result_symbol = STRING_END;
                    scanner->inside_interpolated_string = false;
                }
                lexer->mark_end(lexer);
                return true;

            } else if (lexer->lookahead == '\n' && has_content && !is_triple(delimiter)) {
                return false;
            }
            advance(lexer);
            has_content = true;
        }
    }

    lexer->mark_end(lexer);

    bool found_end_of_line = false;
    uint16_t indent_length = 0;
    int32_t first_comment_indent_length = -1;
    for (;;) {
        if (lexer->lookahead == '\n') {
            found_end_of_line = true;
            indent_length = 0;
            skip(lexer);
        } else if (lexer->lookahead == ' ') {
            indent_length++;
            skip(lexer);
        } else if (lexer->lookahead == '\r' || lexer->lookahead == '\f') {
            indent_length = 0;
            skip(lexer);
        } else if (lexer->lookahead == '\t') {
            indent_length += 8;
            skip(lexer);
        } else if (lexer->lookahead == '#' && indent_length == 0 && scanner->delimiters.size == 0 &&
                   (valid_symbols[CODE_CELL_MARKER] || valid_symbols[MARKDOWN_CELL_MARKER] || valid_symbols[RAW_CELL_MARKER])) {
            break;
        } else if (lexer->lookahead == '#' && (valid_symbols[INDENT] || valid_symbols[DEDENT] ||
                                               valid_symbols[NEWLINE] || valid_symbols[EXCEPT])) {
            // If we haven't found an EOL yet,
            // then this is a comment after an expression:
            //   foo = bar # comment
            // Just return, since we don't want to generate an indent/dedent
            // token.
            if (!found_end_of_line) {
                return false;
            }
            if (first_comment_indent_length == -1) {
                first_comment_indent_length = (int32_t)indent_length;
            }
            while (lexer->lookahead && lexer->lookahead != '\n') {
                skip(lexer);
            }
            skip(lexer);
            indent_length = 0;
        } else if (lexer->lookahead == '\\') {
            skip(lexer);
            if (lexer->lookahead == '\r') {
                skip(lexer);
            }
            if (lexer->lookahead == '\n' || lexer->eof(lexer)) {
                skip(lexer);
            } else {
                return false;
            }
        } else if (lexer->eof(lexer)) {
            indent_length = 0;
            found_end_of_line = true;
            break;
        } else {
            break;
        }
    }

    if (found_end_of_line) {
        if (scanner->indents.size > 0) {
            uint16_t current_indent_length = *array_back(&scanner->indents);

            if (valid_symbols[INDENT] && indent_length > current_indent_length) {
                array_push(&scanner->indents, indent_length);
                lexer->result_symbol = INDENT;
                return true;
            }

            bool next_tok_is_string_start =
                lexer->lookahead == '\"' || lexer->lookahead == '\'' || lexer->lookahead == '`';

            if ((valid_symbols[DEDENT] ||
                 (!valid_symbols[NEWLINE] && !(valid_symbols[STRING_START] && next_tok_is_string_start) &&
                  !within_brackets)) &&
                indent_length < current_indent_length && !scanner->inside_interpolated_string &&

                // Wait to create a dedent token until we've consumed any
                // comments
                // whose indentation matches the current block.
                first_comment_indent_length < (int32_t)current_indent_length) {
                array_pop(&scanner->indents);
                lexer->result_symbol = DEDENT;
                return true;
            }
        }

        if (valid_symbols[NEWLINE] && !error_recovery_mode) {
            lexer->result_symbol = NEWLINE;
            return true;
        }
    }

    if (!error_recovery_mode && lexer->lookahead == '#' &&
        (valid_symbols[CODE_CELL_MARKER] || valid_symbols[MARKDOWN_CELL_MARKER] || valid_symbols[RAW_CELL_MARKER])) {
        if (scan_cell_marker(scanner, lexer, valid_symbols)) return true;
        if (!scanner->cell_start || !valid_symbols[COMMENT]) return false;
        while (lexer->lookahead && lexer->lookahead != '\r' && lexer->lookahead != '\n') advance(lexer);
        lexer->mark_end(lexer);
        scanner->cell_start = false;
        lexer->result_symbol = COMMENT;
        return true;
    }
    if (!error_recovery_mode && lexer->lookahead == '%' &&
        (valid_symbols[PYTHON_CELL_MAGIC] || valid_symbols[FOREIGN_CELL_MAGIC])) {
        return scan_cell_magic(scanner, lexer, valid_symbols);
    }

    if (first_comment_indent_length == -1 && valid_symbols[STRING_START]) {
        Delimiter delimiter = new_delimiter();

        bool has_flags = false;
        while (lexer->lookahead) {
            if (lexer->lookahead == 'f' || lexer->lookahead == 'F' || lexer->lookahead == 't' ||
                lexer->lookahead == 'T') {
                set_format(&delimiter);
            } else if (lexer->lookahead == 'r' || lexer->lookahead == 'R') {
                set_raw(&delimiter);
            } else if (lexer->lookahead == 'b' || lexer->lookahead == 'B') {
                set_bytes(&delimiter);
            } else if (lexer->lookahead != 'u' && lexer->lookahead != 'U') {
                break;
            }
            has_flags = true;
            advance(lexer);
        }

        if (lexer->lookahead == '`') {
            set_end_character(&delimiter, '`');
            advance(lexer);
            lexer->mark_end(lexer);
        } else if (lexer->lookahead == '\'') {
            set_end_character(&delimiter, '\'');
            advance(lexer);
            lexer->mark_end(lexer);
            if (lexer->lookahead == '\'') {
                advance(lexer);
                if (lexer->lookahead == '\'') {
                    advance(lexer);
                    lexer->mark_end(lexer);
                    set_triple(&delimiter);
                }
            }
        } else if (lexer->lookahead == '"') {
            set_end_character(&delimiter, '"');
            advance(lexer);
            lexer->mark_end(lexer);
            if (lexer->lookahead == '"') {
                advance(lexer);
                if (lexer->lookahead == '"') {
                    advance(lexer);
                    lexer->mark_end(lexer);
                    set_triple(&delimiter);
                }
            }
        }

        if (end_character(&delimiter)) {
            array_push(&scanner->delimiters, delimiter);
            lexer->result_symbol = STRING_START;
            scanner->inside_interpolated_string = is_format(&delimiter);
            return true;
        }
        if (has_flags) {
            return false;
        }
    }

    return false;
}

unsigned tree_sitter_ipython_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;

    size_t size = 0;

    buffer[size++] = (char)scanner->inside_interpolated_string;
    buffer[size++] = (char)scanner->cell_start;
    buffer[size++] = (char)scanner->body_line_start;

    size_t delimiter_count = scanner->delimiters.size;
    if (delimiter_count > UINT8_MAX) {
        delimiter_count = UINT8_MAX;
    }
    buffer[size++] = (char)delimiter_count;

    if (delimiter_count > 0) {
        memcpy(&buffer[size], scanner->delimiters.contents, delimiter_count);
    }
    size += delimiter_count;

    uint32_t iter = 1;
    for (; iter < scanner->indents.size && size + 2 <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE; ++iter) {
        uint16_t indent_value = *array_get(&scanner->indents, iter);
        buffer[size++] = (char)(indent_value & 0xFF);
        buffer[size++] = (char)((indent_value >> 8) & 0xFF);
    }

    return size;
}

void tree_sitter_ipython_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;

    array_delete(&scanner->delimiters);
    array_delete(&scanner->indents);
    array_push(&scanner->indents, 0);
    scanner->cell_start = true;
    scanner->body_line_start = true;

    if (length > 0) {
        size_t size = 0;

        scanner->inside_interpolated_string = (bool)buffer[size++];
        scanner->cell_start = (bool)buffer[size++];
        scanner->body_line_start = (bool)buffer[size++];

        size_t delimiter_count = (uint8_t)buffer[size++];
        if (delimiter_count > 0) {
            array_reserve(&scanner->delimiters, delimiter_count);
            scanner->delimiters.size = delimiter_count;
            memcpy(scanner->delimiters.contents, &buffer[size], delimiter_count);
            size += delimiter_count;
        }

        for (; size + 1 < length; size += 2) {
            uint16_t indent_value = (unsigned char)buffer[size] | ((unsigned char)buffer[size + 1] << 8);
            array_push(&scanner->indents, indent_value);
        }
    }
}

void *tree_sitter_ipython_external_scanner_create() {
#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
    _Static_assert(sizeof(Delimiter) == sizeof(char), "");
#else
    assert(sizeof(Delimiter) == sizeof(char));
#endif
    Scanner *scanner = calloc(1, sizeof(Scanner));
    array_init(&scanner->indents);
    array_init(&scanner->delimiters);
    tree_sitter_ipython_external_scanner_deserialize(scanner, NULL, 0);
    return scanner;
}

void tree_sitter_ipython_external_scanner_destroy(void *payload) {
    Scanner *scanner = (Scanner *)payload;
    array_delete(&scanner->indents);
    array_delete(&scanner->delimiters);
    free(scanner);
}
