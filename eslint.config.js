import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-plugin-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import perfectionist from "eslint-plugin-perfectionist";

export default tseslint.config(
  { ignores: ["dist", "jest.config.ts", "vite.config.ts"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      prettier: prettier,
      "react-hooks": reactHooks,
      perfectionist: perfectionist,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "prettier/prettier": "error",
      "react-hooks/exhaustive-deps": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/interface-name-prefix": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "perfectionist/sort-maps": [
        "error",
        { order: "asc", type: "line-length" },
      ],
      "perfectionist/sort-enums": [
        "error",
        { order: "asc", type: "line-length" },
      ],
      "perfectionist/sort-exports": [
        "error",
        { order: "asc", type: "line-length" },
      ],
      "perfectionist/sort-objects": [
        "error",
        { order: "asc", type: "line-length" },
      ],
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "perfectionist/sort-jsx-props": [
        "error",
        { order: "asc", type: "line-length" },
      ],
      "perfectionist/sort-interfaces": [
        "error",
        { order: "asc", type: "line-length" },
      ],
      "perfectionist/sort-union-types": [
        "error",
        { order: "asc", type: "line-length" },
      ],
      "perfectionist/sort-object-types": [
        "error",
        { order: "asc", type: "line-length" },
      ],
      "perfectionist/sort-named-imports": [
        "error",
        { order: "asc", type: "line-length" },
      ],
      "perfectionist/sort-named-exports": [
        "error",
        { order: "asc", type: "line-length" },
      ],
      "perfectionist/sort-array-includes": [
        "error",
        { order: "asc", type: "line-length" },
      ],
      "perfectionist/sort-imports": [
        "error",
        {
          order: "asc",
          type: "line-length",
          internalPattern: ["^~/"],
          newlinesBetween: "always",
          groups: [
            "type",
            ["react", "builtin", "external"],
            ["internal", "parent", "sibling", "index"],
          ],
          customGroups: {
            type: {
              react: ["^react$", "^react-."],
            },
            value: {
              lodash: "lodash",
              react: ["^react$", "^react-."],
            },
          },
        },
      ],
    },
  }
);
