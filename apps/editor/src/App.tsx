import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createClip, createTextClip, projectDuration, secondsToTicks, ticksToSeconds, snapToFrame, validateAsset } from "@core";
import type { Caption, Clip, Job, Project, Track } from "@core";
import { EditorSession, uid } from "./session";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { Inspector, NumberField } from "./Inspector";
import { mapTranscription } from "./captions";
import { availableTrack } from "./clip-edits";

type LibraryTab = "media" | "captions" | "projects" | "tools";
export function App() {
  const host = window.editorHost;
  const session = useMemo(() => host ? new EditorSession(host) : null, [host]);
  return session ? <EditorApp session={session} /> : <div className="host-missing"><Logo /><h1>OpenCut Next</h1><p>Launch the desktop application to access local projects, media import and native export.</p><span className="tiny-tag">DESKTOP HOST REQUIRED</span></div>;
}

function EditorApp({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { project, environment } = state;
  const [tab, setTab] = useState<LibraryTab>("media");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [assetSelection, setAssetSelection] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(72);
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [newProject, setNewProject] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [name, setName] = useState("");
  const captionJobs = useRef(new Map<string, { projectId: string; clipId?: string }>());
  const proxyJobs = useRef(new Map<string, { projectId: string; assetId: string }>());
  const processJob = useRef<(job: Job) => void>(() => {});
  const run = useCallback((action: () => Promise<unknown>) => { void action().catch(error => session.fail(error)); }, [session]);
  const dispatch = useCallback((command: Parameters<EditorSession["dispatch"]>[0]) => session.dispatch(command), [session]);
  const duration = project ? projectDuration(project) : 0;
  const clip = project?.tracks.flatMap(track => track.clips).find(item => item.id === selected);
  const selectedAsset = clip?.assetId ? project?.assets[clip.assetId] : assetSelection ? project?.assets[assetSelection] : undefined;

  useEffect(() => {
    void session.boot();
    const received = (job: Job) => {
      session.receiveJob(job);
      const proxy = proxyJobs.current.get(job.id);
      if (proxy && ["completed", "failed", "cancelled"].includes(job.status)) {
        proxyJobs.current.delete(job.id);
        if (job.status === "completed" && session.getSnapshot().project?.id === proxy.projectId) {
          try {
            if (!job.result || typeof job.result !== "object" || !("asset" in job.result)) throw new Error("Proxy job did not return a registered asset.");
            const asset = validateAsset(job.result.asset);
            if (asset.id !== proxy.assetId || !asset.proxyUrl) throw new Error("Proxy job returned an unexpected asset.");
            if (session.dispatch({ type: "asset.update", assetId: asset.id, patch: { proxyUrl: asset.proxyUrl } })) session.inform("Proxy is ready and active in the preview. Export keeps the original source.");
            else session.inform("Proxy is ready. Reopen its project after the current operation to attach it.");
          } catch (error) { session.fail(error); }
        }
      }
      const request = captionJobs.current.get(job.id);
      if (request && ["completed", "failed", "cancelled"].includes(job.status)) {
        captionJobs.current.delete(job.id);
        const currentProject = session.getSnapshot().project;
        if (job.status === "completed" && currentProject?.id === request.projectId) {
          const currentClip = request.clipId ? currentProject.tracks.flatMap(track => track.clips).find(item => item.id === request.clipId) : undefined;
          if (request.clipId && !currentClip) { session.fail("The transcribed clip was removed. Caption results were not applied."); return; }
          const result = Array.isArray(job.result) ? job.result : job.result && typeof job.result === "object" && "captions" in job.result ? job.result.captions : undefined;
          if (Array.isArray(result)) {
            const captions = mapTranscription(result, currentClip);
            const existing = session.getSnapshot().project?.captions ?? [];
            session.dispatch({ type: "captions.replace", captions: [...existing, ...captions].sort((a, b) => a.start - b.start) });
            session.inform(`Transcription added ${captions.length} caption${captions.length === 1 ? "" : "s"}.`);
            setTab("captions");
          } else session.fail("The transcription job returned no valid captions.");
        }
      }
    };
    processJob.current = received;
    const jobs = session.host.onJobs(received);
    const close = session.host.onCloseRequested(() => {
      void session.prepareClose().then(() => session.host.respondToClose({ saved: true })).catch(error => session.host.respondToClose({ saved: false, error: error instanceof Error ? error.message : String(error) }));
    });
    const unload = (event: BeforeUnloadEvent) => { if (session.getSnapshot().dirty || session.getSnapshot().saving) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", unload);
    return () => { jobs(); close(); window.removeEventListener("beforeunload", unload); };
  }, [session]);
  useEffect(() => { setSelected(null); setAssetSelection(null); setTime(0); setPlaying(false); }, [project?.id]);
  useEffect(() => { if (project) setName(project.name); }, [project?.name]);
  useEffect(() => { if (selected && !clip) setSelected(null); }, [selected, clip]);
  useEffect(() => {
    if (!playing || !project) return;
    const startTime = performance.now();
    const startTick = time;
    let frame = 0;
    const advance = (now: number) => {
      const next = startTick + secondsToTicks((now - startTime) / 1000);
      if (next >= Math.max(duration, secondsToTicks(0.04))) { setTime(duration); setPlaying(false); return; }
      setTime(next); frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [playing, project?.id, duration]); // Time changes come from this clock; seeking explicitly pauses it.
  const seek = (tick: number) => { setPlaying(false); setTime(Math.max(0, Math.min(Math.max(duration, secondsToTicks(15)), tick))); };
  const togglePlay = () => { if (!project) return; if (!playing && time >= duration) setTime(0); setPlaying(value => !value); };
  const addTrack = (kind: Track["kind"]) => {
    if (!project) return undefined;
    const id = uid();
    dispatch({ type: "track.add", track: { id, name: `${kind === "audio" ? "Audio" : kind === "text" ? "Titles" : "Video"} ${project.tracks.filter(track => track.kind === kind).length + 1}`, kind, muted: false, locked: false, clips: [] } });
    return id;
  };
  const addAsset = (assetId: string, trackId?: string, start = time) => {
    const current = session.getSnapshot().project;
    const asset = current?.assets[assetId];
    if (!current || !asset) return;
    const kind = asset.kind === "audio" ? "audio" : "video";
    const item = createClip({ asset, start: snapToFrame(start, current.settings.frameRate) });
    const requested = current.tracks.find(track => track.id === trackId);
    if (requested && (requested.kind !== kind || requested.locked)) { session.fail(`Choose an unlocked ${kind} track for this asset.`); return; }
    const track = availableTrack(current, kind, item.start, item.duration, trackId);
    const id = track?.id || uid();
    const command: Parameters<EditorSession["dispatch"]>[0] = { type: "clip.add", trackId: id, clip: item };
    const ok = track ? dispatch(command) : dispatch({ type: "batch", label: "Add media and track", commands: [{ type: "track.add", track: { id, name: `${kind === "audio" ? "Audio" : "Video"} ${current.tracks.filter(track => track.kind === kind).length + 1}`, kind, muted: false, locked: false, clips: [] } }, command] });
    if (ok) setSelected(item.id);
    if (ok && requested && !track) session.inform(`Added “${asset.name}” on a new layer to keep overlapping clips accessible.`);
  };
  const addText = () => {
    if (!project) return;
    const item = createTextClip({ text: "Your story starts here", start: snapToFrame(time, project.settings.frameRate) });
    const track = availableTrack(project, "text", item.start, item.duration);
    const trackId = track?.id || uid();
    const command = { type: "clip.add" as const, trackId, clip: item };
    if (dispatch(track ? command : { type: "batch", label: "Add title", commands: [{ type: "track.add", track: { id: trackId, name: `Titles ${project.tracks.filter(track => track.kind === "text").length + 1}`, kind: "text", muted: false, locked: false, clips: [] } }, command] })) setSelected(item.id);
  };
  const split = () => { if (clip && project) dispatch({ type: "clip.split", clipId: clip.id, time: snapToFrame(time, project.settings.frameRate), rightId: uid() }); };
  const duplicate = () => {
    if (!clip || !project) return;
    const source = project.tracks.find(track => track.clips.some(item => item.id === clip.id));
    if (!source) return;
    const start = clip.start + clip.duration;
    const destination = availableTrack(project, source.kind, start, clip.duration, source.id);
    const newId = uid();
    if (destination) { if (dispatch({ type: "clip.duplicate", clipId: clip.id, newId, start })) setSelected(newId); }
    else {
      const trackId = uid();
      if (dispatch({ type: "batch", label: "Duplicate on new layer", commands: [{ type: "track.add", track: { id: trackId, name: `${source.name} copy`, kind: source.kind, muted: false, locked: false, clips: [] } }, { type: "clip.duplicate", clipId: clip.id, newId, start }, { type: "clip.move", clipId: newId, trackId, start }] })) setSelected(newId);
    }
  };
  const remove = () => { if (clip && dispatch({ type: "clip.remove", clipIds: [clip.id] })) setSelected(null); };
  const rippleRemove = () => { if (clip && dispatch({ type: "clip.remove", clipIds: [clip.id], ripple: true })) setSelected(null); };
  const transcribe = () => run(async () => {
    const current = session.getSnapshot().project;
    if (!selectedAsset || !current || !environment?.localTranscription) return;
    const job = await session.host.transcribeAsset(selectedAsset.id);
    captionJobs.current.set(job.id, { projectId: current.id, clipId: clip?.id });
    const cached = session.getSnapshot().jobs.find(item => item.id === job.id);
    processJob.current(cached && ["completed", "failed", "cancelled"].includes(cached.status) ? cached : job);
    setJobsOpen(true);
  });
  const createProxy = () => run(async () => {
    const current = session.getSnapshot().project;
    if (!current || !selectedAsset) return;
    const job = await session.host.createProxy(selectedAsset.id);
    proxyJobs.current.set(job.id, { projectId: current.id, assetId: selectedAsset.id });
    const cached = session.getSnapshot().jobs.find(item => item.id === job.id);
    processJob.current(cached && ["completed", "failed", "cancelled"].includes(cached.status) ? cached : job);
    setJobsOpen(true);
  });
  const actions = [
    { name: "Import media", key: "Ctrl I", action: () => run(() => session.importMedia()) },
    { name: "Save project", key: "Ctrl S", action: () => run(() => session.flush()) },
    { name: "New project", key: "Ctrl Shift N", action: () => setNewProject(true) },
    { name: "Add text title", key: "T", action: addText },
    { name: "Split selected clip at playhead", key: "S", action: split },
    { name: "Duplicate selected clip", key: "Ctrl D", action: duplicate },
    { name: "Delete selected clip", key: "Delete", action: remove },
    { name: "Undo", key: "Ctrl Z", action: () => session.undo() },
    { name: "Redo", key: "Ctrl Shift Z", action: () => session.redo() },
    { name: "Import SRT captions", key: "", action: () => run(() => session.importCaptions()) },
    { name: "Add video track", key: "", action: () => addTrack("video") },
    { name: "Add audio track", key: "", action: () => addTrack("audio") },
    { name: "Add marker at playhead", key: "M", action: () => dispatch({ type: "marker.add", marker: { id: uid(), time: Math.round(time), label: `Marker ${(project?.markers.length ?? 0) + 1}`, color: "#eab676" } }) },
    { name: "Export film", key: "Ctrl E", action: () => setExportOpen(true) },
    { name: "Ripple delete selected clip", key: "Shift Delete", action: rippleRemove },
  ];
  const actionRef = useRef({ actions, togglePlay, clip, project, time, duration, seek });
  actionRef.current = { actions, togglePlay, clip, project, time, duration, seek };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.matches("input,textarea,select") || target.isContentEditable;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette(value => !value); return; }
      if (typing && !(mod && event.key.toLowerCase() === "s")) return;
      const current = actionRef.current;
      let action: (() => unknown) | undefined;
      if (mod) {
        const key = event.key.toLowerCase();
        const index = key === "i" ? 0 : key === "s" ? 1 : key === "n" && event.shiftKey ? 2 : key === "d" ? 5 : key === "z" ? event.shiftKey ? 8 : 7 : key === "y" ? 8 : key === "e" ? 13 : -1;
        action = current.actions[index]?.action;
      } else if (event.code === "Space") action = current.togglePlay;
      else if (event.key === "Delete" || event.key === "Backspace") action = current.actions[event.shiftKey ? 14 : 6].action;
      else if (event.key.toLowerCase() === "s") action = current.actions[4].action;
      else if (event.key.toLowerCase() === "t") action = current.actions[3].action;
      else if (event.key.toLowerCase() === "m") action = current.actions[12].action;
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") action = () => { if (current.project) current.seek(current.time + secondsToTicks(current.project.settings.frameRate.denominator / current.project.settings.frameRate.numerator) * (event.key === "ArrowRight" ? 1 : -1)); };
      else if (event.key === "Home") action = () => current.seek(0);
      else if (event.key === "End") action = () => current.seek(current.duration);
      if (action) { event.preventDefault(); action(); }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [session]);

  const assets = project ? Object.values(project.assets).filter(asset => asset.name.toLowerCase().includes(query.toLowerCase())) : [];
  const running = state.jobs.filter(job => ["running", "queued"].includes(job.status)).length;
  return <div className="editor-app">
    <header className="app-header"><div className="brand"><Logo /><strong>OpenCut<span>NEXT</span></strong></div><span className="header-divider" />
      {project ? <div className="project-name"><input aria-label="Project name" value={name} onChange={event => setName(event.target.value)} onBlur={() => { if (name.trim() && name !== project.name) dispatch({ type: "project.rename", name: name.trim() }); else setName(project.name); }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /><span className="tiny-tag">LOCAL PROJECT</span></div> : <span className="header-title">Your next story, your machine.</span>}
      <div className="header-actions"><button className="command-trigger" onClick={() => { setPaletteQuery(""); setPalette(true); }}><Icon name="search" />Commands <kbd>Ctrl K</kbd></button>
        <button className={`save-button ${state.error && state.dirty ? "failed" : ""}`} disabled={!project || state.busy} onClick={() => run(() => session.flush())}><span className={`status-dot ${state.saving ? "pulse" : state.dirty ? "amber" : ""}`} />{state.saving ? "Saving…" : state.error && state.dirty ? "Save failed · retry" : state.dirty ? "Save changes" : "Saved locally"}</button>
        <button className="icon-button" title="Export queue" onClick={() => setJobsOpen(value => !value)}><Icon name="jobs" />{running > 0 && <b className="notification-count">{running}</b>}</button>
        <button className="primary-button export-button" disabled={!project} onClick={() => setExportOpen(true)}><Icon name="export" />Export</button>
      </div>
    </header>
    {(state.error || state.notice) && <div className={`notice-bar ${state.error ? "error" : ""}`} role={state.error ? "alert" : "status"}><span>{state.error || state.notice}</span>{state.error && state.dirty && <button className="secondary-button" disabled={state.busy} onClick={() => run(() => session.saveCopy())}>Save a copy</button>}<button onClick={() => state.error ? session.clearError() : session.inform("")}>×</button></div>}
    <main className="workspace">
      <nav className="tool-rail">{([["media", "media", "Media"], ["captions", "captions", "Captions"], ["projects", "folder", "Projects"], ["tools", "spark", "Tools"]] as const).map(([id, icon, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)} title={label}><Icon name={icon} /><span>{label}</span></button>)}<div className="rail-bottom"><span className="local-indicator" title="Media stays on this computer" /><span>LOCAL</span></div></nav>
      <aside className="library panel">
        <div className="panel-heading"><span>{tab === "media" ? "MEDIA LIBRARY" : tab === "captions" ? "CAPTIONS" : tab === "projects" ? "PROJECTS" : "LOCAL TOOLKIT"}</span><span className="tiny-tag">{tab === "media" ? assets.length : tab === "captions" ? project?.captions.length ?? 0 : tab === "projects" ? state.projects.length : "BETA"}</span></div>
        {tab === "media" && <><div className="library-actions"><button className="primary-button full" disabled={!project || state.busy} onClick={() => run(() => session.importMedia())}><Icon name="plus" />Import media</button><label className="search-field"><Icon name="search" /><input aria-label="Search media" placeholder="Search your media…" value={query} onChange={event => setQuery(event.target.value)} /><kbd>⌕</kbd></label></div><div className="library-scroll"><div className="library-section-label">PROJECT ASSETS <span>{assets.length}</span></div>{assets.length ? <div className="asset-grid">{assets.map(asset => <article key={asset.id} className={`asset-card ${assetSelection === asset.id ? "selected" : ""}`} draggable onDragStart={event => event.dataTransfer.setData("application/x-opencut-asset", asset.id)} onClick={() => { setAssetSelection(asset.id); }} onDoubleClick={() => addAsset(asset.id)}>
          <div className={`asset-poster ${asset.kind}`}>{asset.thumbnail ? <img src={asset.thumbnail} alt="" /> : <Icon name={asset.kind === "audio" ? "audio" : "media"} />}<span className="asset-kind">{asset.kind.toUpperCase()}</span><button title={`Add ${asset.name} to timeline`} aria-label={`Add ${asset.name}`} onClick={event => { event.stopPropagation(); addAsset(asset.id); }}>+</button><small>{asset.kind === "image" ? "STILL" : formatTime(asset.duration)}</small></div><strong title={asset.name}>{asset.name}</strong><small>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "Local audio"}</small>
        </article>)}</div> : <div className="empty-library"><div className="empty-glyph"><Icon name="media" /></div><strong>{query ? "No matching media" : "Make room for a story"}</strong><p>{query ? "Try another name." : "Import video, images or audio. Your originals stay local."}</p><small>MP4 · MOV · WEBM · WAV · PNG · JPG</small></div>}</div>{selectedAsset && <div className="asset-details"><strong>{selectedAsset.name}</strong><span>{selectedAsset.kind} · {formatTime(selectedAsset.duration)} {selectedAsset.proxyUrl && <b className="tiny-tag">PROXY ACTIVE</b>}</span><button className="secondary-button" onClick={() => addAsset(selectedAsset.id)}>Add to timeline</button></div>}</>}
        {tab === "projects" && <><div className="library-actions"><button className="primary-button full" onClick={() => setNewProject(true)}><Icon name="plus" />New project</button><p className="help">Versioned saves on this computer. Switching waits for unsaved edits.</p></div><div className="library-scroll project-list">{state.projects.length ? state.projects.map(item => <button key={item.id} className={project?.id === item.id ? "active" : ""} disabled={state.busy} onClick={() => { setPlaying(false); run(() => session.open(item.id)); }}><span className="project-tile"><Icon name="film" /></span><span><strong>{item.name}</strong><small>{formatTime(item.duration)} · {new Date(item.updatedAt).toLocaleDateString()}</small></span>{project?.id === item.id && <i className="status-dot" />}</button>) : <div className="empty-library"><strong>No saved projects yet</strong><p>Create a local project to begin.</p></div>}</div></>}
        {tab === "captions" && <><div className="library-actions"><button className="secondary-button full" disabled={!project} onClick={() => run(() => session.importCaptions())}><Icon name="captions" />Import SRT</button><button className="secondary-button full" disabled={!selectedAsset?.hasAudio || !environment?.localTranscription} onClick={transcribe} title={!environment?.localTranscription ? "Local transcription model is unavailable. No model is downloaded by the editor." : "Transcribe selected media locally"}><Icon name="spark" />Transcribe selection</button><p className="help">{environment?.localTranscription ? "Offline speech recognition is ready. Captions follow source trim and clip speed." : "SRT import is ready. Offline transcription needs a local speech model."}</p></div><div className="library-scroll captions-list">{project?.captions.map(caption => <CaptionEditor key={caption.id} caption={caption} seek={seek} update={patch => dispatch({ type: "caption.update", captionId: caption.id, patch })} />)}{!project?.captions.length && <div className="empty-library"><div className="empty-glyph"><Icon name="captions" /></div><strong>Every word, in time</strong><p>Import an SRT file or transcribe selected audio with an installed local model.</p></div>}</div></>}
        {tab === "tools" && <div className="library-scroll toolkit"><div className="toolkit-intro"><Icon name="spark" /><strong>Built to grow.<br />Grounded in local tools.</strong><p>Capabilities reflect what is installed and working on this machine.</p></div><Capability title="Canvas compositor" detail="Transforms, text, color and keyframes" ready /><Capability title="Native media engine" detail={environment?.ffmpeg ? "FFmpeg found · export and analysis" : "FFmpeg is unavailable"} ready={Boolean(environment?.ffmpeg)} /><Capability title="Offline transcription" detail={environment?.localTranscription ? "Local model installed · no upload" : "No local model configured"} ready={Boolean(environment?.localTranscription)} /><Capability title="Provider extensions" detail="Stable host boundary; no third-party provider loaded" /><Capability title="Generative video / music" detail="No provider or model installed" />{selectedAsset && <section className="analysis-tools"><h3>Selected media</h3><button className="secondary-button full" disabled={!environment?.ffmpeg} onClick={createProxy}>Create native proxy</button><button className="secondary-button full" disabled={!selectedAsset.hasAudio || !environment?.ffmpeg} onClick={() => run(async () => { session.receiveJob(await session.host.analyzeSilence(selectedAsset.id)); setJobsOpen(true); })}>Analyze silence</button><p className="help">Analysis runs in a separate native job. Silence analysis does not change your edit.</p></section>}</div>}
      </aside>
      <section className="viewer-column"><div className="viewer-heading"><div><span className="status-dot" /><span>PROGRAM MONITOR</span></div><span>{project ? `${project.settings.width} × ${project.settings.height}` : "NO PROJECT"}<b>Canvas2D</b></span></div>
        {project ? <Preview project={project} time={time} playing={playing} /> : <div className="welcome"><span className="welcome-eyebrow">A NEW CUT STARTS HERE</span><div className="welcome-art"><span /><span /><span /><Icon name="film" /></div><h1>Ideas deserve<br /><em>a better timeline.</em></h1><p>A focused workspace for your footage, sound and words.<br />Local projects. Native exports. Room to build.</p><button className="primary-button" onClick={() => setNewProject(true)}><Icon name="plus" />Create a project</button>{state.projects.length > 0 && <button className="text-button" onClick={() => setTab("projects")}>Or reopen a recent project →</button>}</div>}
        <div className="transport"><span className="timecode">{formatTime(time, project)}<small>/ {formatTime(duration, project)}</small></span><div className="transport-buttons"><button className="icon-button" title="Start (Home)" disabled={!project} onClick={() => seek(0)}><Icon name="start" /></button><button className="icon-button" title="Previous frame (←)" disabled={!project} onClick={() => project && seek(time - secondsToTicks(project.settings.frameRate.denominator / project.settings.frameRate.numerator))}><Icon name="previous" /></button><button className={`play-button ${playing ? "playing" : ""}`} aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)" disabled={!project} onClick={togglePlay}><Icon name={playing ? "pause" : "play"} /></button><button className="icon-button" title="Next frame (→)" disabled={!project} onClick={() => project && seek(time + secondsToTicks(project.settings.frameRate.denominator / project.settings.frameRate.numerator))}><Icon name="next" /></button><button className="icon-button" title="End" disabled={!project} onClick={() => seek(duration)}><Icon name="end" /></button></div><span className="monitor-scale">FIT <Icon name="expand" /></span></div>
      </section>
      {project ? <Inspector project={project} clip={clip} time={time} dispatch={dispatch} seek={seek} pause={() => setPlaying(false)} /> : <aside className="inspector panel onboarding"><div className="panel-heading">YOUR WORKSPACE</div><div className="onboarding-step"><b>01</b><strong>Bring your footage</strong><p>Import originals without sending them anywhere.</p></div><div className="onboarding-step"><b>02</b><strong>Find the rhythm</strong><p>Build across tracks. Trim, split and animate.</p></div><div className="onboarding-step"><b>03</b><strong>Make the final cut</strong><p>Save the source project and export with FFmpeg.</p></div><div className="onboarding-foot"><i className="status-dot" /> Original editor engine<br /><small>No account required.</small></div></aside>}
    </main>
    <section className="timeline-panel"><div className="timeline-toolbar"><div className="timeline-title"><Icon name="timeline" /><strong>Timeline</strong><span>{project ? project.tracks.length : 0} tracks</span></div><div className="edit-tools"><button className="icon-button" aria-label="Undo" title="Undo (Ctrl Z)" disabled={!state.canUndo} onClick={() => session.undo()}><Icon name="undo" /></button><button className="icon-button" aria-label="Redo" title="Redo (Ctrl Shift Z)" disabled={!state.canRedo} onClick={() => session.redo()}><Icon name="redo" /></button><span className="tool-separator" /><button className="icon-button" aria-label="Split clip" title="Split at playhead (S)" disabled={!clip} onClick={split}><Icon name="split" /></button><button className="icon-button" aria-label="Duplicate clip" title="Duplicate (Ctrl D)" disabled={!clip} onClick={duplicate}><Icon name="duplicate" /></button><button className="icon-button" aria-label="Delete clip" title="Delete clip" disabled={!clip} onClick={remove}><Icon name="trash" /></button><button className="compact-button" aria-label="Ripple delete" title="Ripple delete (Shift Delete)" disabled={!clip} onClick={rippleRemove}>Ripple delete</button><span className="tool-separator" /><button className="compact-button" title="Add text title (T)" disabled={!project} onClick={addText}>T <span>Text</span></button><button className="compact-button" disabled={!project} onClick={() => addTrack("video")}>+ Video</button><button className="compact-button" disabled={!project} onClick={() => addTrack("audio")}>+ Audio</button></div><div className="timeline-zoom"><button aria-label="Zoom out" onClick={() => setZoom(value => Math.max(15, value - 15))}>−</button><input aria-label="Timeline zoom" type="range" min="15" max="220" value={zoom} onChange={event => setZoom(Number(event.target.value))} /><button aria-label="Zoom in" onClick={() => setZoom(value => Math.min(220, value + 15))}>+</button><span>{Math.round(zoom / 72 * 100)}%</span></div></div>{project ? <Timeline project={project} selected={selected} select={setSelected} time={time} seek={seek} zoom={zoom} dispatch={dispatch} addAsset={addAsset} /> : <div className="timeline-empty"><div /><p>Your story will take shape here.</p></div>}</section>
    <footer className="app-footer"><span><i className="status-dot" />{environment ? `LOCAL ENGINE ${environment.version}` : "CONNECTING TO LOCAL ENGINE"}</span><span>{project ? `${project.assets ? Object.keys(project.assets).length : 0} assets · revision ${project.revision}` : "PRIVATE BY DEFAULT"}</span><span>{environment?.ffmpeg ? "FFmpeg ready" : "FFmpeg unavailable"}<b>240k tick precision</b><button onClick={() => { setPaletteQuery(""); setPalette(true); }}>Keyboard shortcuts ⌘</button></span></footer>
    {state.busy && <div className="busy-overlay" role="status"><span className="spinner" />Saving and switching project…</div>}
    {newProject && <CreateProjectModal close={() => setNewProject(false)} create={(title, width, height) => run(async () => { await session.create(title, width, height); setNewProject(false); setTab("media"); })} />}
    {palette && <div className="modal-shade" onMouseDown={() => setPalette(false)}><div className="command-palette" role="dialog" aria-label="Command palette" onMouseDown={event => event.stopPropagation()}><div className="palette-search"><Icon name="search" /><input autoFocus aria-label="Find a command" placeholder="What would you like to do?" value={paletteQuery} onChange={event => setPaletteQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setPalette(false); if (event.key === "Enter") { const item = actions.find(item => item.name.toLowerCase().includes(paletteQuery.toLowerCase())); if (item) { setPalette(false); item.action(); } } }} /><kbd>ESC</kbd></div><div className="palette-results">{actions.filter(item => item.name.toLowerCase().includes(paletteQuery.toLowerCase())).map(item => <button key={item.name} onClick={() => { setPalette(false); item.action(); }}><span>{item.name}</span>{item.key && <kbd>{item.key}</kbd>}</button>)}</div><p>Space to play · Arrow keys to step · Drag clip edges to trim</p></div></div>}
    {exportOpen && <div className="modal-shade" onMouseDown={() => setExportOpen(false)}><div className="modal export-modal" role="dialog" aria-label="Export project" onMouseDown={event => event.stopPropagation()}><button className="modal-close" onClick={() => setExportOpen(false)}>×</button><Icon name="export" /><h2>Make it a film.</h2><p>Native rendering from the same project render plan.<br />Choose a format, then an output location.</p><div className="export-spec">{project?.settings.width} × {project?.settings.height}<span>{formatTime(duration)} · local FFmpeg</span></div><button className="primary-button full" disabled={!environment?.ffmpeg} onClick={() => run(async () => { await session.export("mp4-h264"); setExportOpen(false); setJobsOpen(true); })}>Export MP4 · H.264</button><button className="secondary-button full" disabled={!environment?.ffmpeg} onClick={() => run(async () => { await session.export("webm-vp9"); setExportOpen(false); setJobsOpen(true); })}>Export WebM · VP9</button><p className="help">Unsupported render properties produce an explicit job failure. Originals are never modified.</p></div></div>}
    {jobsOpen && <div className="jobs-drawer"><div className="panel-heading"><span>BACKGROUND JOBS {running > 0 && `· ${running} running`}</span><button onClick={() => setJobsOpen(false)}>×</button></div>{state.jobs.length ? state.jobs.map(job => <article className="job-card" key={job.id}><div><Icon name={job.type === "export" ? "export" : "spark"} /><strong>{job.type === "export" ? "Native export" : job.type === "transcription" ? "Offline transcription" : job.type === "proxy" ? "Create proxy" : "Silence analysis"}</strong><span className={`job-status ${job.status}`}>{job.status}</span></div><progress max="1" value={job.progress > 1 ? job.progress / 100 : job.progress} /><p>{job.message || job.output || "Waiting for the local worker…"}</p>{["queued", "running"].includes(job.status) && <button className="text-button" onClick={() => run(() => session.host.cancelJob(job.id))}>Cancel job</button>}{job.status === "completed" && job.type === "silence" && <details><summary>Analysis result</summary><pre>{JSON.stringify(job.result, null, 2)}</pre></details>}</article>) : <div className="empty-library"><strong>All quiet here</strong><p>Exports and media analysis appear here.</p></div>}</div>}
  </div>;
}

