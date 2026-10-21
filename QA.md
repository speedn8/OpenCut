# OpenCut Next verification

Release candidate: **0.1.0 foundation preview**, Windows x64, checked 2026-10-20 local date. The user requested a freshly coded modern alternative. This is the fresh implementation and a working engineering milestone. It does **not** complete every modern commercial feature in the acceptance baseline.

## Actual verification

| Check | Result | Evidence / reproduction |
|---|---|---|
| Original domain, UI and native source | Verified | New packages/editor-core and apps/editor; no Classic/Studio/opencut-wasm implementation imports. Current upstream base e668010778568641babef2cc40be4703ae6916d6 |
| Strict TypeScript | Passed | npm run typecheck, TypeScript7.0.2 |
| Domain/session/helper tests | 46passed,0failed,538assertions | Bun1.4.3; packages/editor-core/tests/core.test.ts, tools/qa/session.test.ts, tools/qa/clip-edits.test.ts |
| Native tests | 15passed,0failed,0skipped | apps/editor/electron/tests/native.test.cjs and codecs.test.cjs; actual codecs and original generated speech |
| Editing/close/relaunch workflow | 14checks passed | tools/qa/desktop.mjs; create/import/layers/playback/split/undo/redo/title/SRT/export/decode/reopen/captions/proxy/failure recovery/conflict-copy |
| Packaged app workflow | Same14checks passed | OPENCUT_TEST_EXECUTABLE points to the packaged OpenCut Next.exe; separate disposable profile |
| Portable wrapper | 3checks passed | tools/qa/portable.mjs; model/tool discovery, real UI-authored 8-key animation export, native save/close and launcher exit0 |
| Native animation | Decoded behavior passed | Position/opacity/gain and scale/rotation/corner/hold-boundary fixtures. All6properties use real render expressions; no static flattening |
| Offline transcription | Real CPU inference passed | Pinned MIT tiny.en model; generated original English speech recognized. No upload/model download by app |
| Proxy playback | Passed | Native proxy persisted/reopened, UI active badge, actual app-media proxy request observed. Export keeps original |
| Native storage write failure | Passed | Disposable SQLite trigger raises real write error; native close stays open on Keep Editing; retry persists original edit |
| CAS conflict recovery | Passed | External saved revision preserved; user chooses Save a copy; new complete project written with a new ID and expectedVersion:null |
| Source overwrite protection | Passed | Every registration checked, including unused originals, canonical aliases/junctions/hardlinks, before encode and commit |
| Source/model package integrity | Passed |13renderer/native files match build hashes; model77704715bytes and pinned SHA256 match; no test/profile/SQLite/env/map files in ASAR; React/runtime/model licenses present |
| Production npm advisories | 0reported | npm audit --omit=dev; point-in-time package advisory check, not a general security certification |
| Preview/native sample | Limited smoke passed | Exact unscaled RGB coordinates at2.5s: mean channel error10.4239/255 under20threshold. Not pixel identity or full color-management proof |
| Unsigned Windows release | Preview only | Portable Authenticode status NotSigned; signing/update/device/long-media gates remain open |

Raw workflow and package JSON, generated export, screenshots and checksums accompany the delivered artifact. Earlier failed runs remain retained as failures in the workspace. Test assertions were repaired for scale units, accessible proxy-label spelling, ASAR path separators and decoded-frame readiness. Actual product defects found by review/runtime were repaired separately and covered by regression checks.

## Implemented behavior

Fresh validated 240000Hz project clock; measured source FPS independent of project edit grid; immutable commands and atomic batches; multitrack video/audio/image/text placement; trim, move, duplicate, split, delete and ripple delete; per-project undo/redo; native file dialogs, media metadata/thumbnails/edited-source waveforms; Canvas/WebAudio preview with native proxies; static transform/basic color/opacity/fades; all six keyframe properties with linear/hold/smooth easing; editable text and SRT captions; offline English captions; silence analysis; versioned SQLite autosaves/journal/conflict recovery; H.264/AAC MP4 and VP9/Opus WebM exports; cancellable serialized native jobs; keyboard/command palette; capability-versioned in-process extension API and a real undoable example.

## Material limits

- This is a Canvas2D/WebAudio preview and CPU FFmpeg export. GPU rendering, HDR/wide-gamut color management, exact text raster parity, broad codecs/devices and long-video performance are unverified or pending. The sampled RGB difference above remains explicit.
- Nontransparent text backgrounds reject during native export. Font support is the documented installed Windows whitelist. Native bounds include even dimensions up to4096, up to120fps, six-hour export duration,128clips,5000captions,256keys/property and8192pixel intermediate surfaces. These are admission limits, not demonstrated performance at maximum values.
- The included tiny.en speech model is English-only and needs human review; no word-level diarization, translation, transcript editing or generative capability is implied. Those require real additional model/provider implementations.
- FFmpeg/ffprobe remain separately installed dependencies. The tested installed GPL build is N-121583-g4348bde2d2-20251031; it is not redistributed here. Discovery checks explicit environment, PATH and standard WinGet locations. The bundled MIT model is verified independently.
- No third-party plugin loader, plugin security sandbox, external MCP/headless adapter, account/collaboration backend, CapCut draft importer, media relink UI or project-file interchange is shipped.
- Tracking/stabilization, masks/chroma tools, advanced transitions/timeline/multicam/speed ramps, full audio production, semantic search, subject cutout/reframe, generation providers, and signing/update/recovery/device gates remain under specs/modern-editor/FEATURE-BASELINE.md.

## Build and extend

See README-NEXT.md. New edit behavior belongs in validated commands. New effects require preview and native rendering plus decoded acceptance evidence. API/provider registration alone is never a completed feature. The current upstream Rust/GPUI scaffold remains intact; this fresh implementation has its own React/domain/native packages and is independently buildable from the npm lockfile.
