import { useEffect, useMemo, useRef, useState } from "react";
import { buildRenderPlan, evaluateClip } from "@core";
import type { Asset, Project, RenderPlan } from "@core";
import { sourceSeconds } from "./clip-edits";

type Media = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;
interface Entry { url: string; element: Media; gain?: GainNode; source?: MediaElementAudioSourceNode }
export function Preview({ project, time, playing }: { project: Project; time: number; playing: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const media = useRef(new Map<string, Entry>());
  const audio = useRef<AudioContext | null>(null);
  const generation = useRef(0);
  const renderSerial = useRef(0);
  const paint = useRef<() => void>(() => {});
  const [waiting, setWaiting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const plan = useMemo(() => buildRenderPlan(project), [project]);

  useEffect(() => () => {
    for (const { element, source, gain } of media.current.values()) {
      if (!(element instanceof HTMLImageElement)) { element.pause(); element.removeAttribute("src"); element.load(); }
      source?.disconnect(); gain?.disconnect();
    }
    media.current.clear();
    void audio.current?.close(); audio.current = null;
  }, [project.id]);

  useEffect(() => {
    let disposed = false;
    const current = ++generation.current;
    const active = plan.segments.filter(segment => time >= segment.clip.start && time < segment.clip.start + segment.clip.duration);
    const activeIds = new Set(active.map(segment => segment.clip.id));
    const validIds = new Set(plan.segments.map(segment => segment.clip.id));
    for (const [id, entry] of media.current) {
      if (!activeIds.has(id) && !(entry.element instanceof HTMLImageElement)) entry.element.pause();
      if (!validIds.has(id)) { if (!(entry.element instanceof HTMLImageElement)) { entry.element.removeAttribute("src"); entry.element.load(); } entry.source?.disconnect(); entry.gain?.disconnect(); media.current.delete(id); }
    }
    const ensure = (id: string, asset: Asset): Media => {
      const url = asset.proxyUrl || asset.url;
      const cached = media.current.get(id);
      if (cached?.url === url) return cached.element;
      if (cached && !(cached.element instanceof HTMLImageElement)) cached.element.pause();
      cached?.source?.disconnect(); cached?.gain?.disconnect();
      let element: Media;
      if (asset.kind === "image") {
        element = new Image();
        element.onload = () => paint.current();
      } else {
        element = document.createElement(asset.kind === "video" ? "video" : "audio");
        element.preload = "auto";
        if (element instanceof HTMLVideoElement) element.playsInline = true;
        element.addEventListener("loadeddata", () => paint.current());
        element.addEventListener("seeked", () => paint.current());
      }
      element.crossOrigin = "anonymous";
      element.onerror = () => setFailure(`Cannot decode “${asset.name}” in the preview. Native export may support additional codecs.`);
      element.src = url;
      const entry: Entry = { url, element };
      if (!(element instanceof HTMLImageElement)) {
        audio.current ??= new AudioContext({ sampleRate: 48000 });
        entry.source = audio.current.createMediaElementSource(element);
        entry.gain = audio.current.createGain();
        entry.source.connect(entry.gain); entry.gain.connect(audio.current.destination);
      }
      media.current.set(id, entry);
      return element;
    };
    const render = async () => {
      const invocation = ++renderSerial.current;
      const ready: Promise<boolean>[] = [];
      for (const segment of active) {
        const clip = evaluateClip(segment.clip, time - segment.clip.start);
        if (!segment.asset) continue;
        const element = ensure(clip.id, segment.asset);
        if (element instanceof HTMLImageElement) {
          continue;
        }
        element.volume = 1;
        const gain = media.current.get(clip.id)?.gain;
        if (gain) gain.gain.value = Math.max(0, Math.min(2, clip.volume));
        element.muted = clip.volume <= 0 || !segment.asset.hasAudio;
        element.playbackRate = Math.max(0.0625, Math.min(16, clip.speed));
        const target = sourceSeconds(clip, time);
        const desired = Number.isFinite(element.duration) ? Math.min(target, Math.max(0, element.duration - 0.001)) : target;
        const drift = Math.abs(element.currentTime - desired);
        if (element.readyState >= 1 && drift > (playing ? 0.12 : 0.001)) {
          if (!playing && element instanceof HTMLVideoElement) ready.push(waitForSeek(element, desired));
          else { try { element.currentTime = desired; } catch { /* Metadata has not arrived yet. */ } }
        } else if (!playing && element instanceof HTMLVideoElement && (element.seeking || element.readyState < 2)) ready.push(waitForFrame(element));
        if (playing) { if (audio.current?.state === "suspended") void audio.current.resume(); void element.play().catch(() => { /* User playback action will retry if decoding is not ready. */ }); }
        else element.pause();
      }
      if (!playing && ready.length) await Promise.all(ready);
      if (disposed || current !== generation.current || invocation !== renderSerial.current) return;
      // Assigning currentTime can temporarily drop readyState. Re-read it after
      // decoding rather than retaining the pre-seek flag forever. A newer
      // seeked/loadeddata invocation wins over this invocation's completion.
      const missingVisual = active.some(segment => {
        if (!segment.asset || segment.clip.kind === "audio") return false;
        const element = media.current.get(segment.clip.id)?.element;
        if (element instanceof HTMLImageElement) return !element.complete || !element.naturalWidth;
        return !element || element instanceof HTMLVideoElement && (element.readyState < 2 || !playing && element.seeking);
      });
      if (missingVisual) { setWaiting(true); return; } // Keep the last decoded frame during paused seeks.
      setWaiting(false);
      const target = canvas.current;
      if (target) {
        drawPlan(target, plan, active, media.current, time);
        target.dataset.renderedTick = String(time);
        target.dataset.renderedProject = project.id;
        target.dataset.renderedRevision = String(project.revision);
      }
    };
    const renderSafely = () => { void render().catch(error => { if (!disposed && current === generation.current) setFailure(error instanceof Error ? error.message : "Preview could not render this frame."); }); };
    paint.current = renderSafely;
    renderSafely();
    return () => { disposed = true; };
  }, [plan, time, playing]);

  return <div className="preview-stage">
    <div className="canvas-mat" style={{ aspectRatio: `${project.settings.width} / ${project.settings.height}` }}>
      <canvas ref={canvas} width={project.settings.width} height={project.settings.height} aria-label="Project preview" />
      {waiting && <span className="preview-badge">Decoding frame…</span>}
    </div>
    {failure && <button className="preview-error" onClick={() => setFailure(null)} title="Dismiss">{failure} ×</button>}
  </div>;
}

function waitForSeek(element: HTMLVideoElement, time: number): Promise<boolean> {
  const waiting = waitForFrame(element);
  try { element.currentTime = time; } catch { return Promise.resolve(false); }
  return waiting;
}

function waitForFrame(element: HTMLVideoElement): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer);
      element.removeEventListener("seeked", finish); element.removeEventListener("loadeddata", finish); element.removeEventListener("error", finish);
      resolve(element.readyState >= 2 && !element.seeking);
    };
    const timer = setTimeout(finish, 800);
    element.addEventListener("seeked", finish, { once: true });
    element.addEventListener("loadeddata", finish, { once: true });
    element.addEventListener("error", finish, { once: true });
  });
}

