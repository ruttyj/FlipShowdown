import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginUnusedImports from "eslint-plugin-unused-imports";

// --- Server layer rule -------------------------------------------------------------------
// server/src is layered top to bottom: compose, entry, handlers, logic, data, base. Imports may
// only go down (proposals.html A1, A2). ESLint's core no-restricted-imports can't resolve
// paths, so each pattern is a regex on the import string that matches a layer folder as a whole
// path segment: "../gameActions/roomTx.js" matches (^|/)gameActions/, but
// "../../../shared/realtimeProtocol.js" doesn't match (^|/)realtime/. Folders that don't
// exist yet are listed so the rule is ready when they arrive. Dynamic import() isn't checked.

// The compose layer builds the server: app.js, index.js and providers/ (the App container and
// the providers). Nothing below it may import them.
const COMPOSE_IMPORTS = {
  // app.js and index.js sit in server/src itself, so a layer folder imports them as
  // "../app.js". No folder below server/src has an index.js that a child folder imports.
  regex: "(^|/)providers/|(^|/)app\\.js$|^(\\.\\./)+index\\.js$",
  message: "Only the compose layer may import app.js, index.js or providers/.",
};

const ENTRY_IMPORTS = {
  regex: "(^|/)(http|realtime)/",
  message: "Lower layers may not import the entry layer (http, realtime).",
};

const HANDLER_IMPORTS = {
  regex: "(^|/)(actions|gameActions)/",
  message: "Logic, data and base layers may not import handlers (actions, gameActions).",
};

// gameActions/ sits outside the layers: it holds only the test-facing adapters (the old function
// API that tests import by path), so no production file may import it, whatever its layer.
const GAME_ACTIONS_IMPORTS = {
  regex: "(^|/)gameActions/",
  message: "gameActions/ is test-facing adapters only; production code uses actions/ and services/.",
};

const LOGIC_IMPORTS = {
  regex: "(^|/)(services|managers)/",
  message: "Data and base layers may not import logic (services, managers).",
};

const DATA_IMPORTS = {
  regex: "(^|/)(repositories|database)/",
  message: "The base layer may not import data (repositories, database).",
};

// The store facade (database/db.js: openStore, openDatabase) is the tests' API. Production code
// reads and writes through the repositories, which DatabaseProvider hands out; only providers/
// (which opens the store) and database/ itself may import db.js. database/'s own files import it
// as "./db.js", which this doesn't match.
const STORE_FACADE_IMPORTS = {
  regex: "(^|/)database/db\\.js$",
  message: "Only providers/ may import the store facade (database/db.js); use the repositories.",
};

// domain/ imports nothing from server/src. One "../" leaves domain/ for server/src; the
// repo's shared/ folder ("../../../shared/...") is outside server/src and stays allowed.
const OUTSIDE_DOMAIN_IMPORTS = {
  regex: "^\\.\\./(?!\\.\\./\\.\\./shared/)",
  message: "domain/ may not import anything from server/src outside domain/.",
};

/** Builds a no-restricted-imports rule entry that bans the given import patterns. */
function banImports(...patterns) {
  return ["error", { patterns }];
}

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
  {
    // Server code (Node). Only the layer rule below runs here, not the recommended rules:
    // turning on full lint for the server is a separate follow-up.
    files: ["server/**/*.js"],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
  },
  {
    // Compose (app.js, index.js, providers/) and anything else in server/src. The layer blocks
    // below replace this rule's options for their folders, so each of them bans gameActions/ too
    // (logic, data and base through HANDLER_IMPORTS).
    files: ["server/src/**/*.js"],
    ignores: ["server/src/gameActions/**"],
    rules: {
      "no-restricted-imports": banImports(GAME_ACTIONS_IMPORTS, STORE_FACADE_IMPORTS),
    },
  },
  {
    // Compose: providers/ opens the store (DatabaseProvider), so it alone may import db.js.
    files: ["server/src/providers/**/*.js"],
    rules: {
      "no-restricted-imports": banImports(GAME_ACTIONS_IMPORTS),
    },
  },
  {
    // Entry.
    files: ["server/src/http/**/*.js", "server/src/realtime/**/*.js"],
    rules: {
      "no-restricted-imports": banImports(COMPOSE_IMPORTS, GAME_ACTIONS_IMPORTS, STORE_FACADE_IMPORTS),
    },
  },
  {
    // Handlers.
    files: ["server/src/actions/**/*.js"],
    rules: {
      "no-restricted-imports": banImports(
        COMPOSE_IMPORTS,
        ENTRY_IMPORTS,
        GAME_ACTIONS_IMPORTS,
        STORE_FACADE_IMPORTS,
      ),
    },
  },
  {
    // The test-facing adapters wrap the handlers and services, but not the entry layer.
    files: ["server/src/gameActions/**/*.js"],
    rules: {
      "no-restricted-imports": banImports(COMPOSE_IMPORTS, ENTRY_IMPORTS, STORE_FACADE_IMPORTS),
    },
  },
  {
    // Logic. Managers may import services: they share a layer.
    files: ["server/src/services/**/*.js", "server/src/managers/**/*.js"],
    rules: {
      "no-restricted-imports": banImports(
        COMPOSE_IMPORTS,
        ENTRY_IMPORTS,
        HANDLER_IMPORTS,
        STORE_FACADE_IMPORTS,
      ),
    },
  },
  {
    // Data.
    files: ["server/src/repositories/**/*.js", "server/src/database/**/*.js"],
    rules: {
      "no-restricted-imports": banImports(
        COMPOSE_IMPORTS,
        ENTRY_IMPORTS,
        HANDLER_IMPORTS,
        LOGIC_IMPORTS,
        STORE_FACADE_IMPORTS,
      ),
    },
  },
  {
    // Base.
    files: [
      "server/src/domain/**/*.js",
      "server/src/lib/**/*.js",
      "server/src/config/**/*.js",
    ],
    rules: {
      "no-restricted-imports": banImports(
        COMPOSE_IMPORTS,
        ENTRY_IMPORTS,
        HANDLER_IMPORTS,
        LOGIC_IMPORTS,
        DATA_IMPORTS,
      ),
    },
  },
  {
    // domain/ is stricter than the rest of base. Comes after the base block, so its options
    // replace the base ones for domain/.
    files: ["server/src/domain/**/*.js"],
    rules: {
      "no-restricted-imports": banImports(OUTSIDE_DOMAIN_IMPORTS),
    },
  },
];
