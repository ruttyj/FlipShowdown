// Builds the launcher's page (src/renderer) into dist-renderer/, which src/main/main.js loads
// with loadFile. Run from the repo root, which has Vite, React and the UI components:
//   npm run build:launcher                     (production build)
//   npx vite --config desktop/vite.config.js   (dev server; start Electron with
//                                               FLIP7_LAUNCHER_RENDERER_URL=http://localhost:5174)
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import loadTailwindConfig from 'tailwindcss/loadConfig.js';
import { defineConfig } from 'vite';

const DEV_SERVER_PORT = 5174;

/** @param {string} relativePath  from this file */
function pathFromHere(relativePath) {
    return fileURLToPath(new URL(relativePath, import.meta.url));
}

const RENDERER_ROOT = pathFromHere('./src/renderer');
const REPO_SRC = pathFromHere('../src');

// The app's Tailwind theme (colours, radius, dark mode), scanning the launcher's files and the
// shared UI components it uses instead of the app's pages. Paths are absolute because Tailwind
// resolves content globs from the working directory.
function launcherTailwindConfig() {
    const appConfig = loadTailwindConfig(pathFromHere('../tailwind.config.js'));
    return {
        ...appConfig,
        content: [
            `${RENDERER_ROOT}/**/*.{html,js,jsx}`.replaceAll('\\', '/'),
            `${REPO_SRC}/components/ui/**/*.{js,jsx}`.replaceAll('\\', '/'),
            `${REPO_SRC}/components/logo/**/*.{js,jsx}`.replaceAll('\\', '/'),
        ],
    };
}

// The CSP in index.html allows only the page's own scripts. Vite's dev server needs an inline
// script (React Refresh) and a websocket (HMR), so in dev only those two are added. Throws if
// index.html no longer has the directives it rewrites, rather than silently breaking dev mode.
const DEV_CSP_CHANGES = [
    ["script-src 'self'", "script-src 'self' 'unsafe-inline'"],
    ["connect-src 'self'", `connect-src 'self' ws://localhost:${DEV_SERVER_PORT}`],
];

function launcherCsp() {
    return {
        name: 'launcher-dev-csp',
        apply: 'serve',
        transformIndexHtml(html) {
            let relaxed = html;
            for (const [strict, devOnly] of DEV_CSP_CHANGES) {
                if (!relaxed.includes(strict)) {
                    throw new Error(`desktop/src/renderer/index.html: the CSP has no "${strict}" to relax for dev`);
                }
                relaxed = relaxed.replace(strict, devOnly);
            }
            return relaxed;
        },
    };
}

export default defineConfig({
    root: RENDERER_ROOT,
    // Relative asset URLs, because the built page is loaded from file://.
    base: './',
    publicDir: false,
    logLevel: 'warn',
    plugins: [react(), launcherCsp()],
    resolve: {
        // Same "@/" alias as the app (vite.config.js), for the shared UI components and CSS.
        alias: {
            '@': REPO_SRC,
        },
    },
    css: {
        postcss: {
            plugins: [tailwindcss(launcherTailwindConfig()), autoprefixer()],
        },
    },
    build: {
        outDir: pathFromHere('./dist-renderer'),
        emptyOutDir: true,
    },
    server: {
        port: DEV_SERVER_PORT,
        strictPort: true,
        // Only Electron on this machine loads it.
        host: 'localhost',
    },
});
