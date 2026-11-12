import fs from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { buildThirdPartyNotices } from './scripts/third-party-notices.mjs'

// The Node backend (server/) listens here during development. Ports 7000/7001 (not the
// usual 5173/3000) avoid clashing with other local projects.
const backendUrl = process.env.API_URL || 'http://localhost:7001'

// Docker bind mounts from Windows/macOS don't deliver file-change events, so the dev
// container (`npm run share`) turns on polling.
const usePolling = process.env.VITE_USE_POLLING === 'true'

// Prints the server's addresses with console.log. Vite's own printUrls() goes through the
// logger, which `logLevel: 'error'` silences, so `npm run dev` would otherwise print nothing.
function logServerUrls(server) {
  const urls = server.resolvedUrls

  if (!urls) {
    return
  }

  for (const url of urls.local) {
    console.log(`  Local:   ${url}`)
  }
  for (const url of urls.network) {
    console.log(`  Network: ${url}`)
  }
}

// The Vite CLI calls printUrls() once the dev or preview server is listening.
function showServerUrls() {
  return {
    name: 'show-server-urls',
    configureServer(server) {
      server.printUrls = () => logServerUrls(server)
    },
    configurePreviewServer(server) {
      server.printUrls = () => logServerUrls(server)
    },
  }
}

// Puts the licence files in dist/ on a build, so the server serves them (/licenses) and the
// installers ship them with the client: THIRD_PARTY_NOTICES.txt and the app's own LICENSE.txt.
function licenseFiles() {
  return {
    name: 'license-files',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: buildThirdPartyNotices() })
      this.emitFile({
        type: 'asset',
        fileName: 'LICENSE.txt',
        source: fs.readFileSync(fileURLToPath(new URL('./LICENSE', import.meta.url)), 'utf8'),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  logLevel: 'error', // Suppress warnings, only show errors
  plugins: [react(), showServerUrls(), licenseFiles()],
  resolve: {
    // Matches the "@/*" path in jsconfig.json.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 7000,
    // Falling back to the next free port would land on the backend's 7001.
    strictPort: true,
    // Listen on all interfaces so phones on the LAN can open the dev server.
    host: true,
    // Vite rejects unknown Host headers; quick tunnel URLs are https://<random>.trycloudflare.com.
    allowedHosts: ['.trycloudflare.com'],
    watch: {
      usePolling,
      interval: 300,
      // The server has its own watcher; the rest never affects the frontend.
      ignored: ['**/server/**', '**/data/**', '**/docs/**'],
    },
    proxy: {
      '/api': { target: backendUrl, ws: true },
      '/login': { target: backendUrl },
    },
  },
});
