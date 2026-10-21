import { describe, expect, test } from "bun:test";
import { TIMEBASE, EditorError, EditorStore, ExtensionRegistry, applyCommand, buildRenderPlan, createClip, createEditorApi, createProject, createTextClip, evaluateClip, frameTicks, parseSrt, projectDuration, secondsToTicks, snapToFrame, ticksToSeconds, toSrt, validateProject, type Asset, type Clip, type Command, type Project } from "../src";
import { createMakeSocialSquareExtension } from "../examples/make-social-square";

const sec = secondsToTicks;
function asset(id = "source", kind: Asset["kind"] = "video"): Asset {
  return { id, kind, name: id, duration: kind === "image" ? 0 : sec(20), hasAudio: kind !== "image", url: `media://${id}`, ...(kind !== "audio" ? { width: 1920, height: 1080 } : {}) };
}
function trackId(project: Project, kind: "video" | "audio" | "text") { return project.tracks.find((track) => track.kind === kind)!.id; }
function find(project: Project, id = "clip"): Clip { return project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)!; }
function fixture() {
  const project = createProject({ id: "p", name: "Test" }), source = asset();
  return applyCommand(project, { type: "batch", commands: [{ type: "asset.add", assets: [source] }, { type: "clip.add", trackId: trackId(project, "video"), clip: createClip({ asset: source, id: "clip", start: sec(2), duration: sec(6) }) }] });
}

describe("integer time and model boundaries", () => {
  test("rational frame durations are exact across long timelines", () => {
    for (const [numerator, denominator, expected] of [[24, 1, 10000], [25, 1, 9600], [30, 1, 8000], [24000, 1001, 10010], [30000, 1001, 8008], [60000, 1001, 4004]]) {
      const rate = { numerator, denominator };
      expect(frameTicks(rate)).toBe(expected);
      expect(snapToFrame(expected * 1_000_000 + expected / 2, rate)).toBe(expected * 1_000_001);
      expect(snapToFrame(-expected / 2, rate)).toBe(-expected);
    }
    expect(sec(0.5)).toBe(120000); expect(ticksToSeconds(sec(1.25))).toBe(1.25);
    expect(sec(-0.5 / TIMEBASE)).toBe(-1);
  });
  test("rejects invalid, fractional, unsupported and overflowing times", () => {
    for (const value of [NaN, Infinity, Number.MAX_VALUE]) expect(() => sec(value)).toThrow(EditorError);
    expect(() => snapToFrame(0.5, { numerator: 30, denominator: 1 })).toThrow();
    expect(() => frameTicks({ numerator: 29.97, denominator: 1 })).toThrow();
    expect(() => frameTicks({ numerator: 7, denominator: 1 })).toThrow();
    expect(() => frameTicks({ numerator: 0, denominator: 1 })).toThrow();
  });
  test("validates JSON into an independent model and rejects corrupt loads", () => {
    const original = fixture(), decoded = validateProject(JSON.parse(JSON.stringify(original)));
    expect(decoded).toEqual(original); decoded.tracks[0].name = "changed"; expect(original.tracks[0].name).not.toBe("changed");
    const variants = [
      { ...original, schemaVersion: 2 }, { ...original, revision: -1 }, { ...original, settings: { ...original.settings, sampleRate: 44100 } },
      { ...original, settings: { ...original.settings, width: 0 } }, { ...original, assets: {} }, { ...original, unknown: true },
      { ...original, createdAt: "yesterday" }, { ...original, tracks: [...original.tracks, original.tracks[0]] },
    ];
    for (const value of variants) expect(() => validateProject(value)).toThrow(EditorError);
    const duplicate = structuredClone(original); duplicate.tracks[0].clips.push(structuredClone(find(original))); expect(() => validateProject(duplicate)).toThrow();
  });
  test("image and text defaults are usable independent of AV source duration", () => {
    const image = createClip({ asset: asset("still", "image") }); expect(image.duration).toBe(sec(5));
    const text = createTextClip({ text: "Hello" }); expect(text.text?.content).toBe("Hello"); expect(text.duration).toBe(sec(5));
    expect(() => createClip({ asset: asset(), duration: sec(21) })).toThrow();
  });
  test("VFR source averages import independently of the integral project frame grid", () => {
    const project = createProject(), source = { ...asset(), frameRate: { numerator: 30017, denominator: 1000 } };
    const imported = applyCommand(project, { type: "batch", commands: [{ type: "asset.add", assets: [source] }, { type: "clip.add", trackId: trackId(project, "video"), clip: createClip({ asset: source }) }] });
    expect(imported.assets.source.frameRate).toEqual(source.frameRate);
    expect(validateProject(JSON.parse(JSON.stringify(imported))).assets.source.frameRate).toEqual(source.frameRate);
    expect(() => applyCommand(imported, { type: "project.settings", patch: { frameRate: source.frameRate } })).toThrow(/integral frame ticks/);
    for (const frameRate of [{ numerator: 0, denominator: 1 }, { numerator: Infinity, denominator: 1 }, { numerator: 30, denominator: 0 }, { numerator: 1001, denominator: 1 }, { numerator: 29.97, denominator: 1 }]) expect(() => createClip({ asset: { ...source, frameRate } })).toThrow(EditorError);
  });
});

