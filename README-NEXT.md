# OpenCut Next

A freshly authored desktop video editor in `apps/editor` and `packages/editor-core`, based on the current upstream scaffold. This implementation does not import OpenCut Classic, the earlier Studio prototype or opencut-wasm. React, Electron and FFmpeg remain normal maintained infrastructure dependencies.

The current release milestone is documented in `specs/modern-editor/FEATURE-BASELINE.md`. Completed behavior and outstanding release gates are recorded in QA.md. A working foundation build is not a claim that every modern commercial feature is finished.

## Build

Use Node 24.19 or later and an installed FFmpeg/ffprobe build. The pinned lockfile records exact dependency versions.

```powershell
npm ci
npm run typecheck
npm run build
npm run desktop
```

If local npm policy skipped Electron's install script, run `node node_modules/electron/install.js` once before build/launch. The runtime remains pinned to the lockfile version; no global installation is needed.

The app discovers codec tools using `OPENCUT_FFMPEG_PATH`/`OPENCUT_FFPROBE_PATH`, PATH and standard Windows WinGet package locations. Source imports and exports require FFprobe/FFmpeg. A GPL FFmpeg binary is not bundled into this preview.

Local transcription requires FFmpeg's `whisper` filter and a GGML model. Configure `OPENCUT_WHISPER_MODEL`, or stage the independently acquired model in `apps/editor/resources/models`. Model identity, source URL, required license and SHA-256 appear in `specs/modern-editor/MODEL-PROVENANCE.json`; weights are excluded from Git. The tested tiny.en model recognizes English. Recognition output remains editable and requires review.

`npm run model:acquire` explicitly downloads the pinned optional 78 MB model, verifies both byte count and SHA-256, and stages its notices for packaging. Application startup makes no model download or cloud request.

```powershell
npm run package:windows
```

Packaged extra resources include the separately staged MIT model and its notices. Portable builds are unsigned previews until the signing/update release gate is complete.

## Architecture

`packages/editor-core` owns validated versioned project data, integer time, immutable commands, bounded undo/redo, caption parsing, keyframe evaluation, render plans and a versioned extension API. It has no desktop or UI imports.

`apps/editor/src` owns the fresh React interface, project session/serialized save coordinator, Canvas composition preview, timeline and inspector. The renderer has no Node/filesystem access. Native dialogs authorize local input/output files through a narrow preload API.

`apps/editor/electron` owns SQLite CAS storage and revision journal, opaque media registrations, range-aware media delivery, FFmpeg/FFprobe and serialized cancellable native jobs. Export uses the core RenderPlan and rejects unsupported properties explicitly.

The desktop identity/profile is **OpenCut Next**, with a separate origin on `127.0.0.1:38851`. For disposable QA set `OPENCUT_NEXT_DATA_DIR` to a new absolute directory. Do not point tests at real user projects.

## Verification

```powershell
bun test packages/editor-core/tests tools/qa/session.test.ts tools/qa/clip-edits.test.ts
npm run test:native
```

Native codec tests and desktop workflow tests use original generated fixtures in an explicitly selected disposable evidence directory. UI, media decode, persistence/relaunch and packaged startup require their own runtime evidence in addition to unit tests. See QA.md for the last actual results and coverage limits.

## Extending

New editing behaviors are validated commands; complex edits use one atomic batch. New visual/audio features require matching preview and native-render implementations. An extension manifest does not create an AI capability. See `packages/editor-core/examples` for an undoable sample tool, and the baseline for provider/GPU/collaboration release gates.
