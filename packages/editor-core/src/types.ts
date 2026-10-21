/** Original editor domain contract. No UI, filesystem, codec or legacy editor imports. */
export const TIMEBASE = 240_000;
export type Tick = number;
export interface FrameRate { numerator: number; denominator: number }
export interface Asset {
  id: string; name: string; kind: "video" | "audio" | "image";
  duration: Tick; width?: number; height?: number; frameRate?: FrameRate;
  hasAudio: boolean; url: string; proxyUrl?: string; thumbnail?: string; peaks?: number[];
}
export interface Transform { x: number; y: number; scale: number; rotation: number }
export interface ColorAdjustments { brightness: number; contrast: number; saturation: number }
export interface TextStyle { content: string; fontFamily: string; fontSize: number; color: string; background: string; align: "left" | "center" | "right" }
export interface Keyframe { id: string; time: Tick; property: "x" | "y" | "scale" | "rotation" | "opacity" | "volume"; value: number; easing: "linear" | "hold" | "smooth" }
export interface Clip {
  id: string; name: string; kind: Asset["kind"] | "text"; assetId?: string;
  start: Tick; duration: Tick; sourceIn: Tick; speed: number;
  volume: number; opacity: number; transform: Transform; color: ColorAdjustments;
  fadeIn: Tick; fadeOut: Tick; text?: TextStyle; keyframes: Keyframe[];
}
export interface Track { id: string; name: string; kind: "video" | "audio" | "text"; muted: boolean; locked: boolean; clips: Clip[] }
export interface CaptionWord { text: string; start: Tick; end: Tick }
export interface Caption { id: string; start: Tick; end: Tick; text: string; words?: CaptionWord[] }
export interface Marker { id: string; time: Tick; label: string; color: string }
export interface ProjectSettings { width: number; height: number; frameRate: FrameRate; sampleRate: 48000; background: string }
export interface Project {
  schemaVersion: 1; id: string; name: string; revision: number; createdAt: string; updatedAt: string;
  settings: ProjectSettings; assets: Record<string, Asset>; tracks: Track[]; captions: Caption[]; markers: Marker[];
}
export type Command =
  | { type: "asset.add"; assets: Asset[] }
  | { type: "asset.update"; assetId: string; patch: Partial<Omit<Asset, "id">> }
  | { type: "clip.add"; trackId: string; clip: Clip }
  | { type: "clip.remove"; clipIds: string[]; ripple?: boolean }
  | { type: "clip.split"; clipId: string; time: Tick; rightId: string }
  | { type: "clip.move"; clipId: string; trackId: string; start: Tick }
  | { type: "clip.trim"; clipId: string; edge: "in" | "out"; time: Tick }
  | { type: "clip.update"; clipId: string; patch: Partial<Omit<Clip, "id" | "assetId" | "kind">> }
  | { type: "clip.duplicate"; clipId: string; newId: string; start?: Tick }
  | { type: "track.add"; track: Track }
  | { type: "track.update"; trackId: string; patch: Partial<Pick<Track,"name" | "muted" | "locked">> }
  | { type: "project.rename"; name: string }
  | { type: "project.settings"; patch: Partial<ProjectSettings> }
  | { type: "captions.replace"; captions: Caption[] }
  | { type: "caption.update"; captionId: string; patch: Partial<Pick<Caption,"text" | "start" | "end">> }
  | { type: "marker.add"; marker: Marker }
  | { type: "keyframe.set"; clipId: string; keyframe: Keyframe }
  | { type: "batch"; commands: Command[]; label?: string };
export interface RenderSegment { trackId: string; trackIndex: number; clip: Clip; asset?: Asset }
export interface RenderPlan { schemaVersion: 1; settings: ProjectSettings; duration: Tick; segments: RenderSegment[]; captions: Caption[] }
export interface Job { id: string; type: "export" | "proxy" | "silence" | "transcription"; status: "queued" | "running" | "completed" | "failed" | "cancelled"; progress: number; message?: string; output?: string; result?: unknown }
export interface ProjectListing { id: string; name: string; updatedAt: string; version: number; duration: Tick }
export interface EditorHost {
  getEnvironment(): Promise<{ ffmpeg: boolean; ffprobe: boolean; version: string; profile: string; encoders: string[]; localTranscription?: boolean; transcriptionModel?: string }>;
  listProjects(): Promise<ProjectListing[]>;
  openProject(id: string): Promise<{ project: Project; version: number }>;
  saveProject(input: { project: Project; expectedVersion: number | null }): Promise<{ version: number }>;
  importMedia(): Promise<Asset[]>;
  importCaptions(): Promise<Caption[]>;
  exportProject(input: { project: Project; preset: "mp4-h264" | "webm-vp9" }): Promise<Job | null>;
  createProxy(assetId: string): Promise<Job>;
  analyzeSilence(assetId: string): Promise<Job>;
  transcribeAsset(assetId: string): Promise<Job>;
  cancelJob(id: string): Promise<void>;
  onJobs(callback: (job: Job) => void): () => void;
  onCloseRequested(callback: () => void): () => void;
  respondToClose(result: { saved: boolean; error?: string }): void;
}
