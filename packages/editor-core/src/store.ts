import type { Command, Project } from "./types";
import { applyCommand } from "./commands";
import { ensure } from "./errors";
import { validateProject } from "./model";

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export class EditorStore {
  private project: Project;
  private past: Project[] = [];
  private future: Project[] = [];
  private listeners = new Set<() => void>();
  private readonly historyLimit: number;
  constructor(project: Project, private readonly options: { historyLimit?: number; onListenerError?: (error: unknown) => void } = {}) {
    this.historyLimit = options.historyLimit ?? 100; ensure(Number.isSafeInteger(this.historyLimit) && this.historyLimit >= 0 && this.historyLimit <= 10_000, "historyLimit must be 0..10000");
    this.project = freeze(validateProject(project));
  }
  getSnapshot = (): Project => this.project;
  canUndo = (): boolean => this.past.length > 0;
  canRedo = (): boolean => this.future.length > 0;
  subscribe = (callback: () => void): (() => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private notify() { for (const callback of [...this.listeners]) try { callback(); } catch (error) { try { this.options.onListenerError?.(error); } catch { /* A listener cannot invalidate a committed edit. */ } } }
  dispatch = (command: Command): Project => {
    const next = freeze(applyCommand(this.project, command));
    if (this.historyLimit) { this.past.push(this.project); if (this.past.length > this.historyLimit) this.past.shift(); }
    this.future = []; this.project = next; this.notify(); return next;
  };
  undo = (): Project => {
    const previous = this.past.at(-1); if (!previous) return this.project;
    const restored = freeze(validateProject({ ...previous, revision: this.project.revision + 1, updatedAt: new Date().toISOString() }));
    this.past.pop(); this.future.push(this.project); this.project = restored; this.notify(); return restored;
  };
  redo = (): Project => {
    const next = this.future.at(-1); if (!next) return this.project;
    const restored = freeze(validateProject({ ...next, revision: this.project.revision + 1, updatedAt: new Date().toISOString() }));
    this.future.pop(); if (this.historyLimit) this.past.push(this.project); this.project = restored; this.notify(); return restored;
  };
  replaceProject = (project: Project): Project => { const next = freeze(validateProject(project)); this.project = next; this.past = []; this.future = []; this.notify(); return next; };
}
