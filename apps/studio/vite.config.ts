import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import { fileURLToPath, URL } from "node:url";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  plugins: [react(), tailwindcss(), wasm()],
  resolve: { alias: [
    { find: "next/navigation", replacement: source("./src/studio/navigation.ts") },
    { find: "next/link", replacement: source("./src/studio/link.tsx") },
    { find: "next/image", replacement: source("./src/studio/image.tsx") },
    { find: "@", replacement: source("./src") },
  ] },
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production") },
  optimizeDeps: { exclude: ["opencut-wasm"] },
  build: { target: "esnext", sourcemap: true },
  worker: { format: "es", plugins: () => [wasm()] },
  server: { host: "127.0.0.1", port: 38841, strictPort: true, headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
});
