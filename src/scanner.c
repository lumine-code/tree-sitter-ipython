#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"
#include <stdint.h>
#include <assert.h>
#include <stdlib.h>
#include <string.h>

enum TokenType {
    PREFIX_HASH, MARKER_HASH, BODY_HASH, PREFIX_SPACE, PREFIX_PERCENT_START, PREFIX_PERCENT_MORE,
    HEADER_SPACE, TITLE_SPACE, TRAILING_SPACE, UNCERTAIN_SPACE,
    MARKDOWN_CELL_TYPE, RAW_CELL_TYPE, CODE_CELL_TYPE, HEADER_TITLE_CHUNK, CELL_HEADER_END,
    PYTHON_CELL_MAGIC, FOREIGN_CELL_MAGIC, MAGIC_NAME_CHUNK, ARGUMENTS_CHUNK,
    LINE_MAGIC_NAME_CHUNK, LINE_MAGIC_SPACE, LINE_MAGIC_ARGUMENTS_CHUNK, PYTHON_MAGIC_BODY_CHUNK,
    PADDING_CHUNK, PYTHON_CHUNK, CELL_BODY_CHUNK,
    MAGIC_STATEMENT_START, SHELL_STATEMENT_START, HELP_STATEMENT_START,
    MAGIC_EXPRESSION_START, SHELL_EXPRESSION_START, COMMAND_TAIL, HELP_PREFIX_CHUNK, HELP_SUFFIX, DOCUMENT_END,
};
enum { QUOTE_SINGLE = 1, QUOTE_DOUBLE = 2, TRIPLE = 4, RAW = 8, FORMAT = 16, FIELD = 32, FORMAT_SPEC = 64 };
enum { HEADER_NONE, HEADER_MARKER, HEADER_MAGIC };
enum { MAGIC_RAW, MAGIC_TIME, MAGIC_TIMEIT, MAGIC_PRUN, MAGIC_DEBUG, MAGIC_CONFIG };
enum { MAGIC_NONE, MAGIC_OPTIONS, MAGIC_ARGUMENTS, MAGIC_PYTHON };
enum { OPTION_NONE, OPTION_DASH, OPTION_SHORT, OPTION_LONG, OPTION_ATTACHED, OPTION_VALUE };
enum { HELP_WORD, HELP_DOT, HELP_INDEX, HELP_SIGN, HELP_DIGITS, HELP_AFTER_INDEX };
#define CHUNK_LIMIT 4096
#define OPAQUE_ROW_LIMIT 2048
#define SERIALIZED_HEADER_SIZE 58

typedef struct { uint8_t flags; uint32_t depth; } Frame;
typedef struct {
    Array(Frame) frames;
    uint32_t bracket_depth;
    int32_t previous;
    uint8_t header_kind, recent_length;
    char recent[2];
    bool line_start, cell_start, statement_start, rhs_ready, comment_line, continued_line;
    bool marker_prefix, command_tail, help_prefix, suite_colon, arguments_active, conservative;
    uint8_t magic_kind, magic_phase, option_mode, option_quote, option_length;
    char option_text[32];
    bool magic_name_active, option_pending, option_escape;
    bool command_backslash, command_cr;
    uint8_t help_state;
    uint16_t opaque_rows;
    bool opaque_cr;
} Scanner;

