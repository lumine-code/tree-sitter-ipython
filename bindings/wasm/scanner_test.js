const path = require('node:path');
const { Parser, Language } = require('web-tree-sitter');
const regressions = require('../../test/scanner-regressions');

(async () => {
  await Parser.init();
  const language = await Language.load(path.resolve(__dirname, '../../tree-sitter-ipython.wasm'));
  regressions('WASM', () => new Parser().setLanguage(language));
})().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
