import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginUnusedImports from "eslint-plugin-unused-imports";

export default [
  {
    // Global ignores: other worktrees, coverage reports and Playwright output.
    ignores: [
      ".worktrees/**",
      "**/coverage/**",
      "test-results/**",
      "playwright-report/**",
      "blob-report/**",
      "playwright/.cache/**",
      // Desktop launcher build output and the downloaded cloudflared binaries.
      "desktop/out/**",
      "desktop/build/**",
      "desktop/dist/**",
      "desktop/dist-renderer/**",
      "desktop/resources/**",
    ],
  },
  {
    files: [
      "src/components/**/*.{js,mjs,cjs,jsx}",
      "src/pages/**/*.{js,mjs,cjs,jsx}",
      "src/Layout.jsx",
      "tests/ui/**/*.jsx",
      "desktop/src/renderer/**/*.{js,jsx}",
      "desktop/test/renderer/**/*.jsx",
    ],
    ignores: ["src/components/ui/**/*"],
    ...pluginJs.configs.recommended,
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      "no-unused-vars": "off",
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": [
        "error",
        { ignore: ["cmdk-input-wrapper", "toast-close"] },
      ],
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    // Plain JS modules: API client, shared logic, hooks, tests, e2e specs and repo scripts.
    files: [
      "shared/**/*.js",
      "src/api/**/*.js",
      "src/lib/**/*.js",
      "shared/**/*.js",
      "src/hooks/**/*.js",
      "tests/**/*.js",
      "e2e/**/*.js",
      "scripts/**/*.{js,mjs}",
      "playwright.config.js",
    ],
    // utils.js is the shadcn-generated helper.
    ignores: ["src/lib/utils.js"],
    ...pluginJs.configs.recommended,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
  },
  {
    // Desktop launcher: the Electron main process, its tests and build scripts
    // run on Node. The renderer is covered by the React block above.
    files: [
      "desktop/src/main/**/*.{js,mjs}",
      "desktop/test/**/*.{js,mjs}",
      "desktop/scripts/**/*.{js,mjs}",
      "desktop/*.{js,mjs}",
    ],
    ...pluginJs.configs.recommended,
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
  },
  {
    // The launcher's CommonJS files: the preload script and the IPC channel list it shares
    // with the main process.
    files: ["desktop/src/preload/**/*.cjs", "desktop/src/shared/**/*.cjs"],
    ...pluginJs.configs.recommended,
    languageOptions: {
      globals: globals.node,
      sourceType: "commonjs",
      parserOptions: {
        ecmaVersion: 2022,
      },
    },
  },
];
