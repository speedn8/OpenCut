import type { EditorCore } from "@/core";

type SaveManagerOptions = {
	debounceMs?: number;
};

export class SaveManager {
	private debounceMs: number;
	private isPaused = false;
	private isSaving = false;
	private hasPendingSave = false;
	private inFlightSave: Promise<void> | null = null;
	private lastError: Error | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];
	private listeners = new Set<() => void>();

	constructor({
		editor,
		debounceMs = 800,
	}: {
		editor: EditorCore;
	} & SaveManagerOptions) {
		this.editor = editor;
		this.debounceMs = debounceMs;
	}

	private editor: EditorCore;

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => {
				this.markDirty();
			}),
			this.editor.project.subscribe(() => {
				if (this.hasPendingSave) this.queueSave();
			}),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
	}

	pause(): void {
		this.isPaused = true;
		this.clearTimer();
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasPendingSave) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		if (!this.editor.project.getActiveOrNull()) return;
		this.hasPendingSave = true;
		this.notify();
		this.queueSave();
	}

	async flush(): Promise<void> {
		if (this.editor.project.getActiveOrNull()) {
			this.hasPendingSave = true;
			this.notify();
		}
		this.clearTimer();

		// A flush is a durability barrier, including edits queued during a write.
		while (this.inFlightSave || this.hasPendingSave) {
			if (!this.inFlightSave) {
				const blocked = this.getSaveBlockReason();
				if (blocked) throw new Error(blocked);
			}
			await this.saveNow();
		}
	}

	getIsDirty(): boolean {
		return this.hasPendingSave || this.isSaving;
	}

	getIsSaving(): boolean {
		return this.isSaving;
	}

	getLastError(): Error | null {
		return this.lastError;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private queueSave(): void {
		if (this.isPaused || this.inFlightSave) return;
		this.clearTimer();
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			// Timer callers cannot await the error; retain it for the save indicator
			// and leave pending changes available for an explicit retry/flush.
			void this.saveNow().catch((error) => {
				console.error("Autosave failed:", error);
			});
		}, this.debounceMs);
	}

	private saveNow(): Promise<void> {
		if (this.inFlightSave) return this.inFlightSave;
		if (!this.hasPendingSave || this.getSaveBlockReason()) {
			return Promise.resolve();
		}

		this.isSaving = true;
		this.clearTimer();
		// Publish the shared promise before invoking storage or subscribers, so
		// concurrent/reentrant flushes join this drain instead of starting a write.
		this.inFlightSave = Promise.resolve()
			.then(async () => {
				while (this.hasPendingSave && !this.getSaveBlockReason()) {
					this.hasPendingSave = false;
					this.lastError = null;
					this.notify();
					try {
						await this.editor.project.saveCurrentProject();
					} catch (error) {
						this.hasPendingSave = true;
						this.lastError =
							error instanceof Error ? error : new Error(String(error));
						throw error;
					}
				}
			})
			.finally(() => {
				this.inFlightSave = null;
				this.isSaving = false;
				this.notify();
			});
		this.notify();
		return this.inFlightSave;
	}

	private getSaveBlockReason(): string | null {
		if (this.isPaused) return "Project saving is paused";
		if (!this.editor.project.getActiveOrNull()) return "No active project to save";
		if (this.editor.project.getIsLoading()) return "Project is still loading";
		if (this.editor.project.getMigrationState().isMigrating) {
			return "Project migration is still running";
		}
		return null;
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}
