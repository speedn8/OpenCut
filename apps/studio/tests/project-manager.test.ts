import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { EditorCore } from "../src/core";
import { ProjectManager } from "../src/core/managers/project-manager";
import { SaveManager } from "../src/core/managers/save-manager";
import { CommandManager } from "../src/core/managers/commands";
import { SelectionManager } from "../src/core/managers/selection-manager";
import { Command } from "../src/commands/base-command";
import { storageService } from "../src/services/storage/service";
import { IndexedDBAdapter } from "../src/services/storage/indexeddb-adapter";
import { buildDefaultScene } from "../src/timeline/scenes";
import type { TProject } from "../src/project/types";
import { DEFAULT_FPS } from "../src/fps/defaults";
import { ZERO_MEDIA_TIME } from "../src/wasm";
import { toast } from "sonner";

function signal() {
	const listeners = new Set<() => void>();
	return {
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function makeProject(id = "active-project"): TProject {
	const scene = buildDefaultScene({ name: "Main scene", isMain: true });
	return {
		metadata: { id, name: "Original", duration: ZERO_MEDIA_TIME, createdAt: new Date(), updatedAt: new Date() },
		scenes: [scene],
		currentSceneId: scene.id,
		settings: { fps: DEFAULT_FPS, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000000" } },
		timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: ZERO_MEDIA_TIME },
		version: 31,
	};
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
	let project: ProjectManager;
	let save: SaveManager;
	let command: CommandManager;
	let selection: SelectionManager;
	const initial = makeProject();
	let sceneList = initial.scenes;
	const scenes = {
		...signal(),
		getScenes: () => sceneList,
		clearScenes: () => { sceneList = []; },
		initializeScenes: ({ scenes }: { scenes: TProject["scenes"] }) => { sceneList = scenes; },
	};
	const editor = {
		scenes,
		timeline: signal(),
		// Hydration is complete in this fixture. Use the real project/save methods
		// for mutation and storage, with all storage calls replaced by spies.
		project: {
			subscribe: (listener: () => void) => project.subscribe(listener),
			getActiveOrNull: () => project.getActiveOrNull(),
			getIsLoading: () => false,
			getMigrationState: () => ({ isMigrating: false }),
			saveCurrentProject: () => project.saveCurrentProject(),
		},
		get save() { return save; },
		get command() { return command; },
		get selection() { return selection; },
		media: { clearAllAssets() {}, async loadProjectMedia() {} },
	} as unknown as EditorCore;
	project = new ProjectManager(editor);
	save = new SaveManager({ editor, debounceMs: 60_000 });
	command = new CommandManager(editor);
	selection = new SelectionManager(editor);
	project.setActiveProject({ project: initial });
	save.start();
	cleanups.push(() => save.stop());
	return { project, save, command, selection, initial };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("ProjectManager rename durability", () => {
	test("active rename retains pending settings/view and never reloads the saved copy", async () => {
		const f = fixture();
		const load = spyOn(storageService, "loadProject").mockResolvedValue({ project: structuredClone(f.initial) });
		const writes: TProject[] = [];
		const store = spyOn(storageService, "saveProject").mockImplementation(async ({ project }) => { writes.push(structuredClone(project)); });
		cleanups.push(() => load.mockRestore(), () => store.mockRestore());
		f.project.setActiveProject({ project: { ...f.initial, settings: { ...f.initial.settings, background: { type: "color", color: "#ff0000" } } } });
		f.project.setTimelineViewState({ viewState: { zoomLevel: 2, scrollLeft: 42, playheadTime: ZERO_MEDIA_TIME } });

		await f.project.renameProject({ id: f.initial.metadata.id, name: "Renamed" });
		expect(load).not.toHaveBeenCalled();
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({ metadata: { name: "Renamed" }, settings: { background: { color: "#ff0000" } }, timelineViewState: { zoomLevel: 2, scrollLeft: 42 } });
		expect(f.project.getActive().settings.background).toEqual({ type: "color", color: "#ff0000" });
		expect(f.project.getActive().timelineViewState?.zoomLevel).toBe(2);
		expect(f.save.getIsDirty()).toBe(false);
	});

	test("rename waits for concurrent edits queued during its write", async () => {
		const f = fixture();
		const writes: TProject[] = [];
		const started = [deferred(), deferred()];
		const finish = [deferred(), deferred()];
		const store = spyOn(storageService, "saveProject").mockImplementation(async ({ project }) => {
			const index = writes.length;
			writes.push(structuredClone(project));
			started[index].resolve();
			await finish[index].promise;
		});
		cleanups.push(() => store.mockRestore());
		let settled = false;
		const renamed = f.project.renameProject({ id: f.initial.metadata.id, name: "Renamed" }).then(() => { settled = true; });
		await started[0].promise;
		f.project.setActiveProject({ project: {
			...f.project.getActive(),
			settings: { ...f.project.getActive().settings, background: { type: "color", color: "#00ff00" } },
			timelineViewState: { zoomLevel: 3, scrollLeft: 64, playheadTime: ZERO_MEDIA_TIME },
		} });
		f.save.markDirty();
		finish[0].resolve();
		await started[1].promise;
		expect(settled).toBe(false);
		expect(writes[1]).toMatchObject({ metadata: { name: "Renamed" }, settings: { background: { color: "#00ff00" } }, timelineViewState: { zoomLevel: 3, scrollLeft: 64 } });
		finish[1].resolve();
		await renamed;
		expect(f.project.getActive().settings.background).toEqual({ type: "color", color: "#00ff00" });
		expect(f.project.getActive().timelineViewState?.zoomLevel).toBe(3);
		expect(f.save.getIsDirty()).toBe(false);
	});

	test("failed active rename rejects and keeps its current state dirty for retry", async () => {
		const f = fixture();
		const failure = new Error("disk full");
		const store = spyOn(storageService, "saveProject").mockRejectedValue(failure);
		const notify = spyOn(toast, "error").mockReturnValue(0);
		const log = spyOn(console, "error").mockImplementation(() => {});
		cleanups.push(() => store.mockRestore(), () => notify.mockRestore(), () => log.mockRestore());
		await expect(f.project.renameProject({ id: f.initial.metadata.id, name: "Retry name" })).rejects.toBe(failure);
		expect(f.project.getActive().metadata.name).toBe("Retry name");
		expect(f.save.getIsDirty()).toBe(true);
		expect(f.save.getLastError()).toBe(failure);
		expect(notify).toHaveBeenCalled();
		store.mockResolvedValue(undefined);
		await f.save.flush();
		expect(f.save.getIsDirty()).toBe(false);
		expect(f.save.getLastError()).toBeNull();
	});

	test("non-active rename writes that project without replacing active state", async () => {
		const f = fixture();
		const other = makeProject("other-project");
		const load = spyOn(storageService, "loadProject").mockResolvedValue({ project: other });
		const store = spyOn(storageService, "saveProject").mockResolvedValue(undefined);
		cleanups.push(() => load.mockRestore(), () => store.mockRestore());
		await f.project.renameProject({ id: other.metadata.id, name: "Other name" });
		expect(store).toHaveBeenCalledWith({ project: expect.objectContaining({ metadata: expect.objectContaining({ id: "other-project", name: "Other name" }) }) });
		expect(f.project.getActive()).toBe(f.initial);
	});

	test("missing non-active project rejects instead of reporting success", async () => {
		const f = fixture();
		const load = spyOn(storageService, "loadProject").mockResolvedValue(null);
		const store = spyOn(storageService, "saveProject").mockResolvedValue(undefined);
		const notify = spyOn(toast, "error").mockReturnValue(0);
		const log = spyOn(console, "error").mockImplementation(() => {});
		cleanups.push(() => load.mockRestore(), () => store.mockRestore(), () => notify.mockRestore(), () => log.mockRestore());
		await expect(f.project.renameProject({ id: "missing", name: "Missing" })).rejects.toThrow("not found");
		expect(store).not.toHaveBeenCalled();
		expect(f.project.getActive()).toBe(f.initial);
	});
});

describe("project command history isolation", () => {
	for (const boundary of ["close", "create", "load"] as const) {
		test(`${boundary} clears both history stacks and selection before another project can undo`, async () => {
			const f = fixture();
			const store = spyOn(storageService, "saveProject").mockResolvedValue(undefined);
			cleanups.push(() => store.mockRestore());
			const effects: string[] = [];
			class OldProjectCommand extends Command {
				execute() { effects.push("execute old project"); return undefined; }
				undo() { effects.push("undo old project"); }
			}
			f.command.execute({ command: new OldProjectCommand() });
			f.command.execute({ command: new OldProjectCommand() });
			f.command.undo();
			f.selection.setSelectedElements({ elements: [{ trackId: "old-track", elementId: "old-element" }] });
			expect(f.command.canUndo()).toBe(true);
			expect(f.command.canRedo()).toBe(true);

			if (boundary === "close") {
				f.project.closeProject();
				f.project.setActiveProject({ project: makeProject("second-project") });
			} else if (boundary === "create") {
				await f.project.createNewProject({ name: "Second project" });
			} else {
				const other = makeProject("second-project");
				other.metadata.thumbnail = "existing-thumbnail";
				const all = spyOn(IndexedDBAdapter.prototype, "getAll").mockResolvedValue([]);
				const load = spyOn(storageService, "loadProject").mockResolvedValue({ project: other });
				cleanups.push(() => all.mockRestore(), () => load.mockRestore());
				await f.project.loadProject({ id: other.metadata.id });
			}
			const beforeUndo = [...effects];
			f.command.undo();
			f.command.redo();
			expect(f.command.canUndo()).toBe(false);
			expect(f.command.canRedo()).toBe(false);
			expect(f.selection.getSelectedElements()).toEqual([]);
			expect(effects).toEqual(beforeUndo);
			expect(f.project.getActive().metadata.id).not.toBe(f.initial.metadata.id);
		});
	}
});
