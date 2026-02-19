import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
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
});
