import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IndexedDBAdapter } from "../src/services/storage/indexeddb-adapter";
import { runStorageMigrations } from "../src/services/storage/migrations/runner";
import { V1toV2Migration } from "../src/services/storage/migrations/v1-to-v2";

describe("local migration storage compatibility", () => {
	for (const useProjectFallback of [false, true]) {
		test(`copies ${useProjectFallback ? "project fallback" : "scene"} tracks using the adapter object API`, async () => {
			const project = {
				id: "legacy-project",
				version: 1,
				name: "Imported legacy project",
				customLegacyField: { keep: true },
				scenes: [{ id: "main-scene", isMain: true, tracks: [] }],
			};
			const legacyTimeline = {
				lastModified: "2025-01-01T00:00:00.000Z",
				tracks: [{
					id: "legacy-track",
					type: "media",
					name: "Legacy media",
					elements: [{
						id: "legacy-element",
						type: "media",
						mediaId: "photo",
						duration: 120,
						startTime: 0,
					}],
				}],
			};
			const originalLegacy = structuredClone(legacyTimeline);
			const originalProject = structuredClone(project);
			const projectAdapters: unknown[] = [];
			const readAdapters: unknown[] = [];
			const reads: unknown[] = [
				...(useProjectFallback ? [null] : []),
				legacyTimeline,
				{ id: "photo", type: "image" },
			];
			const all = spyOn(IndexedDBAdapter.prototype, "getAll").mockImplementation(function (this: unknown) {
				projectAdapters.push(this);
				return Promise.resolve([project]);
			});
			const get = spyOn(IndexedDBAdapter.prototype, "get").mockImplementation(function (this: unknown) {
				readAdapters.push(this);
				return Promise.resolve(reads.shift() ?? null);
			});
			const set = spyOn(IndexedDBAdapter.prototype, "set").mockResolvedValue(undefined);
			const originalGlobal = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
			Object.defineProperty(globalThis, "indexedDB", {
				configurable: true,
				get() { throw new Error("This fixture must never access real IndexedDB"); },
			});

			try {
				const result = await runStorageMigrations({ migrations: [new V1toV2Migration()] });
				expect(result.migratedCount).toBe(1);
				expect(all).toHaveBeenCalledTimes(1);
				expect(projectAdapters).toMatchObject([
					{ dbName: "video-editor-projects", storeName: "projects", version: 1 },
				]);
				expect(readAdapters).toMatchObject([
					{ dbName: "video-editor-timelines-legacy-project-main-scene", storeName: "timeline", version: 1 },
					...(useProjectFallback ? [{ dbName: "video-editor-timelines-legacy-project", storeName: "timeline", version: 1 }] : []),
					{ dbName: "video-editor-media-legacy-project", storeName: "media-metadata", version: 1 },
				]);
				expect(get.mock.calls).toEqual([
					["timeline"],
					...(useProjectFallback ? [["timeline"]] : []),
					["photo"],
				]);
				expect(set).toHaveBeenCalledTimes(1);
				expect(set).toHaveBeenCalledWith({
					key: "legacy-project",
					value: expect.objectContaining({
						id: "legacy-project",
						version: 2,
						name: "Imported legacy project",
						customLegacyField: { keep: true },
						scenes: [expect.objectContaining({
							id: "main-scene",
							tracks: [expect.objectContaining({
								id: "legacy-track",
								type: "video",
								elements: [expect.objectContaining({ id: "legacy-element", type: "image", mediaId: "photo" })],
							})],
						})],
					}),
				});
				expect(legacyTimeline).toEqual(originalLegacy);
				expect(project).toEqual(originalProject);
			} finally {
				all.mockRestore();
				get.mockRestore();
				set.mockRestore();
				if (originalGlobal) Object.defineProperty(globalThis, "indexedDB", originalGlobal);
				else Reflect.deleteProperty(globalThis, "indexedDB");
			}
		});
	}

	test("migration implementations do not import or invoke database deletion", () => {
		const directory = fileURLToPath(new URL("../src/services/storage/migrations/", import.meta.url));
		for (const path of new Bun.Glob("**/*.ts").scanSync({ cwd: directory, absolute: true })) {
			if (path.includes("__tests__")) continue;
			expect(readFileSync(path, "utf8")).not.toMatch(/\bdeleteDatabase\b/);
		}
	});
});