describe("immutable and atomic commands", () => {
  test("authoritative proxy metadata survives reload without changing originals or clips", () => {
    const project = fixture(), clips = structuredClone(project.tracks), originalUrl = project.assets.source.url;
    const next = applyCommand(project, { type: "asset.update", assetId: "source", patch: { proxyUrl: "app-media://media/source/proxy" } });
    expect(next.assets.source.proxyUrl).toBe("app-media://media/source/proxy");
    expect(next.assets.source.url).toBe(originalUrl); expect(next.tracks).toEqual(clips);
    expect(project.assets.source.proxyUrl).toBeUndefined();
    expect(validateProject(JSON.parse(JSON.stringify(next))).assets.source.proxyUrl).toBe(next.assets.source.proxyUrl);
    const store = new EditorStore(project); store.dispatch({ type: "asset.update", assetId: "source", patch: { proxyUrl: next.assets.source.proxyUrl } });
    expect(store.undo().assets.source.proxyUrl).toBeUndefined(); expect(store.redo().assets.source.proxyUrl).toBe(next.assets.source.proxyUrl);
  });
  test("invalid asset updates and stale IDs cannot partially change an asset or its clips", () => {
    const project = fixture(), before = JSON.stringify(project);
    const patches = [{ proxyUrl: 42 }, { proxyUrl: "" }, { duration: sec(1) }, { kind: "audio" }, { id: "hijack" }, { frameRate: { numerator: 0, denominator: 1 } }, { unrecognized: true }];
    for (const patch of patches) {
      expect(() => applyCommand(project, { type: "batch", commands: [{ type: "project.rename", name: "Uncommitted" }, { type: "asset.update", assetId: "source", patch }] } as unknown as Command)).toThrow(EditorError);
      expect(JSON.stringify(project)).toBe(before);
    }
    expect(() => applyCommand(project, { type: "asset.update", assetId: "stale", patch: { name: "Changed" } })).toThrow(/does not exist/);
  });
  test("batch commits once and an unsuccessful child leaves every input unchanged", () => {
    const original = fixture(), before = JSON.stringify(original);
    const bad: Command = { type: "batch", commands: [{ type: "project.rename", name: "would change" }, { type: "clip.move", clipId: "missing", trackId: original.tracks[0].id, start: 0 }] };
    expect(() => applyCommand(original, bad)).toThrow(EditorError); expect(JSON.stringify(original)).toBe(before);
    const next = applyCommand(original, { type: "batch", commands: [{ type: "project.rename", name: "Renamed" }, { type: "project.settings", patch: { width: 1280, height: 720 } }] });
    expect(next.revision).toBe(original.revision + 1); expect(next.name).toBe("Renamed"); expect(original.name).toBe("Test");
  });
  test("split honors speed and source time while retaining exact animation context", () => {
    let project = fixture();
    project = applyCommand(project, { type: "clip.update", clipId: "clip", patch: { sourceIn: sec(1), speed: 2, keyframes: [{ id: "a", time: 0, property: "x", value: 0, easing: "smooth" }, { id: "b", time: sec(6), property: "x", value: 100, easing: "linear" }] } });
    const original = find(project);
    const next = applyCommand(project, { type: "clip.split", clipId: "clip", time: sec(4), rightId: "right" });
    const left = find(next), right = find(next, "right");
    expect(left.duration).toBe(sec(2)); expect(right.start).toBe(sec(4)); expect(right.duration).toBe(sec(4)); expect(right.sourceIn).toBe(sec(5));
    for (let frame = 0; frame < 120; frame++) {
      const time = frame * frameTicks(project.settings.frameRate);
      expect(evaluateClip(right, time).transform.x).toBeCloseTo(evaluateClip(original, sec(2) + time).transform.x, 10);
    }
    expect(original.duration).toBe(sec(6));
  });
  test("split rejects boundaries, stale IDs and collisions", () => {
    const project = fixture();
    for (const command of [
      { type: "clip.split", clipId: "clip", time: sec(2), rightId: "r" },
      { type: "clip.split", clipId: "clip", time: sec(8), rightId: "r" },
      { type: "clip.split", clipId: "missing", time: sec(4), rightId: "r" },
      { type: "clip.split", clipId: "clip", time: sec(4), rightId: "clip" },
    ] as Command[]) expect(() => applyCommand(project, command)).toThrow(EditorError);
  });
  test("fractional-speed split stays source-bounded with less than one source tick of quantization", () => {
    let project = fixture(); const duration = 16016, offset = 8008, speed = 0.7;
    project = applyCommand(project, { type: "clip.update", clipId: "clip", patch: { start: 0, duration, speed } });
    project.assets.source.duration = Math.ceil(duration * speed);
    const next = applyCommand(project, { type: "clip.split", clipId: "clip", time: offset, rightId: "r" });
    const right = find(next, "r");
    expect(right.sourceIn + right.duration * speed).toBeLessThanOrEqual(project.assets.source.duration);
    expect(Math.abs(right.sourceIn - offset * speed)).toBeLessThan(1);
    expect(find(next).duration + right.duration).toBe(duration);
    const invalid = structuredClone(project); invalid.assets.source.duration--;
    expect(() => validateProject(invalid)).toThrow(/source duration/);
  });
  test("trim uses absolute timeline boundaries and speed-adjusted source bounds", () => {
    let project = applyCommand(fixture(), { type: "clip.update", clipId: "clip", patch: { sourceIn: sec(2), speed: 2 } });
    project = applyCommand(project, { type: "clip.trim", clipId: "clip", edge: "in", time: sec(3) });
    expect(find(project).sourceIn).toBe(sec(4)); expect(find(project).duration).toBe(sec(5));
    const expanded = applyCommand(project, { type: "clip.trim", clipId: "clip", edge: "in", time: sec(1) });
    expect(find(expanded).sourceIn).toBe(0); expect(find(expanded).duration).toBe(sec(7));
    expect(() => applyCommand(project, { type: "clip.trim", clipId: "clip", edge: "in", time: 0 })).toThrow();
    expect(() => applyCommand(project, { type: "clip.trim", clipId: "clip", edge: "out", time: sec(12) })).toThrow();
  });
  test("speed edits reject source overrun without changing the prior clip", () => {
    const project = fixture(); expect(() => applyCommand(project, { type: "clip.update", clipId: "clip", patch: { speed: 4 } })).toThrow();
    expect(find(project).speed).toBe(1);
    for (const speed of [0, -1, NaN, Infinity]) expect(() => applyCommand(project, { type: "clip.update", clipId: "clip", patch: { speed } })).toThrow();
  });
  test("in trimming retains the exact animation curve in its new local coordinates", () => {
    const keyed = applyCommand(fixture(), { type: "clip.update", clipId: "clip", patch: { keyframes: [{ id: "a", property: "rotation", time: 0, value: -45, easing: "smooth" }, { id: "b", property: "rotation", time: sec(6), value: 90, easing: "hold" }] } });
    const original = find(keyed), trimmed = find(applyCommand(keyed, { type: "clip.trim", clipId: "clip", edge: "in", time: sec(3) }));
    expect(trimmed.keyframes[0].time).toBe(-sec(1));
    for (const offset of [0, sec(1), sec(2), sec(4)]) expect(evaluateClip(trimmed, offset).transform.rotation).toBe(evaluateClip(original, sec(1) + offset).transform.rotation);
  });
  test("locked source and destination tracks reject all clip mutations", () => {
    let project = fixture(); project = applyCommand(project, { type: "track.update", trackId: trackId(project, "video"), patch: { locked: true } });
    const mutations: Command[] = [
      { type: "clip.remove", clipIds: ["clip"], ripple: true }, { type: "clip.split", clipId: "clip", time: sec(3), rightId: "r" },
      { type: "clip.trim", clipId: "clip", edge: "out", time: sec(7) }, { type: "clip.duplicate", clipId: "clip", newId: "r" },
      { type: "clip.move", clipId: "clip", trackId: project.tracks[0].id, start: 0 }, { type: "clip.update", clipId: "clip", patch: { opacity: 0.2 } },
      { type: "keyframe.set", clipId: "clip", keyframe: { id: "key", time: 0, property: "opacity", value: 1, easing: "linear" } },
      { type: "clip.add", trackId: project.tracks[0].id, clip: createClip({ asset: project.assets.source, id: "new", duration: sec(1) }) },
    ];
    for (const command of mutations) { expect(() => applyCommand(project, command)).toThrow(/locked/); expect(find(project).id).toBe("clip"); }
    const unlocked = applyCommand(project, { type: "track.update", trackId: project.tracks[0].id, patch: { locked: false } });
    expect(find(applyCommand(unlocked, { type: "clip.move", clipId: "clip", trackId: project.tracks[0].id, start: 0 })).start).toBe(0);
  });
  test("moves enforce track compatibility and destination locks", () => {
    const project = fixture(); expect(() => applyCommand(project, { type: "clip.move", clipId: "clip", trackId: trackId(project, "audio"), start: 0 })).toThrow();
    const next = applyCommand(project, { type: "track.add", track: { id: "locked", name: "Locked", kind: "video", muted: false, locked: true, clips: [] } });
    expect(() => applyCommand(next, { type: "clip.move", clipId: "clip", trackId: "locked", start: 0 })).toThrow(/locked/);
  });
  test("ripple removes the union of deleted ranges once and stays on affected tracks", () => {
    let project = fixture(); const source = project.assets.source, video = trackId(project, "video");
    project = applyCommand(project, { type: "batch", commands: [
      { type: "clip.add", trackId: video, clip: createClip({ asset: source, id: "overlap", start: sec(6), duration: sec(4) }) },
      { type: "clip.add", trackId: video, clip: createClip({ asset: source, id: "later", start: sec(12), duration: sec(1) }) },
      { type: "clip.add", trackId: trackId(project, "text"), clip: createTextClip({ id: "text", start: sec(12) }) },
    ] });
    const next = applyCommand(project, { type: "clip.remove", clipIds: ["clip", "overlap"], ripple: true });
    expect(find(next, "later").start).toBe(sec(4)); expect(find(next, "text").start).toBe(sec(12));
    expect(() => applyCommand(project, { type: "clip.remove", clipIds: ["clip", "stale"] })).toThrow(); expect(find(project).id).toBe("clip");
  });
  test("duplicate is independent and rejecting bad patches cannot mutate nested inputs", () => {
    const original = fixture(); const copied = applyCommand(original, { type: "clip.duplicate", clipId: "clip", newId: "copy" });
    expect(find(copied, "copy").start).toBe(sec(8)); find(copied, "copy").transform.x = 99; expect(find(copied).transform.x).toBe(0); expect(find(original).transform.x).toBe(0);
    expect(() => applyCommand(original, { type: "clip.update", clipId: "clip", patch: { id: "hijack" } } as unknown as Command)).toThrow();
    expect(() => applyCommand(original, { type: "asset.add", assets: [asset()] })).toThrow();
  });
});

