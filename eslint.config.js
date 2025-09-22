/* eslint-disable @typescript-eslint/no-require-imports */
const globals = require("globals");
const tseslint = require("typescript-eslint");

module.exports = [
  { 
    files: ["src/**/*.{js,mjs,cjs,ts,mts,cts}", "examples/**/*.{js,mjs,cjs,ts,mts,cts}"], 
    languageOptions: { globals: globals.browser }
  },
  {
    ignores: ["dist/**", "node_modules/**", "**/*.d.ts", "**/*.js"]
  },
  ...tseslint.configs.recommended,
];
