import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { EditorCore } from "../src/core";
import { SaveManager } from "../src/core/managers/save-manager";

function signal() {
	const listeners = new Set<() => void>();
	return {
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit() {
			for (const listener of [...listeners]) listener();
		},
	};
}

type PendingWrite = {
	revision: number;
	succeed: () => void;
	fail: (error: Error) => void;
};

const managers: SaveManager[] = [];

function fixture({ debounceMs = 60_000 }: { debounceMs?: number } = {}) {
	const scenes = signal();
	const timeline = signal();
	const projectChanges = signal();
	const storageChanges = signal();
	const writes: PendingWrite[] = [];
	const persisted: number[] = [];
	const state = {
		revision: 1,
		active: true,
		loading: false,
		migrating: false,
		concurrentWrites: 0,
		peakWrites: 0,
	};
	const storage = {
		async write(revision: number) {
			state.concurrentWrites++;
			state.peakWrites = Math.max(state.peakWrites, state.concurrentWrites);
			try {
				await new Promise<void>((resolve, reject) => {
					writes.push({ revision, succeed: resolve, fail: reject });
					storageChanges.emit();
				});
				persisted.push(revision);
			} finally {
				state.concurrentWrites--;
			}
		},
	};
	const editor = {
		scenes,
		timeline,
		project: {
			subscribe: projectChanges.subscribe,
			getActiveOrNull: () =>
				state.active ? { metadata: { id: "test-project" } } : null,
			getIsLoading: () => state.loading,
			getMigrationState: () => ({ isMigrating: state.migrating }),
			// Match the real manager's snapshot-at-write boundary, with storage
			// failures propagated to its caller rather than swallowed.
			saveCurrentProject: () => storage.write(state.revision),
		},
	} as unknown as EditorCore;
	const save = new SaveManager({ editor, debounceMs });
	managers.push(save);
	save.start();

	async function writeAt(index: number): Promise<PendingWrite> {
		if (!writes[index]) {
			await new Promise<void>((resolve) => {
				const unsubscribe = storageChanges.subscribe(() => {
					if (writes[index]) {
						unsubscribe();
						resolve();
					}
				});
			});
		}
		const write = writes[index];
		if (!write) throw new Error(`Storage write ${index} never started`);
		return write;
	}

	return { save, state, scenes, timeline, projectChanges, writes, persisted, writeAt };
}

function waitForState(save: SaveManager, predicate: () => boolean) {
	if (predicate()) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const unsubscribe = save.subscribe(() => {
			if (predicate()) {
				unsubscribe();
				resolve();
			}
		});
	});
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
	for (const manager of managers.splice(0)) manager.stop();
});

