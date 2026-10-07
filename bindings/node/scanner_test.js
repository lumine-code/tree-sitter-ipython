const Parser = require('tree-sitter');
const language = require('.');
require('../../test/scanner-regressions')('native', () => new Parser().setLanguage(language));
