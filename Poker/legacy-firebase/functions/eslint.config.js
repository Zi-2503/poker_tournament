const js = require("@eslint/js");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs" },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "max-len": "off"
    }
  }
];