describe("keyframes, render plans and captions", () => {
  test("evaluates linear, hold and smooth interpolation with fades", () => {
    const clip = createTextClip({ duration: sec(4) });
    clip.keyframes = [{ id: "a", property: "x", time: 0, value: 0, easing: "smooth" }, { id: "b", property: "x", time: sec(4), value: 100, easing: "linear" }, { id: "c", property: "opacity", time: 0, value: 0.2, easing: "hold" }, { id: "d", property: "opacity", time: sec(2), value: 0.8, easing: "linear" }];
    clip.fadeIn = sec(1); clip.fadeOut = sec(1);
    expect(evaluateClip(clip, sec(1)).transform.x).toBe(15.625); expect(evaluateClip(clip, sec(1)).opacity).toBe(0.2);
    expect(evaluateClip(clip, sec(2)).opacity).toBe(0.8); expect(evaluateClip(clip, sec(0.5)).opacity).toBeCloseTo(0.1);
    expect(evaluateClip(clip, sec(3.5)).opacity).toBeCloseTo(0.4); expect(evaluateClip(clip, sec(4)).opacity).toBe(0);
    expect(clip.transform.x).toBe(0);
  });
  test("keyframe set replaces same property/time while invalid values are atomic", () => {
    let project = fixture();
    for (const [id, value] of [["a", 0.2], ["b", 0.8]] as const) project = applyCommand(project, { type: "keyframe.set", clipId: "clip", keyframe: { id, time: 0, property: "opacity", value, easing: "linear" } });
    expect(find(project).keyframes).toHaveLength(1); expect(find(project).keyframes[0].id).toBe("b");
    expect(() => applyCommand(project, { type: "keyframe.set", clipId: "clip", keyframe: { id: "c", time: 0, property: "opacity", value: 2, easing: "linear" } })).toThrow();
  });
  test("interpolation between finite opposite extremes remains finite", () => {
    const clip = createTextClip({ duration: sec(2) });
    clip.keyframes = [{ id: "left", property: "x", time: 0, value: -Number.MAX_VALUE, easing: "linear" }, { id: "right", property: "x", time: sec(2), value: Number.MAX_VALUE, easing: "linear" }];
    expect(evaluateClip(clip, sec(1)).transform.x).toBe(0);
  });
  test("render plan has deterministic compositing order, source references and mute semantics", () => {
    let project = fixture(); project = applyCommand(project, { type: "track.update", trackId: project.tracks[0].id, patch: { muted: true } });
    project = applyCommand(project, { type: "keyframe.set", clipId: "clip", keyframe: { id: "v", time: 0, property: "volume", value: 2, easing: "linear" } });
    project = applyCommand(project, { type: "clip.add", trackId: trackId(project, "text"), clip: createTextClip({ id: "text", start: sec(1) }) });
    const plan = buildRenderPlan(project); expect(plan.segments.map((segment) => segment.clip.id)).toEqual(["clip", "text"]);
    expect(plan.segments[0].asset?.id).toBe("source"); expect(evaluateClip(plan.segments[0].clip, 0).volume).toBe(0); expect(find(project).volume).toBe(1);
    expect(plan.duration).toBe(projectDuration(project)); plan.settings.width = 42; expect(project.settings.width).toBe(1920);
  });
  test("SRT parses BOM, CRLF and multiline cues and serializes millisecond-exact times", () => {
    const text = "\uFEFF1\r\n00:00:01,250 --> 00:00:02,500\r\nHello\r\nworld\r\n\r\n2\r\n01:02:03,004 --> 01:02:04,005\r\nNext\r\n";
    const captions = parseSrt(text); expect(captions[0].start).toBe(sec(1.25)); expect(captions[0].text).toBe("Hello\nworld");
    const roundTrip = parseSrt(toSrt(captions)); expect(roundTrip.map(({ start, end, text }) => ({ start, end, text }))).toEqual(captions.map(({ start, end, text }) => ({ start, end, text })));
    expect(parseSrt(" ")).toEqual([]);
    for (const bad of ["garbage", "1\n00:61:00,000 --> 00:62:00,000\nOops", "1\n00:00:02,000 --> 00:00:01,000\nReverse", "1\n00:00:00,000 --> 00:00:00,000\nEmpty"]) expect(() => parseSrt(bad)).toThrow();
  });
  test("caption commands validate word bounds, stale IDs and durations", () => {
    const project = fixture(), caption = { id: "cue", start: sec(1), end: sec(3), text: "Caption", words: [{ text: "Caption", start: sec(1), end: sec(2) }] };
    const next = applyCommand(project, { type: "captions.replace", captions: [caption] });
    expect(() => applyCommand(next, { type: "caption.update", captionId: "cue", patch: { end: sec(1.5) } })).toThrow();
    expect(() => applyCommand(next, { type: "caption.update", captionId: "stale", patch: { text: "bad" } })).toThrow();
    expect(applyCommand(next, { type: "caption.update", captionId: "cue", patch: { text: "Edited" } }).captions[0].text).toBe("Edited");
  });
});

