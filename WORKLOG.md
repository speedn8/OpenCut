# OpenCut Next engineering log

## 2026-10-20: fresh product implementation

The user clarified that the intended product is a freshly authored modern editor, not an older or Classic-derived editor. PR #1 and the OpenCut Studio binaries are preserved as a previous prototype. This branch starts from verified current upstream main e668010778568641babef2cc40be4703ae6916d6, without importing that prototype's implementation.

Fresh scopes: validated integer-time domain and commands; React interface and Canvas preview; native Electron host, SQLite CAS persistence and FFmpeg media jobs. The shared RenderPlan is the preview/export contract. Separate app identity/profile and origin prevent prototype data collisions. This is a new product implementation with an explicit feature baseline, not a claim that every advertised commercial feature is finished.

REA skill v42 and connected REA 6.7.0 were verified. Binary findings remain evidence about the installed CapCut artifact. Original CapCut code, models and assets are not incorporated. Normal source/build tools apply to this fresh codebase.

Current package versions were checked against npm before acquisition. Existing installed FFmpeg exposes native codecs, local Whisper transcription, drawtext and libass. The first local model is acquired separately with source identity, checksum and license; app processing never downloads or uploads media by default.

Implementation and test evidence will be appended as integration proceeds. Implemented interfaces alone do not establish completed feature behavior.

- Fresh source builds and passes TypeScript7.0.2. Current pinned renderer stack: React19.3.1, Vite8.3.4; Electron44.9.2. Workspace-only Bun1.4.3 runs the original core/session/helper suite:46passed,0failed,538assertions. Runtime application dependencies returned zero npm advisories in the scoped production-dependency audit.
- Native suite:15passed,0failed,0skipped. Real H.264/VP9 layered exports, imported/proxied source audio, local CPU Whisper, SQLite CAS/journal/reopen, range streaming, child/queue cancellation, and overwrite protection across registrations/aliases/hardlinks passed. All six keyframe properties now export; decoded position/opacity/gain and scaled/rotated corner fixtures verify actual output. Native surfaces remain bounded to8192pixels; no GPU performance claim.
- Desktop workflow7 passed14checks in disposable profiles: startup/tool/model discovery, create/import, layer placement/transform, playback/split/undo/redo, title/SRT/current paused frame, MP4 completion and decoded moving video/nonzero audio, close/relaunch exact persistence, actual offline captions, proxy consumption, real SQLite write failure close protection/retry, and conflict Save a copy preserving the external original. App instances closed and port38851released.
- Independent review found and repaired fractional-speed preview ticks, measured source FPS versus project grid validation, pending import/switch loss, overlapping inaccessible same-lane clips, stale job replies, proxy integration, conflict recovery, source overwrite aliases, stale paused-decoding flags and trimmed waveform windows. Earlier failed runs are retained as failed evidence. Workflow7 uses decoded-frame tick metadata rather than sampling a potentially stale canvas.
- Static fixture preview/native comparison at2.5s uses identical unscaled source coordinates: mean absolute RGB channel error10.4239/255. This passes a20/255 smoke tolerance but is not pixel identity. Color-management/HDR and exact text raster equivalence remain broader release work; the downsampled comparison is retained separately and is not the canonical metric.
- Packaging, source provenance, final artifact checks and remote branch/PR verification remain pending at this entry. Full modern replacement scope remains open under specs/modern-editor/FEATURE-BASELINE.md; do not describe this foundation milestone as complete feature parity.
- Packaged Windows app repeated all14desktop acceptance checks. Actual168919241byte portable wrapper passed3checks: bundled model/tool discovery, UI-authored position/scale/rotation/opacity animation with8keys exported natively, and saved native close/launcher exit0. Authenticode status NotSigned. ASAR SHA256c81588978870187e9ec635b708b51a43801dbdc09c3a59dc069878bd96464e27;13runtime/renderer files matched,0excluded files found; required licenses/model identity present. Full source and evidence handoff preparation follows.

## 2026-10-21: confirmed AI processing choice

Nate answered the outstanding processing-model question: local by default, optional cloud providers. Recorded the product behavior and future provider acceptance gates in specs/modern-editor/AI-PROCESSING.md and linked it from README-NEXT.md/the engineering contract. Current native transcription/proxy/silence remain local; remote renderer networking remains denied. No cloud adapter, credential access or upload was introduced.

This change records the confirmed requirement; runtime code and the verified 0.1.0 binary are unchanged. Existing build/test results remain historical evidence for that binary. No additional runtime tests or repackaging are needed for this documentation-only update. Full modern feature scope remains open.
