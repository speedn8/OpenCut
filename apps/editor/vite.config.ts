import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {fileURLToPath} from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {alias: {"@core": fileURLToPath(new URL("../../packages/editor-core/src/index.ts", import.meta.url))}},
  build: {target: "chrome144", outDir: "dist", sourcemap: true, emptyOutDir: true}
});
