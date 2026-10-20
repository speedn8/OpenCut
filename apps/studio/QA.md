# Verified local preview: 2026-10-20

OpenCut Studio 0.1.0 is ready for the local editing workflow below on the tested Windows x64 machine. Full CapCut feature parity, CapCut draft compatibility, and production-scale certification remain open.

| Check | Result | Evidence / reproduction |
| --- | --- | --- |
| TypeScript client import graph | PASS | `bun run check` |
| Source and regression tests | PASS: 261 tests, 839 assertions | `bun run test`; real published WASM plus a real Skia Canvas backend in the test preload |
| Production renderer build | PASS | `bun run build`; Vite 8.0.0, opencut-wasm 0.2.10, mediabunny 1.41.0 |
| Windows unpacked and portable packaging | PASS | Electron 44.9.2, electron-builder 26.15.3; application is unsigned |
| Import video, audio and image | PASS | `tests/desktop-workflow.mjs`: generated VP9 WebM, 48 kHz PCM WAV, PNG |
| Playback, split, Undo and Redo | PASS | Same workflow; clip counts checked before/after each operation |
| Save, close, relaunch, reopen | PASS | Same disposable profile; media and edited timeline survive process exit |
| MP4 export, decoded video and audio | PASS | Two distinct nonblack decoded frames; 320x180 output about 2.21 seconds; decoded stereo audio RMS about 0.143 |
| Failed write blocks close; retry persists | PASS | Deliberate quota error; Keep Editing path; restore storage and reopen with the previously failed edit |
| Text editing and active project rename | PASS | Edited text and renamed project survive relaunch |
| Project history isolation | PASS | Create a second project, Undo/Redo leave it empty; close/create/load boundaries also have unit regressions |
| Navigation save barrier | PASS | Four regressions verify pending, failed, history and overlapping route changes |
| Renderer isolation and offline workflow | PASS | Sandbox and context isolation enabled, Node integration disabled; no remote requests or unexpected renderer exceptions in the workflow |
| Portable self-extraction and native close | PASS | `tests/portable-smoke.mjs`; create/save project, native Electron close, local server shutdown, launcher exits 0 |

The MP4 check verifies representative generated content. It does not establish long-clip sync, every codec/container, 4K throughput, hardware encoder compatibility, or all export settings. GPU effects, masks, keyframes, speed controls and advanced audio tools require broader visual and media QA. WebM export and cancellation are present but not part of the verified desktop workflow above.

## Reproduce desktop checks

Use an interactive Windows test desktop and keep ports 38841-38843 free. Install dependencies and build first. Each script creates its own disposable profile and generated media outside the source folder. It never opens an existing CapCut or Studio profile.

```powershell
bun run check
bun run test
bun run desktop:dist
$env:STUDIO_TEST_EXE = (Resolve-Path '.\release\win-unpacked\OpenCut Studio.exe').Path
node tests/desktop-workflow.mjs
Remove-Item Env:\STUDIO_TEST_EXE
node tests/portable-smoke.mjs
```

The portable wrapper does not expose the normal Playwright Electron handshake. Its smoke test uses temporary loopback inspector ports to call the same native close path; these flags are test launch arguments, not application defaults. Browser `window.close()` and the page-close protocol are not substitutes for that native close test.

## Source test environment

The published wasm-bindgen package expects a bundler. Bun 1.2.18 imports raw `.wasm` as a path; `tests/wasm-preload.ts` instantiates the exact installed binary with its shipped glue and exports the real instance to the unchanged package wrapper. It also provides a real Skia Canvas for text geometry tests because Bun has no DOM Canvas. Neither backend replaces the production Chromium renderer.

Inherited fractional-tick and mask guide/tangent expectations were corrected to valid integer MediaTime and independent geometry. Curve subdivision is checked against 101 Bernstein samples and preserves input data. No production mask math was changed to satisfy these tests.
