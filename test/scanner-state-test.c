#undef NDEBUG
#include <assert.h>
#include <string.h>
#include "../src/scanner.c"

typedef struct {
    TSLexer lexer;
    const char *source;
    size_t length, offset, token_end;
} TestLexer;

static void test_advance(TSLexer *lexer, bool skip) {
    (void)skip;
    TestLexer *test = (TestLexer *)lexer;
    if (test->offset < test->length) ++test->offset;
    lexer->lookahead = test->offset < test->length ? test->source[test->offset] : 0;
}
static void test_mark_end(TSLexer *lexer) {
    TestLexer *test = (TestLexer *)lexer;
    test->token_end = test->offset;
}
static bool test_eof(const TSLexer *lexer) {
    const TestLexer *test = (const TestLexer *)lexer;
    return test->offset == test->length;
}
static TestLexer test_lexer(const char *source) {
    TestLexer test = {0};
    test.source = source; test.length = strlen(source);
    test.lexer.lookahead = source[0]; test.lexer.advance = test_advance;
    test.lexer.mark_end = test_mark_end; test.lexer.eof = test_eof;
    return test;
}

static void valid_hash_tokens(const char *source) {
    const enum TokenType candidates[] = { PREFIX_HASH, MARKER_HASH, BODY_HASH, PYTHON_CHUNK, CELL_BODY_CHUNK };
    for (unsigned mask = 0; mask < 1u << (sizeof(candidates) / sizeof(candidates[0])); ++mask) {
        bool valid[DOCUMENT_END + 1] = {false};
        for (unsigned bit = 0; bit < sizeof(candidates) / sizeof(candidates[0]); ++bit)
            valid[candidates[bit]] = (mask & (1u << bit)) != 0;
        Scanner *scanner = tree_sitter_ipython_external_scanner_create();
        // Empty frame storage can retain old contents. The bounded prefix probe
        // must not modify them while restoring a shallow Scanner snapshot.
        Frame sentinel = { .flags = FORMAT | FIELD, .depth = 123 };
        array_push(&scanner->frames, sentinel); scanner->frames.size = 0;
        Frame *storage = scanner->frames.contents;
        TestLexer lexer = test_lexer(source);
        bool accepted = tree_sitter_ipython_external_scanner_scan(scanner, &lexer.lexer, valid);
        if (accepted) {
            assert(lexer.lexer.result_symbol <= DOCUMENT_END);
            assert(valid[lexer.lexer.result_symbol]);
            assert(lexer.offset <= CHUNK_LIMIT);
            if (lexer.lexer.result_symbol == PREFIX_HASH || lexer.lexer.result_symbol == MARKER_HASH || lexer.lexer.result_symbol == BODY_HASH) {
                assert(lexer.token_end == 1);
                assert(scanner->frames.contents == storage && scanner->frames.size == 0);
                assert(storage[0].flags == sentinel.flags && storage[0].depth == sentinel.depth);
            }
        }
        tree_sitter_ipython_external_scanner_destroy(scanner);
    }
    bool recovery[DOCUMENT_END + 1]; memset(recovery, 1, sizeof(recovery));
    Scanner *scanner = tree_sitter_ipython_external_scanner_create();
    TestLexer lexer = test_lexer(source);
    bool accepted = tree_sitter_ipython_external_scanner_scan(scanner, &lexer.lexer, recovery);
    assert(!accepted || recovery[lexer.lexer.result_symbol]);
    tree_sitter_ipython_external_scanner_destroy(scanner);
}

int main(void) {
    Scanner *scanner = tree_sitter_ipython_external_scanner_create();
    char created[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
    char encoded[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
    unsigned created_length = tree_sitter_ipython_external_scanner_serialize(scanner, created);
    for (unsigned length = 0; length <= 3; ++length) {
        scanner->recent_length = (uint8_t)length;
        scanner->recent[0] = 'r'; scanner->recent[1] = 'f';
        unsigned encoded_length = tree_sitter_ipython_external_scanner_serialize(scanner, encoded);
        assert(encoded_length == created_length);
        assert(encoded[4] == (length == 1 || length == 2 ? 'r' : 0));
        assert(encoded[5] == (length == 2 ? 'f' : 0));
        tree_sitter_ipython_external_scanner_deserialize(scanner, NULL, 0);
        encoded_length = tree_sitter_ipython_external_scanner_serialize(scanner, encoded);
        assert(encoded_length == created_length);
        assert(memcmp(encoded, created, created_length) == 0);
    }
    tree_sitter_ipython_external_scanner_destroy(scanner);
    valid_hash_tokens("# %% [raw]\n");
    valid_hash_tokens("#%%Code\n");
    valid_hash_tokens("# heading\n");
    valid_hash_tokens("# % ordinary\n");
    valid_hash_tokens("#");
    char long_prefix[CHUNK_LIMIT + 32];
    long_prefix[0] = '#'; memset(long_prefix + 1, ' ', CHUNK_LIMIT + 8);
    strcpy(long_prefix + CHUNK_LIMIT + 9, "%% [raw]\n");
    valid_hash_tokens(long_prefix);
    return 0;
}
