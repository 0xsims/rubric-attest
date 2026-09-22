import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    // Repo root == $HOME in this environment; keep ESLint to project sources.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      ".claude/**",
      ".cache/**",
      ".config/**",
      ".local/**",
      ".npm/**",
      ".npm-global/**",
      "audit/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.{ts,mts,cts}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
