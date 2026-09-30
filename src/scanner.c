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
    CLOSE_PAREN,
    CLOSE_BRACKET,
    CLOSE_BRACE,
    EXCEPT,
    PREFIX_HASH,
    PREFIX_SPACE,
    PREFIX_PERCENT_START,
    PREFIX_PERCENT_MORE,
    HEADER_SPACE,
    MARKDOWN_CELL_TYPE,
    RAW_CELL_TYPE,
    CODE_CELL_TYPE,
    HEADER_TITLE_CHUNK,
    COMMENT_BODY_CHUNK,
    COMMENT_END,
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
    bool marker_prefix;
} Scanner;

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

// Every new opaque/header token consumes at most this many code points.
// Prefixes continue through hidden tokens instead of imposing a syntax limit.
#define CELL_CHUNK_LIMIT 4096

static bool horizontal_space(int32_t c) { return c == ' ' || c == '\t'; }

static bool scan_chunk(TSLexer *lexer, enum TokenType type, uint32_t consumed, bool spaces) {
    while (!lexer->eof(lexer) && consumed < CELL_CHUNK_LIMIT &&
           (spaces ? horizontal_space(lexer->lookahead) :
                     lexer->lookahead != '\r' && lexer->lookahead != '\n')) {
        advance(lexer);
        ++consumed;
    }
    if (!consumed) return false;
    lexer->mark_end(lexer);
    lexer->result_symbol = type;
    return true;
}

static bool scan_prefix_hash(Scanner *scanner, TSLexer *lexer, bool line_start) {
    if (lexer->lookahead != '#') return false;
    scanner->marker_prefix = line_start && scanner->delimiters.size == 0 && scanner->indents.size == 1;
    scanner->body_line_start = false;
    advance(lexer);
    lexer->mark_end(lexer);
    lexer->result_symbol = PREFIX_HASH;
    return true;
}

static bool scan_title_chunk(TSLexer *lexer, uint32_t consumed) {
    while (!lexer->eof(lexer) && consumed < CELL_CHUNK_LIMIT && !horizontal_space(lexer->lookahead) &&
           lexer->lookahead != '\r' && lexer->lookahead != '\n') {
        advance(lexer);
        ++consumed;
    }
    if (!consumed) return false;
    lexer->mark_end(lexer);
    lexer->result_symbol = HEADER_TITLE_CHUNK;
    return true;
}

