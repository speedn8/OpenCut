import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";

// Real Skia-backed Canvas for geometry tests in Bun, which has no DOM Canvas.
// Production uses Chromium's own Canvas; no renderer implementation is replaced.
if (typeof globalThis.OffscreenCanvas === "undefined") {
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: class TestCanvas {
      constructor(width: number, height: number) { return createCanvas(width, height); }
    },
  });
}

// The published package uses wasm-bindgen's bundler target. Bun 1.2.18 imports
// .wasm as a file path; give its unchanged entrypoint the real instance exports
// that Vite's WASM plugin provides in the renderer. This loader is test-only.
const glue = await import(
	new URL("../node_modules/opencut-wasm/opencut_wasm_bg.js", import.meta.url).href
);

plugin({
	name: "opencut-wasm-test-loader",
	setup(build) {
		build.onLoad(
			{ filter: /[/\\]opencut-wasm[/\\]opencut_wasm_bg\.wasm$/ },
			({ path }) => {
				const module = new WebAssembly.Module(readFileSync(path));
				const instance = new WebAssembly.Instance(module, {
					"./opencut_wasm_bg.js": glue,
				});
				// The package entrypoint calls __wbg_set_wasm and __wbindgen_start.
				// Return actual exports, including memory/tables, without replacing
				// the package's public wrappers or time/renderer implementations.
				return { loader: "object", exports: instance.exports };
			},
		);
	},
});
