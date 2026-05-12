import { createReadStream, existsSync, statSync } from "node:fs"
import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv, type Plugin } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

/**
 * Serve the VAD assets (Silero ONNX model + onnxruntime-web WASM/MJS
 * loader) as raw files in dev. They live in /public/vad/ so the
 * production build copies them automatically, but Vite's dev server
 * refuses to let `import()` resolve to /public files (intentional —
 * /public is for HTML/fetch references). onnxruntime-web internally
 * does `import('/vad/ort-wasm-simd-threaded.mjs')` to bootstrap the
 * WASM, which trips that restriction. This middleware short-circuits
 * /vad/* requests before Vite's module pipeline sees them, so the
 * .mjs is delivered as a regular ES module and the .wasm/.onnx files
 * are delivered as raw binaries.
 */
function serveVadAssetsInDev(): Plugin {
  return {
    name: 'serve-vad-assets-dev',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use('/vad', (req, res, next) => {
        const raw = (req.url || '').split('?')[0];
        const fileName = raw.replace(/^\//, '');
        if (!fileName) return next();
        const filePath = path.join(root, 'public', 'vad', fileName);
        if (!existsSync(filePath) || !statSync(filePath).isFile()) return next();
        const type = fileName.endsWith('.wasm')
          ? 'application/wasm'
          : fileName.endsWith('.mjs') || fileName.endsWith('.js')
            ? 'application/javascript; charset=utf-8'
            : fileName.endsWith('.onnx')
              ? 'application/octet-stream'
              : 'application/octet-stream';
        res.setHeader('Content-Type', type);
        // Long cache — these are content-addressed by version pin.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const apiProxyTarget = env.VITE_DEV_API_PROXY || "http://127.0.0.1:8084"

  return {
  // Use '/' so assets load from site root when server serves index.html for SPA routes (e.g. /dashboard)
  base: '/',
  plugins: [serveVadAssetsInDev(), inspectAttr(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            if (id.includes('react-dom') || id.includes('react/')) return 'react';
            if (id.includes('react-router')) return 'router';
            if (id.includes('gsap') || id.includes('lucide-react') || id.includes('react-icons')) return 'vendor';
          }
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
  server: {
    proxy: {
      // When VITE_API_URL is unset, the app calls same-origin `/api/*` and this forwards to the dashboard backend.
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    // @ricky0123/vad-web ships CommonJS and does
    //   require("onnxruntime-web/wasm")
    // inside real-time-vad.js. The /wasm subpath resolves (via
    // onnxruntime-web's `exports` map) to ort.wasm.bundle.min.mjs —
    // an ESM bundle that has the actual WASM embedded as base64, so
    // there's no external worker/wasm path to break. We have to
    // include BOTH so esbuild can resolve the require to a static
    // import and inline the bundled .mjs alongside vad-web's code.
    include: ['@ricky0123/vad-web', 'onnxruntime-web/wasm'],
  },
  };
});