static bool scan_header_type(TSLexer *lexer, const bool *valid_symbols) {
    char metadata[16] = {0};
    uint32_t length = 0;
    while (length < sizeof(metadata) - 1 && lexer->lookahead &&
           !horizontal_space(lexer->lookahead) && lexer->lookahead != '\r' && lexer->lookahead != '\n') {
        if (lexer->lookahead > 127) break;
        metadata[length++] = (char)lexer->lookahead;
        advance(lexer);
    }
    bool delimited = lexer->eof(lexer) || horizontal_space(lexer->lookahead) ||
                     lexer->lookahead == '\r' || lexer->lookahead == '\n';
    enum TokenType type = HEADER_TITLE_CHUNK;
    if (delimited) {
        if (!strcmp(metadata, "[markdown]") || !strcmp(metadata, "[md]")) type = MARKDOWN_CELL_TYPE;
        else if (!strcmp(metadata, "[raw]")) type = RAW_CELL_TYPE;
        else if (!strcmp(metadata, "[code]")) type = CODE_CELL_TYPE;
    }
    if (type != HEADER_TITLE_CHUNK && valid_symbols[type]) {
        lexer->mark_end(lexer);
        lexer->result_symbol = type;
        return true;
    }
    return valid_symbols[HEADER_TITLE_CHUNK] && scan_title_chunk(lexer, length);
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

static bool scan_cell_body(Scanner *scanner, TSLexer *lexer) {
    uint32_t count = 0;
    bool line_start = scanner->body_line_start;
    while (!lexer->eof(lexer) && count < CELL_CHUNK_LIMIT) {
        if (line_start && lexer->lookahead == '#') {
            if (!count) return scan_prefix_hash(scanner, lexer, true);
            break;
        }
        line_start = lexer->lookahead == '\r' || lexer->lookahead == '\n';
        advance(lexer);
        ++count;
    }
    if (!count) return false;
    lexer->mark_end(lexer);
    scanner->body_line_start = line_start;
    scanner->marker_prefix = false;
    lexer->result_symbol = CELL_BODY_CHUNK;
    return true;
}

static bool scan_cell_tokens(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    if (valid_symbols[PREFIX_SPACE] && horizontal_space(lexer->lookahead))
        return scan_chunk(lexer, PREFIX_SPACE, 0, true);
    if (valid_symbols[PREFIX_PERCENT_START] && scanner->marker_prefix && lexer->lookahead == '%') {
        advance(lexer);
        if (lexer->lookahead == '%') {
            advance(lexer);
            lexer->mark_end(lexer);
            scanner->cell_start = true;
            scanner->marker_prefix = false;
            lexer->result_symbol = PREFIX_PERCENT_START;
            return true;
        }
        scanner->marker_prefix = false;
        if (valid_symbols[CELL_BODY_CHUNK]) return scan_chunk(lexer, CELL_BODY_CHUNK, 1, false);
        if (valid_symbols[COMMENT_BODY_CHUNK]) return scan_chunk(lexer, COMMENT_BODY_CHUNK, 1, false);
        return false;
    }
    if (scanner->marker_prefix && lexer->lookahead == '%' &&
        (valid_symbols[CELL_BODY_CHUNK] || valid_symbols[COMMENT_BODY_CHUNK])) {
        advance(lexer);
        if (lexer->lookahead == '%') return false;
        scanner->marker_prefix = false;
        return scan_chunk(lexer, valid_symbols[CELL_BODY_CHUNK] ? CELL_BODY_CHUNK : COMMENT_BODY_CHUNK, 1, false);
    }
    if (valid_symbols[PREFIX_PERCENT_MORE] && lexer->lookahead == '%') {
        uint32_t count = 0;
        while (lexer->lookahead == '%' && count < CELL_CHUNK_LIMIT) {
            advance(lexer);
            ++count;
        }
        lexer->mark_end(lexer);
        lexer->result_symbol = PREFIX_PERCENT_MORE;
        return true;
    }
    if (valid_symbols[HEADER_SPACE] && horizontal_space(lexer->lookahead))
        return scan_chunk(lexer, HEADER_SPACE, 0, true);
    if ((valid_symbols[MARKDOWN_CELL_TYPE] || valid_symbols[RAW_CELL_TYPE] || valid_symbols[CODE_CELL_TYPE]) &&
        lexer->lookahead == '[') return scan_header_type(lexer, valid_symbols);
    if (valid_symbols[HEADER_TITLE_CHUNK] && !horizontal_space(lexer->lookahead) &&
        lexer->lookahead != '\r' && lexer->lookahead != '\n' && !lexer->eof(lexer))
        return scan_title_chunk(lexer, 0);
    if (valid_symbols[CELL_HEADER_END] &&
        (lexer->lookahead == '\r' || lexer->lookahead == '\n' || lexer->eof(lexer))) {
        if (lexer->lookahead == '\r') advance(lexer);
        if (lexer->lookahead == '\n') advance(lexer);
        lexer->mark_end(lexer);
        scanner->body_line_start = true;
        scanner->marker_prefix = false;
        lexer->result_symbol = CELL_HEADER_END;
        return true;
    }
    if (valid_symbols[CELL_BODY_CHUNK]) return scan_cell_body(scanner, lexer);
    if (valid_symbols[COMMENT_END] &&
        (lexer->lookahead == '\r' || lexer->lookahead == '\n' || lexer->eof(lexer))) {
        scanner->cell_start = false;
        scanner->marker_prefix = false;
        lexer->result_symbol = COMMENT_END;
        return true;
    }
    if (valid_symbols[COMMENT_BODY_CHUNK]) {
        scanner->marker_prefix = false;
        return scan_chunk(lexer, COMMENT_BODY_CHUNK, 0, false);
    }
    return false;
}

bool tree_sitter_ipython_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;
    bool error_recovery_mode = valid_symbols[STRING_CONTENT] && valid_symbols[INDENT];
    if (!error_recovery_mode && scan_cell_tokens(scanner, lexer, valid_symbols)) return true;
    if (!error_recovery_mode && valid_symbols[PREFIX_HASH] && lexer->lookahead == '#')
        return scan_prefix_hash(scanner, lexer, lexer->get_column(lexer) == 0);
    if (!error_recovery_mode && (valid_symbols[PYTHON_CELL_MAGIC] || valid_symbols[FOREIGN_CELL_MAGIC]) &&
        lexer->lookahead == '%') return scan_cell_magic(scanner, lexer, valid_symbols);

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
                   valid_symbols[PREFIX_HASH]) {
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

    if (!error_recovery_mode && valid_symbols[PREFIX_HASH] && lexer->lookahead == '#')
        return scan_prefix_hash(scanner, lexer, lexer->get_column(lexer) == 0);
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
    buffer[size++] = (char)scanner->marker_prefix;

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
    scanner->marker_prefix = false;

    if (length > 0) {
        size_t size = 0;

        scanner->inside_interpolated_string = (bool)buffer[size++];
        scanner->cell_start = (bool)buffer[size++];
        scanner->body_line_start = (bool)buffer[size++];
        scanner->marker_prefix = (bool)buffer[size++];

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
