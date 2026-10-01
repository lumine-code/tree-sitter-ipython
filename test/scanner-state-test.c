#undef NDEBUG
#include <assert.h>
#include <string.h>
#include "../src/scanner.c"

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
    return 0;
}
