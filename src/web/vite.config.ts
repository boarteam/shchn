import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

// The web app. From the repository root: npm run web (development server),
// npm run web:build (static files in dist/web).

/**
 * API keys live in the page, so the built page may load only its own scripts and
 * talk only to the APIs it uses. Left out in development, where Vite's own
 * inline scripts and websocket need more.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'", // CodeMirror adds its styles at runtime
  "img-src 'self' data:",
  "connect-src https://api.anthropic.com wss://stt-rt.soniox.com wss://api.deepgram.com",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
        injectTo: "head-prepend",
      },
    ],
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  build: {
    outDir: fileURLToPath(new URL("../../dist/web", import.meta.url)),
    emptyOutDir: true,
    // The page is React and CodeMirror (~170 kB gzipped); the worker carries the Anthropic SDK.
    chunkSizeWarningLimit: 800,
  },
});