function drawPlan(canvas: HTMLCanvasElement, plan: RenderPlan, active: RenderPlan["segments"], entries: Map<string, Entry>, time: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = plan.settings;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.filter = "none"; ctx.globalAlpha = 1;
  ctx.fillStyle = plan.settings.background; ctx.fillRect(0, 0, width, height);
  for (const segment of active) {
    const clip = evaluateClip(segment.clip, time - segment.clip.start);
    if (clip.kind === "audio") continue;
    ctx.save();
    ctx.translate(width / 2 + clip.transform.x, height / 2 + clip.transform.y);
    ctx.rotate(clip.transform.rotation * Math.PI / 180);
    ctx.scale(clip.transform.scale, clip.transform.scale);
    ctx.globalAlpha = Math.max(0, Math.min(1, clip.opacity));
    ctx.filter = `brightness(${clip.color.brightness}) contrast(${clip.color.contrast}) saturate(${clip.color.saturation})`;
    if (clip.kind === "text" && clip.text) {
      const text = clip.text;
      ctx.font = `400 ${text.fontSize}px ${JSON.stringify(text.fontFamily)}, sans-serif`;
      ctx.textAlign = text.align; ctx.textBaseline = "middle";
      const lines = text.content.split("\n");
      const lineHeight = text.fontSize * 1.25;
      const textWidth = Math.max(...lines.map(line => ctx.measureText(line).width), 0);
      const boxX = text.align === "left" ? 0 : text.align === "right" ? -textWidth : -textWidth / 2;
      if (text.background && text.background !== "transparent") { ctx.fillStyle = text.background; ctx.fillRect(boxX - 16, -lines.length * lineHeight / 2 - 8, textWidth + 32, lines.length * lineHeight + 16); }
      ctx.fillStyle = text.color;
      lines.forEach((line, index) => ctx.fillText(line, 0, (index - (lines.length - 1) / 2) * lineHeight));
    } else {
      const media = entries.get(clip.id)?.element;
      if (media && !(media instanceof HTMLAudioElement)) {
        const mw = media instanceof HTMLImageElement ? media.naturalWidth : media.videoWidth;
        const mh = media instanceof HTMLImageElement ? media.naturalHeight : media.videoHeight;
        if (mw && mh) { const scale = Math.min(width / mw, height / mh); try { ctx.drawImage(media, -mw * scale / 2, -mh * scale / 2, mw * scale, mh * scale); } catch { /* Retain the other layers if a decoded frame expires. */ } }
      }
    }
    ctx.restore();
  }
  const captions = plan.captions.filter(item => time >= item.start && time < item.end);
  for (const caption of captions) {
    const size = Math.max(20, height * 0.042);
    ctx.font = `400 ${size}px Arial, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const lines = caption.text.split("\n");
    const y = height * 0.88;
    lines.forEach((line, i) => { const cy = y + i * size * 1.22; ctx.lineWidth = size * 0.15; ctx.strokeStyle = "#101018"; ctx.strokeText(line, width / 2, cy); ctx.fillStyle = "#ffffff"; ctx.fillText(line, width / 2, cy); });
  }
  ctx.restore();
}
