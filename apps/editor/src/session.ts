import { EditorStore, createProject, validateProject, projectDuration } from "@core";
import type { Project, ProjectListing, Command, EditorHost, Job } from "@core";

export type Environment = Awaited<ReturnType<EditorHost["getEnvironment"]>>;
export interface SessionSnapshot {
  project: Project | null;
  projects: ProjectListing[];
  environment: Environment | null;
  jobs: Job[];
  dirty: boolean;
  saving: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

/** Owns the project boundary and the one serialized CAS writer. No filesystem API. */
export class EditorSession {
  private state: SessionSnapshot = { project: null, projects: [], environment: null, jobs: [], dirty: false, saving: false, busy: false, error: null, notice: null, canUndo: false, canRedo: false };
  private listeners = new Set<() => void>();
  private store: EditorStore | null = null;
  private detachStore?: () => void;
  private savedProject: Project | null = null;
  private version: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private saving: Promise<void> | null = null;
  private switchBusy = false;
  private copying = false;
  private pendingSwitch: Promise<void> | null = null;
  private pendingMutations = new Set<Promise<unknown>>();
  private booted = false;
  constructor(readonly host: EditorHost) {}
  getSnapshot = (): SessionSnapshot => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<SessionSnapshot>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  clearError = () => this.publish({ error: null });
  inform(notice: string) { this.publish({ notice, error: null }); }
  fail(error: unknown) { this.publish({ error: message(error), notice: null }); }
  async boot() {
    if (this.booted) return;
    this.booted = true;
    const results = await Promise.allSettled([this.host.getEnvironment(), this.host.listProjects()]);
    if (results[0].status === "fulfilled") this.publish({ environment: results[0].value });
    else this.fail(results[0].reason);
    if (results[1].status === "fulfilled") this.publish({ projects: results[1].value });
    else this.fail(results[1].reason);
  }
  receiveJob(job: Job) {
    const jobs = [...this.state.jobs];
    const index = jobs.findIndex(item => item.id === job.id);
    if (index < 0) jobs.unshift(job);
    else {
      const previous = jobs[index];
      const terminal = (status: Job["status"]) => ["completed", "failed", "cancelled"].includes(status);
      if (terminal(previous.status) || previous.status === "running" && job.status === "queued") return;
      jobs[index] = { ...job, progress: job.status === previous.status ? Math.max(previous.progress, job.progress) : job.progress };
    }
    this.publish({ jobs });
  }
  dispatch(command: Command): boolean {
    if (!this.store || this.switchBusy) return false;
    return this.apply(command);
  }
  private apply(command: Command): boolean {
    if (!this.store) return false;
    try { this.store.dispatch(command); return true; } catch (error) { this.fail(error); return false; }
  }
  undo() { if (!this.switchBusy) { try { this.store?.undo(); } catch (error) { this.fail(error); } } }
  redo() { if (!this.switchBusy) { try { this.store?.redo(); } catch (error) { this.fail(error); } } }
  private attach(project: Project, version: number | null) {
    this.detachStore?.();
    if (this.timer) clearTimeout(this.timer);
    this.version = version;
    this.store = new EditorStore(project);
    this.savedProject = version === null ? null : this.store.getSnapshot();
    this.detachStore = this.store.subscribe(() => this.changed());
    this.publish({ project: this.store.getSnapshot(), dirty: version === null, canUndo: false, canRedo: false, error: null, notice: null });
    if (version === null) this.schedule();
  }
  private changed() {
    if (!this.store) return;
    const project = this.store.getSnapshot();
    this.publish({ project, dirty: project !== this.savedProject, canUndo: this.store.canUndo(), canRedo: this.store.canRedo(), error: null });
    this.schedule();
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(error => this.fail(error)); }, 650);
  }
  /** Includes revisions that arrive while a write is in flight. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.copying && this.pendingSwitch) { await this.pendingSwitch; return; }
    if (!this.store) return;
    if (!this.saving) {
      this.publish({ saving: true });
      this.saving = Promise.resolve().then(async () => {
        while (this.store && this.store.getSnapshot() !== this.savedProject) {
          const snapshot = this.store.getSnapshot();
          const result = await this.host.saveProject({ project: structuredClone(snapshot), expectedVersion: this.version });
          this.version = result.version;
          this.savedProject = snapshot;
          const listing: ProjectListing = { id: snapshot.id, name: snapshot.name, updatedAt: snapshot.updatedAt, version: result.version, duration: projectDuration(snapshot) };
          this.publish({ dirty: this.store.getSnapshot() !== snapshot, projects: [listing, ...this.state.projects.filter(item => item.id !== snapshot.id)], error: null });
        }
      }).catch(error => { this.fail(error); throw error; }).finally(() => {
        this.saving = null;
        this.publish({ saving: false, dirty: Boolean(this.store && this.store.getSnapshot() !== this.savedProject) });
      });
    }
    await this.saving;
    // Another subscriber may have queued an edit as the prior drain completed.
    if (this.store && this.store.getSnapshot() !== this.savedProject) await this.flush();
  }
  async create(name: string, width = 1920, height = 1080) {
    await this.changeProject(async () => { this.attach(createProject({ name: name.trim() || "Untitled film", width, height }), null); });
    await this.flush();
  }
  async open(id: string) {
    if (this.state.project?.id === id) return;
    await this.changeProject(async () => {
      const result = await this.host.openProject(id);
      const project = validateProject(result.project);
      this.attach(project, result.version);
    });
  }
  async saveCopy() {
    if (this.switchBusy) throw new Error("Finish the current project operation before saving a copy.");
    this.switchBusy = true;
    this.copying = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.publish({ busy: true });
    const operation = (async () => {
      await Promise.all([...this.pendingMutations]);
      // A failed original write is exactly why Save a copy exists. It must not
      // reuse the stale version or overwrite the independently saved original.
      if (this.saving) await this.saving.catch(() => {});
      const source = this.store?.getSnapshot();
      if (!source) throw new Error("Open a project before saving a copy.");
      const now = new Date().toISOString();
      const copy = validateProject({ ...structuredClone(source), id: uid(), name: `${source.name} copy`, revision: 0, createdAt: now, updatedAt: now });
      const saved = await this.host.saveProject({ project: copy, expectedVersion: null });
      this.attach(copy, saved.version);
      const listing: ProjectListing = { id: copy.id, name: copy.name, updatedAt: copy.updatedAt, version: saved.version, duration: projectDuration(copy) };
      this.publish({ projects: [listing, ...this.state.projects], notice: "Saved your complete edit as a new project. The original project was preserved." });
    })();
    this.pendingSwitch = operation;
    try { await operation; } catch (error) { this.fail(error); throw error; }
    finally { this.pendingSwitch = null; this.switchBusy = false; this.copying = false; this.publish({ busy: false }); }
  }
  private async changeProject(action: () => Promise<void>) {
    if (this.switchBusy) throw new Error("A project switch is already in progress.");
    this.switchBusy = true;
    this.publish({ busy: true });
    const operation = (async () => {
      // Finish already-open import dialogs before capturing the old project's
      // final save. Their results belong to that project even while UI is locked.
      await Promise.all([...this.pendingMutations]);
      await this.flush(); await action();
    })();
    this.pendingSwitch = operation;
    try { await operation; }
    catch (error) { this.fail(error); throw error; }
    finally { this.pendingSwitch = null; this.switchBusy = false; this.publish({ busy: false }); }
  }
  async prepareClose() {
    // A dialog/import or project-open reply must not attach data after save ACK.
    while (this.pendingSwitch || this.pendingMutations.size) {
      await Promise.all([...(this.pendingSwitch ? [this.pendingSwitch] : []), ...this.pendingMutations]);
    }
    await this.flush();
  }
  private async mutation<T>(action: () => Promise<T>): Promise<T> {
    const pending = action();
    this.pendingMutations.add(pending);
    try { return await pending; } finally { this.pendingMutations.delete(pending); }
  }
  async importMedia() {
    if (this.switchBusy) throw new Error("Finish switching projects before importing media.");
    return this.mutation(async () => {
    const projectId = this.state.project?.id;
    if (!projectId) throw new Error("Create or open a project first.");
    const assets = await this.host.importMedia();
    if (this.state.project?.id !== projectId) throw new Error("Project changed during import. Import again into the current project.");
    if (assets.length && !this.apply({ type: "asset.add", assets })) throw new Error("Imported media could not be added to the project.");
    return assets;
    });
  }
  async importCaptions() {
    if (this.switchBusy) throw new Error("Finish switching projects before importing captions.");
    return this.mutation(async () => {
    const projectId = this.state.project?.id;
    const captions = await this.host.importCaptions();
    if (!projectId || this.state.project?.id !== projectId) throw new Error("Project changed during caption import.");
    if (captions.length && !this.apply({ type: "captions.replace", captions })) throw new Error("Imported captions could not be added to the project.");
    });
  }
  async export(preset: "mp4-h264" | "webm-vp9") {
    if (this.switchBusy) throw new Error("Finish switching projects before exporting.");
    await this.flush();
    const project = this.state.project;
    if (!project) throw new Error("Open a project first.");
    const job = await this.host.exportProject({ project: structuredClone(project), preset });
    if (job) this.receiveJob(job);
  }
}
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export const uid = () => crypto.randomUUID();