static bool horizontal(int32_t c) { return c == ' ' || c == '\t'; }
static bool newline(int32_t c) { return c == '\r' || c == '\n'; }
static bool alpha(int32_t c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; }
static bool identifier_start(int32_t c) { return alpha(c) || c >= 128; }
static bool digit(int32_t c) { return c >= '0' && c <= '9'; }
static bool help_start(int32_t c) { return identifier_start(c) || c == '*'; }
static bool magic_name(int32_t c) { return alpha(c) || (c >= '0' && c <= '9') || c == '!'; }
static bool outside(Scanner *s) { return !s->frames.size && !s->conservative; }
static bool boundary(Scanner *s) { return s->line_start && outside(s) && !s->bracket_depth && !s->continued_line; }
static void take(Scanner *s, TSLexer *lexer, uint32_t *count) {
    int32_t c = lexer->lookahead;
    lexer->advance(lexer, false);
    ++*count;
    s->line_start = newline(c);
}
static void recent(Scanner *s, int32_t c) {
    if (alpha(c)) {
        if (s->recent_length < 2) s->recent[s->recent_length] = (char)c;
        if (s->recent_length < 3) ++s->recent_length;
    } else s->recent_length = 0;
}
static uint8_t string_flags(Scanner *s, int32_t quote) {
    uint8_t flags = quote == '\'' ? QUOTE_SINGLE : QUOTE_DOUBLE;
    if (s->recent_length <= 2) {
        for (uint8_t i = 0; i < s->recent_length; i++) {
            if (s->recent[i] == 'f' || s->recent[i] == 'F') flags |= FORMAT;
            if (s->recent[i] == 'r' || s->recent[i] == 'R') flags |= RAW;
        }
    }
    s->recent_length = 0;
    return flags;
}
static bool suite_keyword(const char *word) {
    return !strcmp(word, "if") || !strcmp(word, "elif") || !strcmp(word, "else") ||
        !strcmp(word, "for") || !strcmp(word, "while") || !strcmp(word, "with") ||
        !strcmp(word, "try") || !strcmp(word, "except") || !strcmp(word, "finally") ||
        !strcmp(word, "def") || !strcmp(word, "class") || !strcmp(word, "async") ||
        !strcmp(word, "match") || !strcmp(word, "case");
}
// Lexical state only: no Python expressions, statements or indentation grammar.
static void python_character(Scanner *s, TSLexer *lexer, uint32_t *count) {
    int32_t c = lexer->lookahead;
    Frame *frame = s->frames.size ? array_back(&s->frames) : NULL;
    if (s->comment_line) {
        take(s, lexer, count);
        if (newline(c)) {
            s->comment_line = false; s->continued_line = false;
            s->statement_start = outside(s) && !s->bracket_depth;
            s->rhs_ready = false; s->suite_colon = false;
        }
        return;
    }
    if (frame && !(frame->flags & FIELD)) {
        int32_t quote = frame->flags & QUOTE_SINGLE ? '\'' : '"';
        if (c == '\\') {
            take(s, lexer, count);
            if (!lexer->eof(lexer) && !((frame->flags & FORMAT) && (lexer->lookahead == '{' || lexer->lookahead == '}'))) {
                int32_t escaped = lexer->lookahead; take(s, lexer, count);
                if (escaped == '\r' && lexer->lookahead == '\n') take(s, lexer, count);
            }
            return;
        }
        if (c == quote) {
            take(s, lexer, count);
            if (!(frame->flags & TRIPLE)) { array_pop(&s->frames); return; }
            if (lexer->lookahead == quote) {
                take(s, lexer, count);
                if (lexer->lookahead == quote) { take(s, lexer, count); array_pop(&s->frames); }
            }
            return;
        }
        if ((frame->flags & FORMAT) && c == '{') {
            take(s, lexer, count);
            if (lexer->lookahead == '{') take(s, lexer, count);
            else array_push(&s->frames, ((Frame){ .flags = FIELD }));
            return;
        }
        if ((frame->flags & FORMAT) && c == '}') {
            take(s, lexer, count);
            if (lexer->lookahead == '}') take(s, lexer, count);
            return;
        }
        if (newline(c) && !(frame->flags & TRIPLE)) array_pop(&s->frames);
        take(s, lexer, count);
        return;
    }
    if (frame && (frame->flags & FORMAT_SPEC)) {
        take(s, lexer, count);
        if (c == '{') array_push(&s->frames, ((Frame){ .flags = FIELD }));
        else if (c == '}') array_pop(&s->frames);
        return;
    }
    if (c == '\'' || c == '"') {
        uint8_t flags = string_flags(s, c);
        take(s, lexer, count);
        if (lexer->lookahead == c) {
            take(s, lexer, count);
            if (lexer->lookahead != c) return; // Empty string.
            take(s, lexer, count); flags |= TRIPLE;
        }
        array_push(&s->frames, ((Frame){ .flags = flags }));
        s->cell_start = false; s->statement_start = false; s->rhs_ready = false;
        return;
    }
    if (c == '#') {
        s->comment_line = true; s->cell_start = false; s->statement_start = false; s->rhs_ready = false;
        take(s, lexer, count); return;
    }
    if (c == '\\') {
        take(s, lexer, count);
        if (newline(lexer->lookahead)) {
            int32_t ending = lexer->lookahead; take(s, lexer, count);
            if (ending == '\r' && lexer->lookahead == '\n') take(s, lexer, count);
            s->continued_line = true; s->statement_start = false; s->rhs_ready = false;
        }
        s->recent_length = 0; s->cell_start = false; return;
    }
    if (newline(c)) {
        take(s, lexer, count); s->continued_line = false;
        s->statement_start = outside(s) && !s->bracket_depth;
        s->rhs_ready = false; s->help_prefix = false; s->suite_colon = false; s->recent_length = 0;
        s->previous = 0; return;
    }
    if (horizontal(c) || c == '\f') { take(s, lexer, count); s->recent_length = 0; return; }
    uint32_t *depth = frame ? &frame->depth : &s->bracket_depth;
    if (c == '(' || c == '[' || c == '{') ++*depth;
    else if (c == ')' || c == ']' || c == '}') {
        if (frame && c == '}' && !frame->depth) { take(s, lexer, count); array_pop(&s->frames); return; }
        if (*depth) --*depth;
    }
    if (frame && c == ':' && !frame->depth) frame->flags |= FORMAT_SPEC;
    bool top = outside(s) && !s->bracket_depth;
    if (top && c == ';') { s->statement_start = true; s->rhs_ready = false; s->suite_colon = false; }
    else if (top && c == ':' && s->suite_colon) { s->statement_start = true; s->rhs_ready = false; s->suite_colon = false; }
    else {
        s->statement_start = false;
        s->rhs_ready = top && c == '=' && s->previous != '=' && s->previous != ':' &&
            s->previous != '!' && s->previous != '<' && s->previous != '>' &&
            s->previous != '+' && s->previous != '-' && s->previous != '*' &&
            s->previous != '/' && s->previous != '%' && s->previous != '&' &&
            s->previous != '|' && s->previous != '^';
    }
    s->cell_start = false; s->previous = c; recent(s, c); take(s, lexer, count);
    if (c == '=' && lexer->lookahead == '=') s->rhs_ready = false;
}
static bool finish(TSLexer *lexer, enum TokenType type, uint32_t count) {
    if (!count) return false;
    lexer->mark_end(lexer); lexer->result_symbol = type; return true;
}
static bool line_chunk(Scanner *s, TSLexer *lexer, enum TokenType type, uint32_t count, bool spaces) {
    while (!lexer->eof(lexer) && count < CHUNK_LIMIT &&
        (spaces ? horizontal(lexer->lookahead) : !newline(lexer->lookahead))) take(s, lexer, &count);
    return finish(lexer, type, count);
}
// Command spans follow logical lines. Retain the last physical character even
// at a chunk boundary, including a CRLF split between two external tokens.
static bool logical_end(Scanner *s, TSLexer *lexer) {
    return newline(lexer->lookahead) &&
        (s->header_kind == HEADER_MAGIC || (!s->command_backslash && !(s->command_cr && lexer->lookahead == '\n')));
}
static void command_character(Scanner *s, TSLexer *lexer, uint32_t *count) {
    int32_t c = lexer->lookahead;
    s->command_cr = c == '\r' && s->command_backslash;
    s->command_backslash = c == '\\';
    take(s, lexer, count);
}
static bool command_chunk(Scanner *s, TSLexer *lexer, enum TokenType type, uint32_t count) {
    while (!lexer->eof(lexer) && count < CHUNK_LIMIT && !logical_end(s, lexer)) command_character(s, lexer, &count);
    return finish(lexer, type, count);
}
// Probe a help target without an unbounded lookahead or a second Python parser.
// On a non-help path the consumed brackets/recent characters are ordinary
// Python lexical state, so malformed and unfinished subscripts recover there.
static bool help_character(Scanner *s, TSLexer *lexer, uint32_t *count) {
    int32_t c = lexer->lookahead;
    switch (s->help_state) {
        case HELP_WORD:
            if (identifier_start(c) || digit(c) || c == '*') break;
            if (c == '.') { s->help_state = HELP_DOT; break; }
            if (c == '[') { s->help_state = HELP_INDEX; ++s->bracket_depth; break; }
            return false;
        case HELP_DOT:
            if (!help_start(c)) return false;
            s->help_state = HELP_WORD; break;
        case HELP_INDEX:
            if (c == '-') s->help_state = HELP_SIGN;
            else if (digit(c)) s->help_state = HELP_DIGITS;
            else return false;
            break;
        case HELP_SIGN:
            if (!digit(c)) return false;
            s->help_state = HELP_DIGITS; break;
        case HELP_DIGITS:
            if (digit(c)) break;
            if (c != ']') return false;
            s->help_state = HELP_AFTER_INDEX;
            if (s->bracket_depth) --s->bracket_depth;
            break;
        case HELP_AFTER_INDEX:
            if (c == '.') { s->help_state = HELP_DOT; break; }
            if (c == '[') { s->help_state = HELP_INDEX; ++s->bracket_depth; break; }
            return false;
        default: return false;
    }
    recent(s, c); s->previous = c; take(s, lexer, count); return true;
}
static bool help_complete(Scanner *s) { return s->help_state == HELP_WORD || s->help_state == HELP_AFTER_INDEX; }
static bool header_space(Scanner *s, TSLexer *lexer, const bool *valid) {
    uint32_t count = 0;
    while (horizontal(lexer->lookahead) && count < CHUNK_LIMIT) take(s, lexer, &count);
    enum TokenType type;
    if (horizontal(lexer->lookahead) && valid[UNCERTAIN_SPACE]) type = UNCERTAIN_SPACE;
    else if ((lexer->eof(lexer) || newline(lexer->lookahead)) && valid[TRAILING_SPACE]) type = TRAILING_SPACE;
    else if (valid[TITLE_SPACE]) type = TITLE_SPACE;
    else type = valid[HEADER_SPACE] ? HEADER_SPACE : UNCERTAIN_SPACE;
    return finish(lexer, type, count);
}
static bool title_chunk(Scanner *s, TSLexer *lexer, uint32_t count) {
    while (!lexer->eof(lexer) && count < CHUNK_LIMIT && !horizontal(lexer->lookahead) && !newline(lexer->lookahead))
        take(s, lexer, &count);
    return finish(lexer, HEADER_TITLE_CHUNK, count);
}
static bool header_type(Scanner *s, TSLexer *lexer, const bool *valid) {
    char text[16] = {0}; uint32_t count = 0;
    while (count < sizeof(text)-1 && lexer->lookahead > 0 && lexer->lookahead < 128 && !lexer->eof(lexer) &&
        !horizontal(lexer->lookahead) && !newline(lexer->lookahead)) {
        text[count] = (char)lexer->lookahead; take(s, lexer, &count);
    }
    enum TokenType type = HEADER_TITLE_CHUNK;
    if (lexer->eof(lexer) || horizontal(lexer->lookahead) || newline(lexer->lookahead)) {
        if (!strcmp(text, "[markdown]") || !strcmp(text, "[md]")) type = MARKDOWN_CELL_TYPE;
        else if (!strcmp(text, "[raw]")) type = RAW_CELL_TYPE;
        else if (!strcmp(text, "[code]")) type = CODE_CELL_TYPE;
    }
    if (type != HEADER_TITLE_CHUNK && valid[type]) return finish(lexer, type, count);
    return valid[HEADER_TITLE_CHUNK] && title_chunk(s, lexer, count);
}
static bool python_magic_name(const char *name) {
    return !strcmp(name, "time") || !strcmp(name, "timeit") || !strcmp(name, "prun") ||
        !strcmp(name, "debug") || !strcmp(name, "capture") || !strcmp(name, "code_wrap") ||
        !strcmp(name, "python") || !strcmp(name, "python2") || !strcmp(name, "python3") || !strcmp(name, "pypy");
}
static uint8_t magic_kind(const char *name, bool cell) {
    if (!strcmp(name, "timeit")) return MAGIC_TIMEIT;
    if (!strcmp(name, "prun")) return MAGIC_PRUN;
    if (!strcmp(name, "debug")) return MAGIC_DEBUG;
    if (!cell && !strcmp(name, "time")) return MAGIC_TIME;
    if (!cell && !strcmp(name, "config")) return MAGIC_CONFIG;
    return MAGIC_RAW;
}
static void begin_magic(Scanner *s, const char *name, bool cell) {
    s->magic_kind = magic_kind(name, cell);
    s->magic_phase = s->magic_kind == MAGIC_RAW ? MAGIC_ARGUMENTS : MAGIC_OPTIONS;
    s->magic_name_active = true; s->arguments_active = false;
    s->option_mode = OPTION_NONE; s->option_pending = s->option_escape = false;
    s->option_quote = s->option_length = 0; memset(s->option_text, 0, sizeof(s->option_text));
    s->cell_start = false; s->statement_start = false; s->rhs_ready = false;
    s->command_tail = false; s->help_prefix = false; s->recent_length = 0;
    s->command_backslash = s->command_cr = false;
}
static void probe_magic_name(TSLexer *lexer, char *name, size_t size) {
    uint32_t length = 0;
    while (length < size - 1 && magic_name(lexer->lookahead)) {
        name[length++] = (char)lexer->lookahead; lexer->advance(lexer, false);
    }
    // A longer/custom name cannot inherit the meaning of a built-in prefix.
    if (magic_name(lexer->lookahead)) { name[0] = '\1'; name[1] = 0; }
}
static bool line_magic_start(Scanner *s, TSLexer *lexer, enum TokenType type) {
    uint32_t count = 0; take(s, lexer, &count); lexer->mark_end(lexer);
    char name[32] = {0}; probe_magic_name(lexer, name, sizeof(name));
    begin_magic(s, name, false); lexer->result_symbol = type; return true;
}
static bool cell_magic(Scanner *s, TSLexer *lexer, const bool *valid) {
    if (!s->cell_start || !boundary(s) || lexer->lookahead != '%') return false;
    uint32_t count = 0; take(s, lexer, &count);
    if (lexer->lookahead != '%') {
        if (!valid[MAGIC_STATEMENT_START]) return false;
        lexer->mark_end(lexer);
        char name[32] = {0}; probe_magic_name(lexer, name, sizeof(name));
        begin_magic(s, name, false); lexer->result_symbol = MAGIC_STATEMENT_START; return true;
    }
    take(s, lexer, &count); lexer->mark_end(lexer);
    char name[32] = {0}; probe_magic_name(lexer, name, sizeof(name));
    enum TokenType type = python_magic_name(name) ? PYTHON_CELL_MAGIC : FOREIGN_CELL_MAGIC;
    if (!name[0] || !valid[type]) {
        // The marker prefix was consumed, but is an ordinary line magic here.
        if (!valid[MAGIC_STATEMENT_START]) return false;
        begin_magic(s, "", false); lexer->result_symbol = MAGIC_STATEMENT_START; return true;
    }
    begin_magic(s, name, true); s->header_kind = HEADER_MAGIC;
    lexer->result_symbol = type; return true;
}
static bool short_option(Scanner *s, int32_t c, bool *value) {
    *value = s->magic_kind == MAGIC_TIMEIT ? c == 'n' || c == 'r' || c == 'p' || c == 'v' :
        s->magic_kind == MAGIC_PRUN ? c == 'D' || c == 'l' || c == 's' || c == 'T' :
        s->magic_kind == MAGIC_DEBUG && c == 'b';
    return *value || (s->magic_kind == MAGIC_TIMEIT && (c == 't' || c == 'c' || c == 'q' || c == 'o')) ||
        (s->magic_kind == MAGIC_PRUN && (c == 'r' || c == 'q'));
}
static bool breakpoint_option(const char *name, uint8_t length) {
    const char *expected = "breakpoint";
    if (!length || length > 10) return false;
    for (uint8_t i = 0; i < length; ++i) if (name[i] != expected[i]) return false;
    return true;
}
static bool long_option(Scanner *s, bool attached) {
    if (s->magic_kind == MAGIC_TIME && !strcmp(s->option_text, "no-raise-error") && !attached) {
        s->option_pending = false; return true;
    }
    if (s->magic_kind == MAGIC_DEBUG && breakpoint_option(s->option_text, s->option_length)) {
        s->option_pending = true; return true;
    }
    return false;
}
static void finish_option(Scanner *s) {
    if (s->option_mode == OPTION_LONG) {
        if (!s->option_length) { s->magic_phase = MAGIC_PYTHON; s->option_pending = false; }
        else if (!long_option(s, false)) s->magic_phase = MAGIC_ARGUMENTS;
    } else if (s->option_mode == OPTION_DASH) {
        // A lone dash is ambiguous; keep the tail opaque instead of treating
        // an unfinished option as executable Python.
        s->magic_phase = MAGIC_ARGUMENTS;
    }
    if (s->option_quote || s->option_escape) s->magic_phase = MAGIC_ARGUMENTS;
    s->option_mode = OPTION_NONE; s->option_quote = s->option_length = 0;
    s->option_escape = false; memset(s->option_text, 0, sizeof(s->option_text));
}
static void option_character(Scanner *s, int32_t c) {
    switch (s->option_mode) {
        case OPTION_DASH:
            if (c == '-') { s->option_mode = OPTION_LONG; return; }
            s->option_mode = OPTION_SHORT;
            // Fall through: the character following '-' is its first flag.
        case OPTION_SHORT: {
            bool value = false;
            if (!short_option(s, c, &value)) { s->magic_phase = MAGIC_ARGUMENTS; return; }
            if (value) { s->option_mode = OPTION_ATTACHED; s->option_pending = true; }
            return;
        }
        case OPTION_LONG:
            if (c == '=') {
                if (!long_option(s, true)) { s->magic_phase = MAGIC_ARGUMENTS; return; }
                s->option_mode = OPTION_ATTACHED; return;
            }
            if (c <= 0 || c >= 128 || s->option_length >= sizeof(s->option_text)-1) { s->magic_phase = MAGIC_ARGUMENTS; return; }
            s->option_text[s->option_length++] = (char)c; return;
        case OPTION_ATTACHED:
        case OPTION_VALUE:
            s->option_pending = false;
            if (s->option_escape) { s->option_escape = false; return; }
            if (c == '\\' && s->option_quote != '\'') { s->option_escape = true; return; }
            if (s->option_quote) { if (c == s->option_quote) s->option_quote = 0; return; }
            if (c == '\'' || c == '"') s->option_quote = (uint8_t)c;
            return;
        default: return;
    }
}
static bool magic_arguments(Scanner *s, TSLexer *lexer, enum TokenType type, bool python_valid) {
    if (s->magic_phase != MAGIC_OPTIONS && s->magic_phase != MAGIC_ARGUMENTS) return false;
    if (!s->arguments_active && horizontal(lexer->lookahead)) return false;
    uint32_t count = 0;
    if (s->magic_kind == MAGIC_TIME && s->magic_phase == MAGIC_OPTIONS && lexer->lookahead == '-') {
        // %time recognizes just this prefix. A leading unary minus belongs
        // to its Python statement, unlike getopt-based magic arguments.
        const char *option = "--no-raise-error";
        while (option[count] && lexer->lookahead == option[count]) take(s, lexer, &count);
        bool matched = !option[count] && (horizontal(lexer->lookahead) || newline(lexer->lookahead) || lexer->eof(lexer));
        s->magic_phase = MAGIC_PYTHON;
        if (!matched) return python_valid && command_chunk(s, lexer, PYTHON_MAGIC_BODY_CHUNK, count);
        s->magic_phase = MAGIC_OPTIONS;
        s->arguments_active = true;
        while (horizontal(lexer->lookahead) && count < CHUNK_LIMIT) take(s, lexer, &count);
        return finish(lexer, type, count);
    }
    while (!lexer->eof(lexer) && !logical_end(s, lexer) && count < CHUNK_LIMIT) {
        if (newline(lexer->lookahead)) {
            command_character(s, lexer, &count);
            s->option_escape = false;
            continue;
        }
        if (s->magic_phase == MAGIC_ARGUMENTS) { command_character(s, lexer, &count); continue; }
        if (s->magic_phase == MAGIC_PYTHON) {
            if (horizontal(lexer->lookahead)) { command_character(s, lexer, &count); continue; }
            break;
        }
        if (lexer->lookahead == '\\' && s->header_kind != HEADER_MAGIC) {
            // Line joining removes this pair before option parsing. It must
            // not satisfy a pending value or turn a separator into code.
            Scanner saved = *s; uint32_t before = count; lexer->mark_end(lexer);
            command_character(s, lexer, &count);
            if (newline(lexer->lookahead)) continue;
            if (s->option_mode != OPTION_NONE) { option_character(s, '\\'); continue; }
            if (!before) { s->magic_phase = MAGIC_PYTHON; return python_valid && command_chunk(s, lexer, PYTHON_MAGIC_BODY_CHUNK, count); }
            *s = saved; s->magic_phase = MAGIC_PYTHON; s->arguments_active = true;
            lexer->result_symbol = type; return true;
        }
        if (s->option_mode == OPTION_NONE) {
            if (horizontal(lexer->lookahead)) { command_character(s, lexer, &count); continue; }
            if (s->option_pending) s->option_mode = OPTION_VALUE;
            else if (lexer->lookahead == '-' && s->magic_kind != MAGIC_CONFIG) {
                if (s->magic_kind == MAGIC_DEBUG) {
                    // This bounded probe must fit even after a giant gap.
                    if (count && CHUNK_LIMIT - count < 13) break;
                    Scanner saved = *s; uint32_t before = count; lexer->mark_end(lexer);
                    take(s, lexer, &count);
                    bool known = lexer->lookahead == 'b';
                    if (lexer->lookahead == '-') {
                        take(s, lexer, &count);
                        while (s->option_length < 11 && !lexer->eof(lexer) && !newline(lexer->lookahead) &&
                            !horizontal(lexer->lookahead) && lexer->lookahead != '=') {
                            s->option_text[s->option_length++] = lexer->lookahead < 128 ? (char)lexer->lookahead : '\1';
                            take(s, lexer, &count);
                        }
                        bool delimited = lexer->eof(lexer) || newline(lexer->lookahead) ||
                            horizontal(lexer->lookahead) || lexer->lookahead == '=';
                        known = delimited && (breakpoint_option(s->option_text, s->option_length) ||
                            (!s->option_length && lexer->lookahead != '='));
                        s->option_mode = OPTION_LONG;
                    } else s->option_mode = OPTION_DASH;
                    if (!known) {
                        // Partial argparse parsing leaves unknown options as
                        // code, including unary '-' and double unary '--'.
                        s->magic_phase = MAGIC_PYTHON;
                        s->option_mode = OPTION_NONE; s->option_length = 0;
                        memset(s->option_text, 0, sizeof(s->option_text));
                        if (!before) return python_valid && command_chunk(s, lexer, PYTHON_MAGIC_BODY_CHUNK, count);
                        *s = saved; s->magic_phase = MAGIC_PYTHON; s->arguments_active = true;
                        lexer->result_symbol = type; return true;
                    }
                    continue;
                }
                s->option_mode = OPTION_DASH; command_character(s, lexer, &count); continue;
            } else { s->magic_phase = MAGIC_PYTHON; break; }
        }
        if (horizontal(lexer->lookahead) && !s->option_quote && !s->option_escape) {
            finish_option(s);
            continue;
        }
        option_character(s, lexer->lookahead); command_character(s, lexer, &count);
    }
    if (lexer->eof(lexer) || logical_end(s, lexer)) finish_option(s);
    if (!count) return false;
    s->arguments_active = true; return finish(lexer, type, count);
}
static bool special_here(Scanner *s, int32_t c) {
    if (!outside(s) || s->bracket_depth || s->comment_line || s->continued_line) return false;
    return (s->statement_start && (c == '%' || c == '!' || c == '?' || help_start(c))) ||
        (s->rhs_ready && (c == '%' || c == '!')) || (s->help_prefix && c == '?') ||
        (boundary(s) && c == '#');
}
static bool python_chunk(Scanner *s, TSLexer *lexer, const bool *valid) {
    uint32_t count = 0;
    while (!lexer->eof(lexer) && count < CHUNK_LIMIT) {
        // Most column-zero comments are ordinary Python. Resolve a short
        // prefix inside this multi-row chunk instead of creating three
        // tokens and a speculative cell-header branch for every comment.
        if (boundary(s) && lexer->lookahead == '#') {
            Scanner saved = *s;
            uint32_t probe = 0;
            lexer->mark_end(lexer);
            take(s, lexer, &probe);
            if (!count) lexer->mark_end(lexer); // Shared prefix token is just '#'.
            while (horizontal(lexer->lookahead) && count + probe < CHUNK_LIMIT)
                take(s, lexer, &probe);
            bool possible = horizontal(lexer->lookahead);
            if (lexer->lookahead == '%') {
                if (count + probe == CHUNK_LIMIT) possible = true;
                else {
                    take(s, lexer, &probe);
                    possible = lexer->lookahead == '%';
                }
            }
            if (possible) {
                *s = saved;
                if (count) { lexer->result_symbol = PYTHON_CHUNK; return true; }
                s->line_start = false; s->marker_prefix = true; s->comment_line = true;
                s->statement_start = false; s->cell_start = false; s->rhs_ready = false;
                enum TokenType type = probe < CHUNK_LIMIT && lexer->lookahead == '%' ? MARKER_HASH : PREFIX_HASH;
                if (!valid[type]) { *s = saved; return false; }
                lexer->result_symbol = type; return true;
            }
            count += probe;
            s->marker_prefix = false; s->comment_line = true; s->cell_start = false;
            s->statement_start = false; s->rhs_ready = false; s->help_prefix = false;
            continue;
        }
        // A normal first word needs no scaffold token. Only a suffix-help
        // candidate, or an unfinished giant name, uses the shared prefix rule.
        if (outside(s) && !s->bracket_depth && !s->comment_line && !s->continued_line &&
            s->statement_start && help_start(lexer->lookahead)) {
            Scanner saved = *s;
            uint32_t probe = 0; char word[16] = {0};
            lexer->mark_end(lexer);
            s->help_state = HELP_WORD;
            while (!lexer->eof(lexer) && count + probe < CHUNK_LIMIT) {
                int32_t c = lexer->lookahead; uint32_t before = probe;
                if (!help_character(s, lexer, &probe)) break;
                if (before < sizeof(word)-1 && c > 0 && c < 128) word[before] = (char)c;
            }
            if ((lexer->lookahead == '?' && help_complete(s)) || count + probe == CHUNK_LIMIT) {
                if (count) { *s = saved; lexer->result_symbol = PYTHON_CHUNK; return true; }
                s->help_prefix = true; s->cell_start = false; s->statement_start = false; s->rhs_ready = false;
                if (!valid[HELP_PREFIX_CHUNK]) { s->help_prefix = false; return finish(lexer, PYTHON_CHUNK, probe); }
                return finish(lexer, HELP_PREFIX_CHUNK, probe);
            }
            count += probe;
            s->suite_colon = probe < sizeof(word) && suite_keyword(word);
            s->cell_start = false; s->statement_start = false; s->rhs_ready = false; s->help_prefix = false;
            continue;
        }
        if (special_here(s, lexer->lookahead)) break;
        if (count && CHUNK_LIMIT - count < 3 &&
            (lexer->lookahead == '\'' || lexer->lookahead == '"' || lexer->lookahead == '\\' ||
             lexer->lookahead == '{' || lexer->lookahead == '}')) break;
        s->help_prefix = false;
        python_character(s, lexer, &count);
    }
    return finish(lexer, PYTHON_CHUNK, count);
}
static bool identifier_prefix(Scanner *s, TSLexer *lexer) {
    uint32_t count = 0; char word[16] = {0}; bool first = s->statement_start;
    while (!lexer->eof(lexer) && count < CHUNK_LIMIT) {
        int32_t c = lexer->lookahead; uint32_t before = count;
        if (!help_character(s, lexer, &count)) break;
        if (before < sizeof(word)-1 && c > 0 && c < 128) word[before] = (char)c;
    }
    if (first) s->suite_colon = count < sizeof(word) && suite_keyword(word);
    s->help_prefix = true; s->cell_start = false; s->statement_start = false; s->rhs_ready = false;
    return finish(lexer, HELP_PREFIX_CHUNK, count);
}
static void opaque_character(Scanner *s, TSLexer *lexer, uint32_t *count) {
    int32_t c = lexer->lookahead;
    if (c == '\r' || (c == '\n' && !s->opaque_cr)) {
        if (++s->opaque_rows == OPAQUE_ROW_LIMIT) s->opaque_rows = 0;
    }
    s->opaque_cr = c == '\r';
    take(s, lexer, count);
}
static bool opaque_chunk(Scanner *s, TSLexer *lexer, const bool *valid) {
    uint32_t count = 0;
    while (!lexer->eof(lexer) && count < CHUNK_LIMIT) {
        if (s->line_start && lexer->lookahead == '#') {
            Scanner saved = *s; uint32_t probe = 0;
            lexer->mark_end(lexer);
            opaque_character(s, lexer, &probe);
            if (!count) lexer->mark_end(lexer);
            while (horizontal(lexer->lookahead) && count + probe < CHUNK_LIMIT) opaque_character(s, lexer, &probe);
            bool possible = horizontal(lexer->lookahead);
            if (lexer->lookahead == '%') {
                if (count + probe == CHUNK_LIMIT) possible = true;
                else { opaque_character(s, lexer, &probe); possible = lexer->lookahead == '%'; }
            }
            if (possible) {
                *s = saved;
                if (count) { s->opaque_rows = 0; lexer->result_symbol = CELL_BODY_CHUNK; return true; }
                enum TokenType type = probe < CHUNK_LIMIT && lexer->lookahead == '%' ? MARKER_HASH : PREFIX_HASH;
                if (!valid[type]) return false;
                s->line_start = false; s->marker_prefix = true;
                s->opaque_cr = false;
                s->comment_line = true; s->statement_start = s->cell_start = s->rhs_ready = false;
                lexer->result_symbol = type; return true;
            }
            count += probe;
            s->marker_prefix = false;
            continue;
        }
        int32_t c = lexer->lookahead;
        opaque_character(s, lexer, &count);
        // Fixed codepoint boundaries alone drift after every insertion. A
        // periodic physical-row anchor survives ordinary character edits,
        // while retaining the hard token limit for arbitrarily long rows.
        if (!s->opaque_rows && newline(c) && !(c == '\r' && lexer->lookahead == '\n')) break;
    }
    // A complete physical-row boundary is a neutral phase. Besides improving
    // scanner-state reuse, this retains the pre-existing fast path when a
    // joined row makes the hash probe finish just before the next row.
    if (s->line_start && !(s->opaque_cr && lexer->lookahead == '\n')) s->opaque_rows = 0;
    return finish(lexer, CELL_BODY_CHUNK, count);
}
bool tree_sitter_ipython_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid) {
    Scanner *s = payload;
    if (valid[DOCUMENT_END] && lexer->eof(lexer)) { lexer->result_symbol = DOCUMENT_END; return true; }
    if (s->magic_name_active && !magic_name(lexer->lookahead)) {
        s->magic_name_active = false;
        s->help_prefix = lexer->lookahead == '?'; s->help_state = HELP_WORD;
    }
    if (s->magic_name_active && (valid[MAGIC_NAME_CHUNK] || valid[LINE_MAGIC_NAME_CHUNK]) && magic_name(lexer->lookahead)) {
        uint32_t count = 0;
        while (magic_name(lexer->lookahead) && count < CHUNK_LIMIT) take(s, lexer, &count);
        if (!magic_name(lexer->lookahead)) {
            s->magic_name_active = false;
            s->help_prefix = lexer->lookahead == '?'; s->help_state = HELP_WORD;
        }
        return finish(lexer, valid[LINE_MAGIC_NAME_CHUNK] ? LINE_MAGIC_NAME_CHUNK : MAGIC_NAME_CHUNK, count);
    }
    if (s->help_prefix && valid[HELP_SUFFIX] && lexer->lookahead == '?' && help_complete(s)) {
        uint32_t count = 0; take(s, lexer, &count);
        if (lexer->lookahead == '?') take(s, lexer, &count);
        s->help_prefix = false; s->magic_phase = MAGIC_NONE; s->header_kind = HEADER_NONE;
        s->magic_name_active = s->arguments_active = s->command_backslash = s->command_cr = false;
        return finish(lexer, HELP_SUFFIX, count);
    }
    if (s->help_prefix && s->magic_phase == MAGIC_NONE && valid[HELP_PREFIX_CHUNK]) {
        Scanner saved = *s;
        if (identifier_prefix(s, lexer)) return true;
        *s = saved; s->help_prefix = false;
    }
    if (!s->magic_name_active && (valid[ARGUMENTS_CHUNK] || valid[LINE_MAGIC_ARGUMENTS_CHUNK]) &&
        !logical_end(s, lexer) && !lexer->eof(lexer) &&
        magic_arguments(s, lexer, valid[LINE_MAGIC_ARGUMENTS_CHUNK] ? LINE_MAGIC_ARGUMENTS_CHUNK : ARGUMENTS_CHUNK,
            valid[PYTHON_MAGIC_BODY_CHUNK])) return true;
    if (!s->magic_name_active && valid[PYTHON_MAGIC_BODY_CHUNK] && s->magic_phase == MAGIC_PYTHON &&
        !logical_end(s, lexer) && !lexer->eof(lexer)) {
        return command_chunk(s, lexer, PYTHON_MAGIC_BODY_CHUNK, 0);
    }
    if (valid[LINE_MAGIC_SPACE] && s->magic_phase != MAGIC_NONE && !s->arguments_active && horizontal(lexer->lookahead))
        return line_chunk(s, lexer, LINE_MAGIC_SPACE, 0, true);
    if (valid[COMMAND_TAIL] && s->command_tail && !logical_end(s, lexer) && !lexer->eof(lexer))
        return command_chunk(s, lexer, COMMAND_TAIL, 0);
    if (logical_end(s, lexer) || lexer->eof(lexer)) {
        s->command_tail = false; s->magic_phase = MAGIC_NONE; s->magic_kind = MAGIC_RAW;
        s->magic_name_active = s->arguments_active = s->option_pending = s->option_escape = false;
        s->option_mode = s->option_quote = s->option_length = 0; memset(s->option_text, 0, sizeof(s->option_text));
        s->command_backslash = s->command_cr = false;
    }
    if (valid[PREFIX_SPACE] && s->marker_prefix && horizontal(lexer->lookahead))
        return line_chunk(s, lexer, PREFIX_SPACE, 0, true);
    if (s->marker_prefix && lexer->lookahead == '%') {
        uint32_t count = 0; take(s, lexer, &count);
        if (lexer->lookahead == '%') {
            if (!valid[PREFIX_PERCENT_START]) return false;
            take(s, lexer, &count); s->marker_prefix = false; s->header_kind = HEADER_MARKER;
            s->comment_line = false; return finish(lexer, PREFIX_PERCENT_START, count);
        }
        s->marker_prefix = false;
        if (valid[CELL_BODY_CHUNK]) return line_chunk(s, lexer, CELL_BODY_CHUNK, count, false);
        if (valid[PYTHON_CHUNK]) return line_chunk(s, lexer, PYTHON_CHUNK, count, false);
        return false;
    }
    if (s->marker_prefix && !horizontal(lexer->lookahead)) s->marker_prefix = false;
    if (valid[PREFIX_PERCENT_MORE] && lexer->lookahead == '%') {
        uint32_t count = 0;
        while (lexer->lookahead == '%' && count < CHUNK_LIMIT) take(s, lexer, &count);
        return finish(lexer, PREFIX_PERCENT_MORE, count);
    }
    if ((valid[HEADER_SPACE] || valid[TITLE_SPACE] || valid[TRAILING_SPACE] || valid[UNCERTAIN_SPACE]) && horizontal(lexer->lookahead))
        return header_space(s, lexer, valid);
    if ((valid[MARKDOWN_CELL_TYPE] || valid[RAW_CELL_TYPE] || valid[CODE_CELL_TYPE]) && lexer->lookahead == '[')
        return header_type(s, lexer, valid);
    if (valid[HEADER_TITLE_CHUNK] && !horizontal(lexer->lookahead) && !newline(lexer->lookahead) && !lexer->eof(lexer))
        return title_chunk(s, lexer, 0);
    if (valid[CELL_HEADER_END] && (newline(lexer->lookahead) || lexer->eof(lexer))) {
        uint32_t count = 0;
        if (lexer->lookahead == '\r') take(s, lexer, &count);
        if (lexer->lookahead == '\n') take(s, lexer, &count);
        s->line_start = true; s->cell_start = s->header_kind != HEADER_MAGIC;
        s->statement_start = true; s->rhs_ready = false; s->comment_line = false; s->continued_line = false;
        s->marker_prefix = false; s->arguments_active = false; s->header_kind = HEADER_NONE;
        s->bracket_depth = 0; s->frames.size = 0; s->recent_length = 0; s->help_prefix = false; s->suite_colon = false;
        s->opaque_rows = 0; s->opaque_cr = false;
        lexer->mark_end(lexer); lexer->result_symbol = CELL_HEADER_END; return true;
    }
    if (valid[CELL_BODY_CHUNK]) return opaque_chunk(s, lexer, valid);
    if (valid[PYTHON_CHUNK] && boundary(s) && lexer->lookahead == '#') return python_chunk(s, lexer, valid);
    if ((valid[PREFIX_HASH] || valid[MARKER_HASH] || valid[BODY_HASH]) && lexer->lookahead == '#' &&
        ((valid[CELL_BODY_CHUNK] && s->line_start) || boundary(s))) {
        Scanner before = *s;
        uint32_t count = 0; take(s, lexer, &count); lexer->mark_end(lexer);
        Scanner saved = *s;
        while (horizontal(lexer->lookahead) && count < CHUNK_LIMIT) take(s, lexer, &count);
        bool uncertain = count == CHUNK_LIMIT;
        bool known_marker = false;
        if (!uncertain && lexer->lookahead == '%') {
            take(s, lexer, &count);
            known_marker = lexer->lookahead == '%';
            uncertain = count == CHUNK_LIMIT && !known_marker;
        }
        *s = saved;
        s->marker_prefix = true; s->comment_line = true; s->statement_start = false; s->cell_start = false;
        enum TokenType type = known_marker ? MARKER_HASH : uncertain ? PREFIX_HASH : BODY_HASH;
        if (!valid[type]) { *s = before; return false; }
        lexer->result_symbol = type;
        return true;
    }
    if (valid[CELL_BODY_CHUNK]) return false;
    if (valid[PADDING_CHUNK] && s->cell_start && (horizontal(lexer->lookahead) || newline(lexer->lookahead) || lexer->lookahead == '\f')) {
        uint32_t count = 0;
        while (count < CHUNK_LIMIT && !lexer->eof(lexer) &&
            (horizontal(lexer->lookahead) || newline(lexer->lookahead) || lexer->lookahead == '\f')) {
            take(s, lexer, &count);
        }
        return finish(lexer, PADDING_CHUNK, count);
    }
    if ((valid[PYTHON_CELL_MAGIC] || valid[FOREIGN_CELL_MAGIC]) && s->cell_start && boundary(s) && lexer->lookahead == '%')
        return cell_magic(s, lexer, valid);
    if (outside(s) && !s->bracket_depth && !s->comment_line && !s->continued_line) {
        if ((s->statement_start || s->rhs_ready) && (lexer->lookahead == '%' || lexer->lookahead == '!' || (s->statement_start && lexer->lookahead == '?'))) {
            enum TokenType type = lexer->lookahead == '%' ? (s->rhs_ready ? MAGIC_EXPRESSION_START : MAGIC_STATEMENT_START) :
                lexer->lookahead == '!' ? (s->rhs_ready ? SHELL_EXPRESSION_START : SHELL_STATEMENT_START) : HELP_STATEMENT_START;
            if (!valid[type]) return false;
            if (lexer->lookahead == '%') return line_magic_start(s, lexer, type);
            s->cell_start = false; s->statement_start = false; s->rhs_ready = false; s->command_tail = true; s->help_prefix = false;
            s->command_backslash = s->command_cr = false;
            return command_chunk(s, lexer, type, 0);
        }
        if (s->statement_start && valid[PYTHON_CHUNK] && help_start(lexer->lookahead)) return python_chunk(s, lexer, valid);
    }
    if (valid[PYTHON_CHUNK]) return python_chunk(s, lexer, valid);
    return false;
}
void *tree_sitter_ipython_external_scanner_create(void) {
    Scanner *s = calloc(1, sizeof(Scanner)); assert(s); array_init(&s->frames);
    s->line_start = s->cell_start = s->statement_start = true; return s;
}
void tree_sitter_ipython_external_scanner_destroy(void *payload) {
    Scanner *s = payload; array_delete(&s->frames); free(s);
}
static unsigned write_u32(char *buffer, unsigned offset, uint32_t value) {
    memcpy(buffer + offset, &value, sizeof(value)); return offset + sizeof(value);
}
static uint32_t read_u32(const char *buffer, unsigned *offset) {
    uint32_t value; memcpy(&value, buffer + *offset, sizeof(value)); *offset += sizeof(value); return value;
}
unsigned tree_sitter_ipython_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *s = payload;
    uint32_t flags = s->line_start | (s->cell_start << 1) | (s->statement_start << 2) | (s->rhs_ready << 3) |
        (s->comment_line << 4) | (s->continued_line << 5) | (s->marker_prefix << 6) | (s->command_tail << 7) |
        (s->help_prefix << 8) | (s->suite_colon << 9) | (s->arguments_active << 10) | (s->conservative << 11) |
        (s->magic_name_active << 12) | (s->option_pending << 13) | (s->option_escape << 14) |
        (s->command_backslash << 15) | (s->command_cr << 16) | (s->opaque_cr << 17);
    unsigned offset = write_u32(buffer, 0, flags);
    buffer[offset++] = s->header_kind; buffer[offset++] = s->recent_length;
    buffer[offset++] = s->recent_length == 1 || s->recent_length == 2 ? s->recent[0] : 0;
    buffer[offset++] = s->recent_length == 2 ? s->recent[1] : 0;
    buffer[offset++] = s->magic_kind; buffer[offset++] = s->magic_phase; buffer[offset++] = s->option_mode;
    buffer[offset++] = s->option_quote; buffer[offset++] = s->option_length;
    memcpy(buffer + offset, s->option_text, sizeof(s->option_text)); offset += sizeof(s->option_text);
    offset = write_u32(buffer, offset, s->bracket_depth); offset = write_u32(buffer, offset, (uint32_t)s->previous);
    buffer[offset++] = s->help_prefix ? s->help_state : HELP_WORD;
    memcpy(buffer + offset, &s->opaque_rows, 2); offset += 2;
    unsigned count_offset = offset; offset += 2; uint16_t count = 0;
    for (uint32_t i = 0; i < s->frames.size; i++) {
        Frame frame = s->frames.contents[i]; unsigned width = 1 + ((frame.flags & FIELD) ? 4 : 0);
        if (offset + width > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
            flags |= 1 << 11; write_u32(buffer, 0, flags); break;
        }
        buffer[offset++] = (char)frame.flags;
        if (frame.flags & FIELD) offset = write_u32(buffer, offset, frame.depth);
        ++count;
    }
    memcpy(buffer + count_offset, &count, 2); return offset;
}
static bool valid_serialized_state(const char *buffer, unsigned length) {
    if (!buffer || length < SERIALIZED_HEADER_SIZE || length > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) return false;
    if ((uint8_t)buffer[4] > HEADER_MAGIC || (uint8_t)buffer[5] > 3 ||
        (uint8_t)buffer[8] > MAGIC_CONFIG || (uint8_t)buffer[9] > MAGIC_PYTHON ||
        (uint8_t)buffer[10] > OPTION_VALUE || (uint8_t)buffer[12] >= 32 ||
        buffer[44] || (uint8_t)buffer[53] > HELP_AFTER_INDEX) return false;
    uint16_t rows; memcpy(&rows, buffer + 54, 2);
    if (rows >= OPAQUE_ROW_LIMIT) return false;
    uint16_t count; memcpy(&count, buffer + SERIALIZED_HEADER_SIZE - 2, 2);
    unsigned offset = SERIALIZED_HEADER_SIZE;
    for (uint16_t i = 0; i < count; ++i) {
        if (offset >= length) return false;
        uint8_t flags = (uint8_t)buffer[offset++];
        if (flags & 128) return false;
        if (flags & FIELD) offset += 4;
        if (offset > length) return false;
    }
    return offset == length;
}
void tree_sitter_ipython_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *s = payload; s->frames.size = 0; s->bracket_depth = 0; s->previous = 0;
    s->header_kind = HEADER_NONE; s->recent_length = 0; s->recent[0] = s->recent[1] = 0;
    s->line_start = s->cell_start = s->statement_start = true;
    s->rhs_ready = s->comment_line = s->continued_line = s->marker_prefix = s->command_tail = false;
    s->help_prefix = s->suite_colon = s->arguments_active = s->conservative = false;
    s->magic_kind = MAGIC_RAW; s->magic_phase = MAGIC_NONE; s->magic_name_active = s->option_pending = s->option_escape = false;
    s->option_mode = s->option_quote = s->option_length = 0; memset(s->option_text, 0, sizeof(s->option_text));
    s->command_backslash = s->command_cr = false; s->help_state = HELP_WORD;
    s->opaque_rows = 0; s->opaque_cr = false;
    if (!length) return;
    if (!valid_serialized_state(buffer, length)) return;
    unsigned offset = 0; uint32_t flags = read_u32(buffer, &offset);
    s->line_start = flags & 1; s->cell_start = flags & 2; s->statement_start = flags & 4; s->rhs_ready = flags & 8;
    s->comment_line = flags & 16; s->continued_line = flags & 32; s->marker_prefix = flags & 64; s->command_tail = flags & 128;
    s->help_prefix = flags & 256; s->suite_colon = flags & 512; s->arguments_active = flags & 1024; s->conservative = flags & 2048;
    s->magic_name_active = flags & 4096; s->option_pending = flags & 8192; s->option_escape = flags & 16384;
    s->command_backslash = flags & 32768; s->command_cr = flags & 65536;
    s->opaque_cr = flags & 131072;
    s->header_kind = buffer[offset++]; s->recent_length = buffer[offset++];
    s->recent[0] = buffer[offset++]; s->recent[1] = buffer[offset++];
    s->magic_kind = buffer[offset++]; s->magic_phase = buffer[offset++]; s->option_mode = buffer[offset++];
    s->option_quote = buffer[offset++]; s->option_length = buffer[offset++];
    memcpy(s->option_text, buffer + offset, sizeof(s->option_text)); offset += sizeof(s->option_text);
    s->bracket_depth = read_u32(buffer, &offset); s->previous = (int32_t)read_u32(buffer, &offset);
    s->help_state = buffer[offset++];
    memcpy(&s->opaque_rows, buffer + offset, 2); offset += 2;
    uint16_t count; memcpy(&count, buffer + offset, 2); offset += 2;
    for (uint16_t i = 0; i < count && offset < length; i++) {
        Frame frame = { .flags = (uint8_t)buffer[offset++] };
        if (frame.flags & FIELD) { if (offset + 4 > length) break; frame.depth = read_u32(buffer, &offset); }
        array_push(&s->frames, frame);
    }
}