describe("SaveManager durability", () => {
	test("flush waits for both an active write and mutations queued during it", async () => {
		const f = fixture();
		let firstFinished = false;
		let secondFinished = false;
		const first = f.save.flush().then(() => { firstFinished = true; });
		const firstWrite = await f.writeAt(0);
		expect(firstWrite.revision).toBe(1);

		f.state.revision = 2;
		f.timeline.emit();
		const second = f.save.flush().then(() => { secondFinished = true; });
		await tick();
		expect(firstFinished).toBe(false);
		expect(secondFinished).toBe(false);
		expect(f.writes).toHaveLength(1);

		firstWrite.succeed();
		const secondWrite = await f.writeAt(1);
		expect(secondWrite.revision).toBe(2);
		expect(firstFinished).toBe(false);
		expect(secondFinished).toBe(false);

		f.state.revision = 3;
		f.scenes.emit();
		secondWrite.succeed();
		const thirdWrite = await f.writeAt(2);
		expect(thirdWrite.revision).toBe(3);
		expect(secondFinished).toBe(false);
		thirdWrite.succeed();
		await Promise.all([first, second]);

		expect(f.persisted).toEqual([1, 2, 3]);
		expect(f.state.peakWrites).toBe(1);
		expect(f.save.getIsDirty()).toBe(false);
		expect(f.save.getIsSaving()).toBe(false);
	});

	test("background saves coalesce queued changes without overlapping storage writes", async () => {
		const f = fixture({ debounceMs: 1 });
		f.timeline.emit();
		const first = await f.writeAt(0);
		f.state.revision = 2;
		f.timeline.emit();
		f.state.revision = 3;
		f.scenes.emit();
		expect(f.writes).toHaveLength(1);
		first.succeed();
		const second = await f.writeAt(1);
		expect(second.revision).toBe(3);
		second.succeed();
		await waitForState(f.save, () => !f.save.getIsDirty());
		expect(f.persisted).toEqual([1, 3]);
		expect(f.state.peakWrites).toBe(1);
	});

	test("failed writes reject all flush waiters and preserve dirty data for retry", async () => {
		const f = fixture();
		const error = new Error("disk full");
		const first = f.save.flush();
		const firstWrite = await f.writeAt(0);
		f.state.revision = 2;
		f.scenes.emit();
		const second = f.save.flush();
		const failed = Promise.allSettled([first, second]);
		firstWrite.fail(error);
		for (const result of await failed) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") expect(result.reason).toBe(error);
		}
		expect(f.save.getIsDirty()).toBe(true);
		expect(f.save.getIsSaving()).toBe(false);
		expect(f.save.getLastError()).toBe(error);
		expect(f.persisted).toEqual([]);

		const retry = f.save.flush();
		const retriedWrite = await f.writeAt(1);
		expect(retriedWrite.revision).toBe(2);
		expect(f.save.getLastError()).toBeNull();
		retriedWrite.succeed();
		await retry;
		expect(f.persisted).toEqual([2]);
		expect(f.save.getIsDirty()).toBe(false);
		expect(f.state.peakWrites).toBe(1);
	});

	test("timer failures stay observable without an unhandled rejection or retry loop", async () => {
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			const f = fixture({ debounceMs: 1 });
			f.timeline.emit();
			const write = await f.writeAt(0);
			write.fail(new Error("storage unavailable"));
			await waitForState(f.save, () => f.save.getLastError() !== null);
			await tick(10);
			expect(log).toHaveBeenCalledTimes(1);
			expect(f.writes).toHaveLength(1);
			expect(f.save.getIsDirty()).toBe(true);
			expect(f.save.getIsSaving()).toBe(false);
			expect(f.save.getLastError()?.message).toBe("storage unavailable");
		} finally {
			log.mockRestore();
		}
	});

	test("pause cancels a scheduled save and resume persists its pending work", async () => {
		const f = fixture({ debounceMs: 1 });
		f.timeline.emit();
		f.save.pause();
		await tick(10);
		expect(f.writes).toHaveLength(0);
		expect(f.save.getIsDirty()).toBe(true);
		await expect(f.save.flush()).rejects.toThrow("paused");
		expect(f.writes).toHaveLength(0);

		f.save.resume();
		(await f.writeAt(0)).succeed();
		await waitForState(f.save, () => !f.save.getIsDirty());
		expect(f.persisted).toEqual([1]);
	});

	test("paused hydration notifications are ignored but forced repairs survive resume", async () => {
		const f = fixture({ debounceMs: 1 });
		f.save.pause();
		f.state.revision = 2;
		f.timeline.emit();
		f.scenes.emit();
		expect(f.save.getIsDirty()).toBe(false);
		f.save.markDirty({ force: true });
		await tick(10);
		expect(f.save.getIsDirty()).toBe(true);
		expect(f.writes).toHaveLength(0);
		f.save.resume();
		const write = await f.writeAt(0);
		expect(write.revision).toBe(2);
		write.succeed();
		await waitForState(f.save, () => !f.save.getIsDirty());
	});

	test("pause during an active write prevents the queued write until resume", async () => {
		const f = fixture({ debounceMs: 1 });
		const flushing = f.save.flush();
		const first = await f.writeAt(0);
		f.state.revision = 2;
		f.timeline.emit();
		f.save.pause();
		const blocked = Promise.allSettled([flushing]);
		first.succeed();
		const [result] = await blocked;
		expect(result?.status).toBe("rejected");
		if (result?.status === "rejected") {
			expect(result.reason.message).toContain("paused");
		}
		expect(f.writes).toHaveLength(1);
		expect(f.save.getIsDirty()).toBe(true);
		f.save.resume();
		const second = await f.writeAt(1);
		expect(second.revision).toBe(2);
		second.succeed();
		await waitForState(f.save, () => !f.save.getIsDirty());
		expect(f.state.peakWrites).toBe(1);
	});

	test("loading and migration guards cannot falsely complete a dirty flush", async () => {
		const f = fixture({ debounceMs: 1 });
		f.state.loading = true;
		f.timeline.emit();
		await expect(f.save.flush()).rejects.toThrow("loading");
		expect(f.save.getIsDirty()).toBe(true);
		expect(f.writes).toHaveLength(0);
		f.state.loading = false;
		f.state.migrating = true;
		await expect(f.save.flush()).rejects.toThrow("migration");
		expect(f.writes).toHaveLength(0);
		f.state.migrating = false;
		f.projectChanges.emit();
		(await f.writeAt(0)).succeed();
		await waitForState(f.save, () => !f.save.getIsDirty());
	});

	test("save subscribers observe dirty, saving and clean transitions and can unsubscribe", async () => {
		const f = fixture();
		const observed: Array<[boolean, boolean]> = [];
		const unsubscribe = f.save.subscribe(() => {
			observed.push([f.save.getIsDirty(), f.save.getIsSaving()]);
		});
		f.timeline.emit();
		const flushing = f.save.flush();
		(await f.writeAt(0)).succeed();
		await flushing;
		expect(observed).toContainEqual([true, false]);
		expect(observed).toContainEqual([true, true]);
		expect(observed.at(-1)).toEqual([false, false]);
		unsubscribe();
		const before = observed.length;
		f.timeline.emit();
		expect(observed).toHaveLength(before);
	});

	test("notifications after closing a project do not create unsaveable dirty state", async () => {
		const f = fixture({ debounceMs: 1 });
		f.state.active = false;
		f.scenes.emit();
		f.timeline.emit();
		await f.save.flush();
		await tick(5);
		expect(f.writes).toHaveLength(0);
		expect(f.save.getIsDirty()).toBe(false);
	});
});
