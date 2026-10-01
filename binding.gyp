{
  "targets": [
    {
      "target_name": "tree_sitter_ipython_binding",
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except",
      ],
      "include_dirs": [
        "src",
      ],
      "sources": [
        "bindings/node/binding.cc",
        "src/parser.c",
      ],
      "variables": {
        "has_scanner": "<!(node -p \"fs.existsSync('src/scanner.c')\")"
      },
      "conditions": [
        ["has_scanner=='true'", {
          "sources+": ["src/scanner.c"],
        }],
        ["OS!='win'", {
          "cflags_c": [
            "-std=c11",
          ],
        }, { # OS == "win"
          "cflags_c": [
            "/std:c11",
            "/utf-8",
          ],
        }],
      ],
    },
    {
      "target_name": "scanner_state_test",
      "type": "executable",
      "include_dirs": ["src"],
      "sources": ["test/scanner-state-test.c"],
      "conditions": [["OS!='win'", {"cflags_c": ["-std=c11"]}, {"cflags_c": ["/std:c11", "/utf-8"]}]],
    }
  ]
}
