# Modern editor acceptance baseline

Baseline date: 2026-10-20. Product: a freshly authored extensible desktop editor. Scope is defined by user-visible behavior and reproducible acceptance evidence. A current dependency version, menu item, manifest, type declaration or advertised vendor feature is insufficient evidence of implementation.

Primary reference products: [CapCut desktop tools](https://www.capcut.com/tools/desktop-ai-power), [Premiere current release notes](https://helpx.adobe.com/premiere/desktop/whats-new/whats-new.html), [DaVinci Resolve current features](https://www.blackmagicdesign.com/products/davinciresolve/whatsnew). These establish a modern capability vocabulary, not installed entitlement or proof that this app already implements it. Final verification status is recorded separately in QA.md and verification artifacts.

## Foundation milestone being implemented

| ID | Capability | Required acceptance |
|---|---|---|
| F01 | Fresh modular source | No legacy editor code or proprietary assets; independent domain/UI/native packages build from lockfile |
| F02 | Frame-accurate project model | Integer time; common fractional rates; malformed projects rejected without partial mutations |
| F03 | Multitrack timeline | Video/audio/text tracks, editable positions/durations; lock and mute respected |
| F04 | Editing commands | Split, trim, move, delete, duplicate, ripple delete; source bounds preserved |
| F05 | Undo/redo | Commands and batches atomic; revisions monotonic; history cannot cross projects |
| F06 | Native import | Video/audio/image metadata, opaque media URLs, thumbnails/waveforms; no arbitrary renderer path access |
| F07 | Composition preview | Layering, contain fit, position/scale/rotation/opacity, basic color and fades; synchronized source audio |
| F08 | Keyframe preview | Linear/hold/smooth interpolation remains correct through trims and splits |
| F09 | Text overlay | Editable native text, alignment and backgrounds; explicit font behavior |
| F10 | Caption editing | SRT import, text/timing edits and timeline preview; timestamps validated |
| F11 | Local automatic captions | Real local speech inference, queued/cancellable, source-to-clip timing mapping |
| F12 | Native exports | H.264 MP4 and VP9 WebM; layered visual/audio timeline; decode resulting media to verify |
| F13 | Render parity | Unsupported properties rejected clearly; compare exported frames/audio to expected edits |
| F14 | Native job queue | Progress, cancellation, terminal-state correctness; no orphaned child processes |
| F15 | Proxies | Generate real lower-resolution media with native codec, linked to source identity |
| F16 | Silence analysis | Detect actual silent source ranges, return timings; do not label analysis as completed transcript editing |
| F17 | Reliable saves | SQLite transaction/CAS, revision journal; failed save blocks close/switch; successful retry persists |
| F18 | Project library | Create/name/list/open/reopen; separate profile from old prototype |
| F19 | Keyboard workflow | Command palette, transport, split/delete/save/undo/redo shortcuts, accessible labels |
| F20 | Extension seam | Versioned Editor API/capability validation; sample extension performs real undoable command; no plugin security sandbox claim |

## Full alternative release gates beyond this foundation

These remain required work until implemented and verified. They are not shipped features merely because extension seams exist.

| ID | Capability | Required acceptance |
|---|---|---|
| M01 | Animated export parity | Position/scale/rotation/opacity/gain curves match preview, including cut interpolation |
| M02 | Advanced timeline | Linked groups, snapping to edit points, slip/slide/roll, nested/compound clips, transitions |
| M03 | Multicam | Synced angle switching with editable source alignment and final render |
| M04 | Speed ramps | Variable-rate source-time integration and matching audio/export; optical flow separately measured |
| M05 | Masks/chroma | Keyframed masks, chroma edges, feathering and export parity |
| M06 | Tracking/stabilization | Motion estimation with editable track/key data and reproducible fixtures |
| M07 | Color workflow | LUTs, scopes, color management, HDR metadata and verified monitor/export handling |
| M08 | Audio production | EQ/compression/ducking/denoise, gain automation, voiceover recording and loudness meters |
| M09 | Transcript editing | Word-timed captions, word delete/fillers, transcript-to-timeline edits with undo and source preservation |
| M10 | Caption translation/style | Real multilingual model/provider, style presets, karaoke/word timing and export parity |
| M11 | Smart media search | Indexed semantic visual/dialogue search with actual retrieval results and local privacy controls |
| M12 | Auto reframe/cutout | Real subject detection/segmentation models and temporal consistency tests |
| M13 | Generative media | Working configured providers, explicit costs/processing policy, provenance and failure/cancel paths |
| M14 | GPU pipeline | Measured accelerated decode/composition/encode, memory bounds and supported device matrix |
| M15 | Media resilience | Relink/missing files, cache eviction, variable-rate/rotation metadata, broad codec/device coverage |
| M16 | Collaboration | Explicit collaboration design and implementation, conflict resolution, access controls and offline reconciliation |
| M17 | Install/release | Signed install/update pipeline, rollback, dependency/license inventory and long-video crash/load QA |
| M18 | External automation | Versioned headless/MCP adapters using the same command API, validation and authentication |

## Build order

1. Prove foundation editing/persistence/native render with generated media and disposable profiles.
2. Close preview/export gaps before expanding effect/AI catalog. Extend the same command and render contracts.
3. Add transcript, mask, audio and GPU services with separate worker/plugin contracts; preserve deterministic tests.
4. Implement optional generative/cloud/collaboration providers only as real independently testable features.
5. Finish cross-device, long-media, recovery, signing and update gates before declaring the complete alternative ready.

The complete modern alternative release requires every applicable gate above to pass. A foundation executable is a useful engineering milestone, not full CapCut/Premiere/Resolve parity.