function CaptionEditor({ caption, update, seek }: { caption: Caption; update(patch: Partial<Pick<Caption, "text" | "start" | "end">>): boolean; seek(time: number): void }) { return <article className="caption-card"><button className="caption-seek" onClick={() => seek(caption.start)}><Icon name="play" />{formatTime(caption.start)} → {formatTime(caption.end)}</button><textarea aria-label="Caption text" value={caption.text} rows={2} onChange={event => update({ text: event.target.value })} /><div className="caption-timing"><NumberField label="In" suffix="s" value={ticksToSeconds(caption.start)} min={0} onChange={value => update({ start: secondsToTicks(value) })} /><NumberField label="Out" suffix="s" value={ticksToSeconds(caption.end)} min={ticksToSeconds(caption.start)} onChange={value => update({ end: secondsToTicks(value) })} /></div></article>; }
function Capability({ title, detail, ready = false }: { title: string; detail: string; ready?: boolean }) { return <div className={`provider-capability ${ready ? "ready" : ""}`}><span>{ready ? "✓" : "◇"}</span><div><strong>{title}</strong><small>{detail}</small></div><b>{ready ? "READY" : "NOT LOADED"}</b></div>; }
function CreateProjectModal({ close, create }: { close(): void; create(name: string, width: number, height: number): void }) { const [name, setName] = useState("Untitled film"); const [size, setSize] = useState("1920,1080"); return <div className="modal-shade" onMouseDown={close}><form className="modal create-modal" onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); const [width, height] = size.split(",").map(Number); create(name, width, height); }}><button type="button" className="modal-close" onClick={close}>×</button><span className="welcome-eyebrow">NEW LOCAL PROJECT</span><h2>Give your story a name.</h2><p>You can change everything as you go.</p><label>Project name<input autoFocus aria-label="New project name" value={name} onChange={event => setName(event.target.value)} required /></label><label>Canvas<select aria-label="Canvas preset" value={size} onChange={event => setSize(event.target.value)}><option value="1920,1080">Landscape · 1920 × 1080</option><option value="1080,1920">Portrait · 1080 × 1920</option><option value="1080,1080">Square · 1080 × 1080</option><option value="3840,2160">4K · 3840 × 2160</option></select></label><button className="primary-button full" type="submit">Create project <span>→</span></button><small>Stored on this computer. No account or upload.</small></form></div>; }
function Logo() { return <svg className="brand-logo" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 7h15l7 9-7 9H5l7-9z" fill="currentColor" /><path d="m11 7 7 9-7 9" stroke="#151719" strokeWidth="3" /></svg>; }
function Icon({ name }: { name: string }) { const paths: Record<string, string> = { search: "m15 15 5 5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0", plus: "M12 5v14M5 12h14", media: "M3 5h18v14H3zM3 15l5-5 5 5 3-3 5 5M15 8h.01", film: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 16h4M16 8h4M16 16h4", folder: "M3 7V5h7l2 2h9v13H3z", captions: "M3 5h18v14H3zM6 10h5M6 14h5M14 10h4M14 14h4", spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z", export: "M12 15V3m-4 4 4-4 4 4M4 13v7h16v-7", jobs: "M6 6h15M6 12h15M6 18h15M2 6h.01M2 12h.01M2 18h.01", audio: "M3 10v4M7 6v12M12 3v18M17 6v12M21 10v4", play: "m8 5 11 7-11 7z", pause: "M8 5v14M16 5v14", previous: "m15 5-9 7 9 7z", next: "m9 5 9 7-9 7z", start: "M5 5v14m14-14-11 7 11 7z", end: "M19 5v14M5 5l11 7-11 7z", expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5", timeline: "M3 5h18M7 3v18M3 10h10v4H3M10 17h11v4H10", undo: "M7 7H3V3m0 4c6-6 17-3 17 5a8 8 0 0 1-8 8", redo: "M17 7h4V3m0 4C15 1 4 4 4 12a8 8 0 0 0 8 8", split: "M9 9 20 3M9 15l11 6M4 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8M4 12a4 4 0 1 1 0 8 4 4 0 0 1 0-8", duplicate: "M8 8h13v13H8zM16 8V3H3v13h5", trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" }; return <svg className={`icon icon-${name}`} viewBox="0 0 24 24" fill={name === "play" || name === "previous" || name === "next" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.media} /></svg>; }
function formatTime(ticks: number, project?: Project | null) { const seconds = Math.max(0, ticksToSeconds(ticks)); const minutes = Math.floor(seconds / 60); const whole = Math.floor(seconds % 60); if (!project) return `${minutes}:${String(whole).padStart(2, "0")}`; const fps = project.settings.frameRate.numerator / project.settings.frameRate.denominator; return `${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}:${String(Math.floor((seconds % 1) * fps + 0.0001)).padStart(2, "0")}`; }