describe("bounded project-isolated EditorStore", () => {
  test("batch is one undo step; revisions stay monotonic and new edits clear redo", () => {
    const store = new EditorStore(fixture()); const initial = store.getSnapshot();
    store.dispatch({ type: "batch", commands: [{ type: "project.rename", name: "A" }, { type: "project.settings", patch: { width: 1280 } }] });
    expect(store.canUndo()).toBe(true); expect(store.undo().name).toBe(initial.name); expect(store.getSnapshot().settings.width).toBe(1920);
    expect(store.getSnapshot().revision).toBe(initial.revision + 2); expect(store.redo().name).toBe("A");
    store.undo(); store.dispatch({ type: "project.rename", name: "B" }); expect(store.canRedo()).toBe(false);
  });
  test("failed edits/replacements preserve snapshot identity, history and subscribers", () => {
    const store = new EditorStore(fixture()); let notifications = 0; const unsubscribe = store.subscribe(() => notifications++);
    const initial = store.getSnapshot(); expect(() => store.dispatch({ type: "clip.remove", clipIds: ["stale"] })).toThrow(); expect(store.getSnapshot()).toBe(initial); expect(store.canUndo()).toBe(false); expect(notifications).toBe(0);
    expect(() => store.replaceProject({} as Project)).toThrow(); expect(store.getSnapshot()).toBe(initial);
    store.dispatch({ type: "project.rename", name: "saved" }); expect(notifications).toBe(1); unsubscribe(); store.undo(); expect(notifications).toBe(1);
    expect(Object.isFrozen(initial.tracks[0].clips[0].transform)).toBe(true);
  });
  test("history bound and project replacement prevent cross-project undo", () => {
    const store = new EditorStore(fixture(), { historyLimit: 2 });
    for (const name of ["A", "B", "C"]) store.dispatch({ type: "project.rename", name });
    store.undo(); store.undo(); expect(store.canUndo()).toBe(false); expect(store.getSnapshot().name).toBe("A");
    store.replaceProject(createProject({ id: "other" })); expect(store.canUndo()).toBe(false); expect(store.canRedo()).toBe(false); expect(store.undo().id).toBe("other");
  });
  test("subscriber failure cannot turn a committed mutation into a false failure", () => {
    const errors: unknown[] = [], store = new EditorStore(fixture(), { onListenerError: (error) => errors.push(error) });
    store.subscribe(() => { throw new Error("view failed"); }); expect(store.dispatch({ type: "project.rename", name: "Committed" }).name).toBe("Committed"); expect(errors).toHaveLength(1);
  });
});

