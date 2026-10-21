import { useEffect, useState } from "react";
import { evaluateKeyframeProperty, secondsToTicks, ticksToSeconds, snapToFrame } from "@core";
import type { Clip, Command, Keyframe, Project } from "@core";
import { uid } from "./session";
import { speedPatch } from "./clip-edits";

export function Inspector({ project, clip, time, dispatch, seek, pause }: { project: Project; clip?: Clip; time: number; dispatch(command: Command): boolean; seek(time: number): void; pause(): void }) {
  const update = (patch: Partial<Omit<Clip, "id" | "assetId" | "kind">>) => { if (clip) dispatch({ type: "clip.update", clipId: clip.id, patch }); };
  const localTime = clip ? Math.max(0, Math.min(clip.duration, snapToFrame(time - clip.start, project.settings.frameRate))) : 0;
  const valueAt = (property: Keyframe["property"]) => clip ? evaluateKeyframeProperty(clip, property, localTime) : 0;
  const animate = (property: Keyframe["property"], value: number) => {
    if (!clip) return;
    if (clip.keyframes.some(key => key.property === property)) {
      const previous = clip.keyframes.find(key => key.property === property && key.time === localTime);
      dispatch({ type: "keyframe.set", clipId: clip.id, keyframe: { id: previous?.id ?? uid(), property, time: localTime, value, easing: previous?.easing ?? "linear" } });
    } else if (property === "opacity" || property === "volume") update({ [property]: value });
    else update({ transform: { ...clip.transform, [property]: value } });
  };
  const keyframe = (property: Keyframe["property"]) => {
    if (!clip) return;
    const previous = clip.keyframes.find(key => key.property === property && key.time === localTime);
    dispatch({ type: "keyframe.set", clipId: clip.id, keyframe: { id: previous?.id ?? uid(), property, time: localTime, value: valueAt(property), easing: previous?.easing ?? "linear" } });
  };
  return <aside className="inspector panel" onPointerDown={pause} onFocusCapture={pause}>
    <div className="panel-heading"><span>{clip ? "CLIP INSPECTOR" : "PROJECT SETTINGS"}</span><span className="tiny-tag">{clip ? clip.kind.toUpperCase() : "CANVAS"}</span></div>
    <div className="inspector-scroll">{clip ? <>
      <div className="inspector-title"><span className={`asset-symbol ${clip.kind}`}>{clip.kind === "audio" ? "♫" : clip.kind === "text" ? "T" : "▣"}</span><div><strong>{clip.name}</strong><small>{ticksToSeconds(clip.duration).toFixed(2)} s · {clip.keyframes.length} keyframes</small></div></div>
      <Section title="Timing"><NumberField label="Start" value={ticksToSeconds(clip.start)} suffix="s" min={0} onChange={value => dispatch({ type: "clip.move", clipId: clip.id, trackId: project.tracks.find(track => track.clips.some(item => item.id === clip.id))!.id, start: snapToFrame(secondsToTicks(value), project.settings.frameRate) })} />
        <NumberField label="Duration" value={ticksToSeconds(clip.duration)} suffix="s" min={0.04} onChange={value => dispatch({ type: "clip.trim", clipId: clip.id, edge: "out", time: clip.start + snapToFrame(secondsToTicks(value), project.settings.frameRate) })} />
        {clip.kind !== "text" && clip.kind !== "image" && <NumberField label="Speed" value={clip.speed} suffix="×" min={0.25} max={4} step={0.25} onChange={speed => update(speedPatch(clip, speed, project.settings.frameRate))} />}
      </Section>
      {clip.kind !== "audio" && <Section title="Transform" badge="ANIMATABLE">
        <NumberField label="Position X" value={valueAt("x")} suffix="px" step={1} onChange={x => animate("x", x)} keyframe={() => keyframe("x")} />
        <NumberField label="Position Y" value={valueAt("y")} suffix="px" step={1} onChange={y => animate("y", y)} keyframe={() => keyframe("y")} />
        <NumberField label="Scale" value={valueAt("scale")} suffix="×" step={0.05} min={0.01} max={8} onChange={scale => animate("scale", scale)} keyframe={() => keyframe("scale")} />
        <NumberField label="Rotation" value={valueAt("rotation")} suffix="°" step={1} onChange={rotation => animate("rotation", rotation)} keyframe={() => keyframe("rotation")} />
        <NumberField label="Opacity" value={valueAt("opacity") * 100} suffix="%" min={0} max={100} step={1} onChange={value => animate("opacity", value / 100)} keyframe={() => keyframe("opacity")} />
      </Section>}
      {clip.kind !== "audio" && <Section title="Color"><NumberField label="Brightness" value={clip.color.brightness} min={0} max={2} step={0.05} onChange={brightness => update({ color: { ...clip.color, brightness } })} /><NumberField label="Contrast" value={clip.color.contrast} min={0} max={2} step={0.05} onChange={contrast => update({ color: { ...clip.color, contrast } })} /><NumberField label="Saturation" value={clip.color.saturation} min={0} max={2} step={0.05} onChange={saturation => update({ color: { ...clip.color, saturation } })} /><button className="text-button" onClick={() => update({ color: { brightness: 1, contrast: 1, saturation: 1 } })}>Reset color</button></Section>}
      {(clip.kind === "audio" || clip.kind === "video") && <Section title="Audio"><NumberField label="Volume" value={valueAt("volume") * 100} suffix="%" min={0} max={200} step={1} onChange={value => animate("volume", value / 100)} keyframe={() => keyframe("volume")} /><NumberField label="Fade in" value={ticksToSeconds(clip.fadeIn)} suffix="s" min={0} max={ticksToSeconds(clip.duration)} onChange={value => update({ fadeIn: secondsToTicks(value) })} /><NumberField label="Fade out" value={ticksToSeconds(clip.fadeOut)} suffix="s" min={0} max={ticksToSeconds(clip.duration)} onChange={value => update({ fadeOut: secondsToTicks(value) })} /></Section>}
      {clip.text && <Section title="Typography"><textarea className="text-content" aria-label="Text content" value={clip.text.content} onChange={event => update({ text: { ...clip.text!, content: event.target.value } })} rows={4} /><label className="field"><span>Typeface</span><select value={clip.text.fontFamily} onChange={event => update({ text: { ...clip.text!, fontFamily: event.target.value } })}>{[...new Set([clip.text.fontFamily, "Arial", "Segoe UI", "Times New Roman", "Consolas", "Calibri"])].map(font => <option key={font}>{font}</option>)}</select></label><NumberField label="Size" value={clip.text.fontSize} suffix="px" min={8} max={500} step={1} onChange={fontSize => update({ text: { ...clip.text!, fontSize } })} /><ColorField label="Text color" value={clip.text.color} onChange={color => update({ text: { ...clip.text!, color } })} /><label className="field"><span>Align</span><select value={clip.text.align} onChange={event => update({ text: { ...clip.text!, align: event.target.value as "left" | "center" | "right" } })}><option>left</option><option>center</option><option>right</option></select></label></Section>}
      <Section title="Keyframes" badge={`${clip.keyframes.length}`}><p className="help">Use ◇ to enable a property. Later edits add a key at the playhead. Keyframes use clip-local time.</p>{clip.keyframes.length ? clip.keyframes.filter(key => key.time >= 0 && key.time <= clip.duration).map(key => <div className="keyframe-row" key={key.id}><button onClick={() => seek(clip.start + key.time)}>◆ {key.property} <small>{ticksToSeconds(key.time).toFixed(2)}s</small></button><select aria-label={`${key.property} easing`} value={key.easing} onChange={event => update({ keyframes: clip.keyframes.map(item => item.id === key.id ? { ...item, easing: event.target.value as Keyframe["easing"] } : item) })}><option>linear</option><option>smooth</option><option>hold</option></select><button aria-label="Remove keyframe" onClick={() => update({ keyframes: clip.keyframes.filter(item => item.id !== key.id) })}>×</button></div>) : <div className="empty-subtle">No animation yet</div>}</Section>
    </> : <>
      <div className="project-spec"><div className="spec-canvas">{project.settings.width}<br /><span>× {project.settings.height}</span></div><strong>{project.name}</strong><small>Your local, editable source project</small></div>
      <Section title="Canvas"><NumberField label="Width" value={project.settings.width} min={64} max={7680} step={2} suffix="px" onChange={width => dispatch({ type: "project.settings", patch: { width: Math.round(width) } })} /><NumberField label="Height" value={project.settings.height} min={64} max={7680} step={2} suffix="px" onChange={height => dispatch({ type: "project.settings", patch: { height: Math.round(height) } })} /><label className="field"><span>Frame rate</span><select value={`${project.settings.frameRate.numerator}/${project.settings.frameRate.denominator}`} onChange={event => { const [numerator, denominator] = event.target.value.split("/").map(Number); dispatch({ type: "project.settings", patch: { frameRate: { numerator, denominator } } }); }}><option value="24000/1001">23.976 fps</option><option value="24/1">24 fps</option><option value="25/1">25 fps</option><option value="30/1">30 fps</option><option value="30000/1001">29.97 fps</option><option value="60/1">60 fps</option></select></label><ColorField label="Background" value={project.settings.background} onChange={background => dispatch({ type: "project.settings", patch: { background } })} /></Section>
      <Section title="Rendering"><div className="capability"><i className="status-dot" /><span>Canvas2D compositor<small>Shared render plan · frame-based editing</small></span></div><div className="capability"><i className="status-dot" /><span>Native FFmpeg export<small>Local process · no cloud upload</small></span></div><p className="help">Select a clip to adjust transform, color, audio, text and animation.</p></Section>
    </>}</div>
  </aside>;
}

function Section({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) { return <section className="inspector-section"><h3>{title}{badge && <span>{badge}</span>}</h3>{children}</section>; }
export function NumberField({ label, value, onChange, suffix, min, max, step = 0.1, keyframe }: { label: string; value: number; onChange(value: number): void; suffix?: string; min?: number; max?: number; step?: number; keyframe?: () => void }) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))));
  useEffect(() => setDraft(String(Number(value.toFixed(3)))), [value]);
  const commit = () => { const number = Number(draft); if (Number.isFinite(number) && draft.trim()) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, number))); else setDraft(String(value)); };
  return <label className="field"><span>{label}</span><div className="number-input"><input aria-label={label} type="number" min={min} max={max} step={step} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />{suffix && <small>{suffix}</small>}</div>{keyframe && <button type="button" className="keyframe-button" title={`Keyframe ${label} at playhead`} aria-label={`Add ${label} keyframe`} onClick={event => { event.preventDefault(); keyframe(); }}>◇</button>}</label>;
}
function ColorField({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) { return <label className="field color-field"><span>{label}</span><div><input type="color" aria-label={label} value={value.startsWith("#") ? value : "#000000"} onChange={event => onChange(event.target.value)} /><code>{value}</code></div></label>; }
