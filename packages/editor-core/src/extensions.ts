import type { Command, Project, RenderPlan } from "./types";
import { EditorError, ensure } from "./errors";
import { record } from "./model";
import { buildRenderPlan } from "./render";
import { EditorStore } from "./store";

export const EDITOR_API_VERSION = 1 as const;
export type EditorCapability = "project.read" | "commands.dispatch" | "render.plan" | "project.subscribe";
export interface EditorApiV1 {
  readonly apiVersion: 1;
  readonly capabilities: readonly EditorCapability[];
  getSnapshot(): Project;
  dispatch(command: Command): Project;
  buildRenderPlan(): RenderPlan;
  subscribe(callback: () => void): () => void;
}
export function createEditorApi(store: EditorStore, capabilities: readonly EditorCapability[]): EditorApiV1 {
  ensure(Array.isArray(capabilities), "Editor API capabilities must be an array");
  const allowed = new Set(capabilities);
  const known: EditorCapability[] = ["project.read", "commands.dispatch", "render.plan", "project.subscribe"];
  ensure(capabilities.every((item) => known.includes(item)), "Unknown Editor API capability");
  function requireCapability(capability: EditorCapability) { if (!allowed.has(capability)) throw new EditorError("UNSUPPORTED", `Extension lacks capability ${capability}`); }
  return Object.freeze({ apiVersion: EDITOR_API_VERSION, capabilities: Object.freeze([...allowed]), getSnapshot() { requireCapability("project.read"); return store.getSnapshot(); }, dispatch(command: Command) { requireCapability("commands.dispatch"); return store.dispatch(command); }, buildRenderPlan() { requireCapability("render.plan"); return buildRenderPlan(store.getSnapshot()); }, subscribe(callback: () => void) { requireCapability("project.subscribe"); return store.subscribe(callback); } });
}
export interface ExtensionManifest {
  id: string; version: string; apiVersion: 1;
  kind: "effect" | "ai-provider" | "tool";
  name: string; capabilities: readonly EditorCapability[];
}
export interface EditorExtension {
  manifest: ExtensionManifest;
  activate(api: EditorApiV1): void | (() => void);
}
/** Registration enables explicitly supplied extensions; it downloads no models,
 * executes no providers automatically, and does not implement AI or new effects. */
export class ExtensionRegistry {
  private entries = new Map<string, { extension: EditorExtension; manifest: ExtensionManifest; dispose?: () => void }>();
  constructor(private readonly store: EditorStore) {}
  register(extension: EditorExtension): void {
    record(extension, "extension", ["manifest", "activate"]);
    record(extension.manifest, "extension manifest", ["id", "version", "apiVersion", "kind", "name", "capabilities"]);
    const manifest = structuredClone(extension.manifest);
    ensure(manifest.apiVersion === EDITOR_API_VERSION, "Unsupported extension API version");
    ensure(typeof manifest.id === "string" && /^[a-z][a-z0-9.-]{1,127}$/.test(manifest.id), "Invalid extension ID");
    ensure(typeof manifest.version === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version), "Extension version must be semantic");
    ensure(["effect", "ai-provider", "tool"].includes(manifest.kind) && typeof manifest.name === "string" && manifest.name.trim().length > 0 && Array.isArray(manifest.capabilities) && typeof extension.activate === "function", "Invalid extension manifest");
    if (this.entries.has(manifest.id)) throw new EditorError("CONFLICT", `Extension ${manifest.id} already registered`);
    createEditorApi(this.store, manifest.capabilities);
    this.entries.set(manifest.id, { extension, manifest });
  }
  list(): ExtensionManifest[] { return [...this.entries.values()].map((entry) => structuredClone(entry.manifest)); }
  activate(id: string): void {
    const entry = this.entries.get(id); if (!entry) throw new EditorError("NOT_FOUND", `Extension ${id} is not registered`);
    if (entry.dispose) throw new EditorError("CONFLICT", `Extension ${id} is already active`);
    const result = entry.extension.activate(createEditorApi(this.store, entry.manifest.capabilities));
    ensure(result === undefined || typeof result === "function", "Extension activate must be synchronous and return a disposer or void");
    entry.dispose = typeof result === "function" ? result : () => {};
  }
  unregister(id: string): void { const entry = this.entries.get(id); if (!entry) throw new EditorError("NOT_FOUND", `Extension ${id} is not registered`); this.entries.delete(id); entry.dispose?.(); }
  dispose(): void { const errors: unknown[] = []; for (const id of [...this.entries.keys()]) try { this.unregister(id); } catch (error) { errors.push(error); } if (errors.length) throw new AggregateError(errors, "Extension disposal failed"); }
}