describe("versioned extension contracts", () => {
  test("the sample square tool edits the real store and the same history undoes it", () => {
    const store = new EditorStore(fixture()), registry = new ExtensionRegistry(store);
    const before = store.getSnapshot(), extension = createMakeSocialSquareExtension();
    registry.register(extension);
    expect(store.getSnapshot()).toBe(before);
    expect(extension.manifest.capabilities).toEqual(["project.read", "commands.dispatch"]);
    registry.activate(extension.manifest.id);
    expect(store.getSnapshot().settings.width).toBe(1080);
    expect(store.getSnapshot().settings.height).toBe(1080);
    expect(store.getSnapshot().tracks).toEqual(before.tracks);
    expect(store.getSnapshot().revision).toBe(before.revision + 1);
    expect(store.canUndo()).toBe(true);
    const restored = store.undo();
    expect(restored.settings).toEqual(before.settings);
    expect(restored.tracks).toEqual(before.tracks);
    expect(store.canUndo()).toBe(false);
    registry.dispose();
  });
  test("capabilities deny mutations and registration never invokes a provider", () => {
    const store = new EditorStore(fixture()), readOnly = createEditorApi(store, ["project.read"]);
    expect(readOnly.getSnapshot().id).toBe("p"); expect(() => readOnly.dispatch({ type: "project.rename", name: "bad" })).toThrow(); expect(() => readOnly.buildRenderPlan()).toThrow();
    const registry = new ExtensionRegistry(store); let activated = 0, disposed = 0;
    registry.register({ manifest: { id: "test.provider", version: "1.0.0", apiVersion: 1, kind: "ai-provider", name: "Future provider", capabilities: ["project.read"] }, activate(api) { activated++; expect(api.getSnapshot().id).toBe("p"); return () => { disposed++; }; } });
    expect(activated).toBe(0); registry.activate("test.provider"); expect(activated).toBe(1); expect(() => registry.activate("test.provider")).toThrow();
    const manifests = registry.list(); manifests[0].name = "external edit"; expect(registry.list()[0].name).toBe("Future provider"); registry.dispose(); expect(disposed).toBe(1); expect(registry.list()).toEqual([]);
  });
  test("extension version and capability mismatches cannot register or mutate the project", () => {
    const store = new EditorStore(fixture()), registry = new ExtensionRegistry(store), before = store.getSnapshot();
    const extension = { manifest: { id: "test.tool", version: "1.0.0", apiVersion: 1, kind: "tool", name: "Tool", capabilities: ["project.read"] }, activate() {} };
    for (const manifest of [{ ...extension.manifest, apiVersion: 2 }, { ...extension.manifest, capabilities: ["filesystem.write"] }, { ...extension.manifest, version: "latest" }]) expect(() => registry.register({ ...extension, manifest } as never)).toThrow(EditorError);
    expect(registry.list()).toEqual([]); expect(store.getSnapshot()).toBe(before);
  });
});
