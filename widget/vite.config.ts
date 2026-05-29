/**
 * Vite build config for ``@vocence/widget``.
 *
 * Produces two artifacts:
 *
 *   • ``dist/widget.iife.js``  — self-contained IIFE for the
 *     ``<script src="...">`` embed case. Registers the
 *     ``<vocence-agent>`` custom element as a side effect of loading.
 *     This is what customers paste into their HTML.
 *
 *   • ``dist/widget.esm.js``  — ES module for ``import``-style
 *     consumers (React/Vue wrappers, build-step embedders).
 *
 * Both bundles inline every dep, including Lit and the Silero VAD
 * ONNX model that ``@ricky0123/vad-web`` loads. The result is one
 * self-contained file the customer's browser fetches in one round
 * trip — no follow-up network calls to npm or a CDN.
 *
 * The audio worklet (PCM player) is also inlined as a stringified
 * module so we don't need a second HTTP request for it. See
 * ``src/session/player.ts``.
 */

import { defineConfig } from "vite";

export default defineConfig({
  // Vite default is `process.cwd()` — set ``root`` explicitly so
  // running ``vite build`` from any working directory still picks the
  // right entry point.
  root: ".",
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // Library mode generates the dual ESM + IIFE outputs the widget
    // distribution needs.
    lib: {
      entry: "src/index.ts",
      name: "VocenceWidget",
      formats: ["es", "iife"],
      fileName: (format) =>
        format === "iife" ? "widget.iife.js" : "widget.esm.js",
    },
    rollupOptions: {
      // Bundle every dep — the IIFE must be drop-in usable without
      // additional <script> tags. The ESM bundle could externalize
      // ``lit`` but bundling it lets React/Vue wrappers consume one
      // file without peer-dep coordination.
      external: [],
      output: {
        // Inline dynamic imports (VAD's ONNX worker) so we ship one
        // file. The cost is bundle size; the win is one round trip.
        inlineDynamicImports: true,
      },
    },
    // Hard-fail CI on regressions above this size. The platform spec
    // commits us to ≤ 120 KB gzipped. We watch the uncompressed size
    // separately in scripts/check-size.mjs.
    chunkSizeWarningLimit: 600,
  },
  // The IIFE bundle is what customers load via <script src>. Vite's
  // dev server can also serve it for local iteration.
  server: {
    port: 5174,
    fs: {
      strict: true,
    },
  },
});
