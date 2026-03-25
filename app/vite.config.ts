import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const apiProxyTarget = env.VITE_DEV_API_PROXY || "http://127.0.0.1:8084"

  return {
  // Use '/' so assets load from site root when server serves index.html for SPA routes (e.g. /dashboard)
  base: '/',
  plugins: [inspectAttr(), react()],
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
  };
});
