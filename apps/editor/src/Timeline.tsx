import { useEffect, useRef, useState } from "react";
import { projectDuration, secondsToTicks, ticksToSeconds, snapToFrame } from "@core";
import type { Clip, Project, Command } from "@core";
import { availableTrack, clipPeaks } from "./clip-edits";
import { uid } from "./session";

interface Drag { id: string; trackId: string; start: number; duration: number; edge?: "in" | "out" }
export function Timeline({ project, selected, select, time, seek, zoom, dispatch, addAsset }: {
  project: Project; selected: string | null; select(id: string | null): void; time: number; seek(time: number): void; zoom: number;
  dispatch(command: Command): boolean; addAsset(assetId: string, trackId?: string, start?: number): void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const currentDrag = useRef<Drag | null>(null);
  const release = useRef<() => void>(() => {});
  const viewport = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  useEffect(() => () => release.current(), []);
  const duration = Math.max(15, ticksToSeconds(projectDuration(project)) + 5, ticksToSeconds(time) + 3);
  const width = Math.max(600, duration * zoom);
  const interval = zoom < 30 ? 5 : zoom < 65 ? 2 : 1;
  const ruler = Array.from({ length: Math.ceil(duration / interval) + 1 }, (_, index) => index * interval);
  const snap = (tick: number) => Math.max(0, snapToFrame(tick, project.settings.frameRate));

  const begin = (event: React.PointerEvent, clip: Clip, trackId: string, edge?: "in" | "out") => {
    if (event.button !== 0) return;
    event.stopPropagation(); event.preventDefault(); select(clip.id);
    const origin = event.clientX;
    const initialScroll = viewport.current?.scrollLeft ?? 0;
    currentDrag.current = { id: clip.id, trackId, start: clip.start, duration: clip.duration, edge };
    const move = (pointer: PointerEvent) => {
      const delta = secondsToTicks((pointer.clientX - origin + (viewport.current?.scrollLeft ?? 0) - initialScroll) / zoom);
      let start = clip.start;
      let length = clip.duration;
      let destination = trackId;
      if (edge === "in") { start = snap(Math.min(clip.start + clip.duration - secondsToTicks(0.04), clip.start + delta)); length = clip.start + clip.duration - start; }
      else if (edge === "out") length = Math.max(secondsToTicks(0.04), snap(clip.start + clip.duration + delta) - clip.start);
      else {
        start = snap(clip.start + delta);
        const lane = document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest<HTMLElement>("[data-track-id]");
        const target = project.tracks.find(track => track.id === lane?.dataset.trackId);
        const source = project.tracks.find(track => track.id === trackId);
        if (target && !target.locked && target.kind === source?.kind) destination = target.id;
      }
      currentDrag.current = { id: clip.id, trackId: destination, start, duration: length, edge };
      setDrag(currentDrag.current);
    };
    const end = () => {
      const next = currentDrag.current;
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", cancel);
      currentDrag.current = null; setDrag(null);
      if (!next) return;
      if (edge) dispatch({ type: "clip.trim", clipId: clip.id, edge, time: edge === "in" ? next.start : next.start + next.duration });
      else if (next.start !== clip.start || next.trackId !== trackId) {
        const source = project.tracks.find(track => track.id === trackId);
        if (!source) return;
        const target = availableTrack(project, source.kind, next.start, clip.duration, next.trackId, clip.id);
        if (target) dispatch({ type: "clip.move", clipId: clip.id, trackId: target.id, start: next.start });
        else {
          const newTrack = uid();
          dispatch({ type: "batch", label: "Move to accessible layer", commands: [{ type: "track.add", track: { id: newTrack, name: `${source.name} layer`, kind: source.kind, locked: false, muted: false, clips: [] } }, { type: "clip.move", clipId: clip.id, trackId: newTrack, start: next.start }] });
        }
      }
    };
    const cancel = () => { currentDrag.current = null; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", cancel); setDrag(null); };
    release.current = cancel;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true }); window.addEventListener("pointercancel", cancel, { once: true });
  };
  const seekAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const update = (x: number) => seek(snap(secondsToTicks((x - rect.left) / zoom)));
    update(event.clientX);
    const move = (pointer: PointerEvent) => update(pointer.clientX);
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true });
  };
  return <div className="timeline-body">
    <div className="track-labels" ref={labels}><div className="track-ruler-label">TRACKS <span>↑ composite</span></div>{project.tracks.map((track, index) => <div className={`track-label ${track.locked ? "locked" : ""}`} key={track.id}>
      <div className={`track-kind ${track.kind}`}>{track.kind === "audio" ? "♫" : track.kind === "text" ? "T" : "▣"}</div>
      <div className="track-name"><strong>{track.name}</strong><small>{track.clips.length} clip{track.clips.length !== 1 && "s"} · layer {index + 1}</small></div>
      <button className={`micro-button ${track.muted ? "active" : ""}`} title={track.muted ? "Unmute track" : "Mute track"} aria-label={`Mute ${track.name}`} onClick={() => dispatch({ type: "track.update", trackId: track.id, patch: { muted: !track.muted } })}>M</button>
      <button className={`micro-button ${track.locked ? "active" : ""}`} title="Lock track" aria-label={`Lock ${track.name}`} onClick={() => dispatch({ type: "track.update", trackId: track.id, patch: { locked: !track.locked } })}>{track.locked ? "▣" : "◇"}</button>
    </div>)}</div>
    <div className="timeline-scroll" ref={viewport} onScroll={event => { if (labels.current) labels.current.scrollTop = event.currentTarget.scrollTop; }}>
      <div className="timeline-content" style={{ width }}>
        <div className="time-ruler" onPointerDown={seekAt}>{ruler.map(second => <span key={second} style={{ left: second * zoom }}><i />{clock(second)}</span>)}</div>
        {project.tracks.map(track => <div key={track.id} className={`track-lane ${track.kind} ${track.locked ? "locked" : ""}`} data-track-id={track.id}
          onDragOver={event => { if (!track.locked) event.preventDefault(); }}
          onDrop={event => { event.preventDefault(); if (track.locked) return; const id = event.dataTransfer.getData("application/x-opencut-asset"); if (id) addAsset(id, track.id, snap(secondsToTicks((event.clientX - event.currentTarget.getBoundingClientRect().left) / zoom))); }}
          onPointerDown={event => { select(null); seekAt(event); }}>
          {project.tracks.flatMap(sourceTrack => sourceTrack.clips.filter(clip => (drag?.id === clip.id ? drag.trackId : sourceTrack.id) === track.id).map(clip => {
            const preview = drag?.id === clip.id ? drag : clip;
            const asset = clip.assetId ? project.assets[clip.assetId] : undefined;
            return <div key={clip.id} className={`timeline-clip ${clip.kind} ${selected === clip.id ? "selected" : ""} ${drag?.id === clip.id ? "dragging" : ""}`}
              style={{ left: ticksToSeconds(preview.start) * zoom, width: Math.max(6, ticksToSeconds(preview.duration) * zoom) }}
              onPointerDown={event => !sourceTrack.locked && begin(event, clip, sourceTrack.id)}
              onClick={event => { event.stopPropagation(); select(clip.id); }} title={`${clip.name} · ${ticksToSeconds(clip.duration).toFixed(2)}s`}>
              <span className="clip-handle in" onPointerDown={event => !sourceTrack.locked && begin(event, clip, sourceTrack.id, "in")} />
              <span className="clip-title">{clip.kind === "audio" ? "♫" : clip.kind === "text" ? "T" : "▣"} {clip.name}</span>
              {asset?.thumbnail && clip.kind !== "audio" && <div className="clip-filmstrip" style={{ backgroundImage: `url(${JSON.stringify(asset.thumbnail)})` }} />}
              {(clip.kind === "audio" || asset?.hasAudio) && <Waveform peaks={clipPeaks(asset, clip)} />}
              {clip.keyframes.length > 0 && <span className="clip-keyframes">{clip.keyframes.filter(key => key.time >= 0 && key.time <= clip.duration).map(key => <i key={key.id} style={{ left: `${Math.min(100, key.time / clip.duration * 100)}%` }} />)}</span>}
              <span className="clip-handle out" onPointerDown={event => !sourceTrack.locked && begin(event, clip, sourceTrack.id, "out")} />
            </div>;
          }))}
          {!track.clips.length && <span className="lane-hint">Drop {track.kind === "text" ? "text" : "media"} here</span>}
        </div>)}
        {project.markers.map(marker => <div key={marker.id} className="timeline-marker" style={{ left: ticksToSeconds(marker.time) * zoom, color: marker.color }} title={marker.label}>◆</div>)}
        <div className="timeline-playhead" style={{ left: ticksToSeconds(time) * zoom }}><span /></div>
      </div>
    </div>
  </div>;
}
function Waveform({ peaks }: { peaks?: number[] }) {
  if (!peaks?.length) return <div className="waveform-pending">audio</div>;
  const values = peaks.length > 120 ? peaks.filter((_, index) => index % Math.ceil(peaks.length / 120) === 0) : peaks;
  return <svg className="waveform" viewBox={`0 0 ${values.length * 3} 28`} preserveAspectRatio="none" aria-label="Audio waveform">{values.map((peak, i) => <rect key={i} x={i * 3} y={14 - Math.min(1, Math.abs(peak)) * 12} width="1.5" height={Math.max(1, Math.min(1, Math.abs(peak)) * 24)} rx="0.5" />)}</svg>;
}
function clock(second: number) { return `${Math.floor(second / 60)}:${String(Math.floor(second % 60)).padStart(2, "0")}`; }
