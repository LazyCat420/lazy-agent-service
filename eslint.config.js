import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";
import { createServiceEslintConfig } from "@rodrigo-barraza/utilities-library/eslint";

/**
 * Local quality rules layered on top of the shared service config.
 * The shared config (utilities-library) ships style rules only; these add the
 * maintainability ratchets: McCabe complexity, nesting depth, params and
 * function length. Thresholds start at the current worst offender (cx 30) and
 * are ratcheted down as Phase 2 decomposition lands.
 */
const qualityRules = {
  files: ["src/**/*.ts"],
  ignores: ["src/**/__tests__/**"],
  rules: {
    complexity: ["warn", 30],
    "max-depth": ["warn", 5],
    "max-params": ["warn", 6],
    "max-lines-per-function": ["warn", { max: 150, skipBlankLines: true, skipComments: true }],
  },
};

export default [
  ...createServiceEslintConfig({ javascript: js, typescriptEslint: tseslint, prettierConfig, globals }),
  qualityRules,
];
