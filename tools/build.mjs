import {build as bundle} from "esbuild";
import {build as frontend} from "vite";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await bundle({entryPoints:[path.join(root,"packages/editor-core/src/index.ts")],outfile:path.join(root,"apps/editor/electron/core.cjs"),bundle:true,platform:"node",format:"cjs",target:"node24",sourcemap:true});
await frontend({configFile:path.join(root,"apps/editor/vite.config.ts")});
