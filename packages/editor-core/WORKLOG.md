# Fresh modern editor core worklog

2026-10-20. Scope: newly authored `packages/editor-core` source and tests only.
The initial `src/types.ts` was retained until root explicitly authorized the
limited proxy URL/asset-update extension described below. Root-owned package
metadata was not edited. No implementation was read or copied from the Classic prototype,
and no third-party runtime dependencies, servers, installs or commits were added.

| Check | Result |
| --- | --- |
| Public contract exports | All required APIs exported from `src/index.ts` |
| Project-load validation | Plain JSON shape, schema, integer times, rational FPS, unique IDs, source references/bounds, track compatibility, fades, keyframe ranges, word bounds |
| Immutable commands | Add/remove/ripple/split/move/trim/duplicate/update, tracks, settings/name, captions, markers, keyframes and bounded atomic batches |
| Source timing | AV source extent rounds upward; cut source position rounds downward. Regression covers 0.7x at a 30000/1001 frame boundary without source overrun |
| Keyframe cuts | Retained local interpolation context proves smooth curves unchanged across split and trim |
| Render contract | Independent plan, deterministic bottom-to-top order, original track indices, animation and mute semantics preserved |
| Store | Frozen stable snapshots, bounded per-project history, one-step batches, monotonic revisions, invalid-action identity/history retention, observer-error isolation |
| Captions | Strict SRT parse/serialization, millisecond precision, multiline text, malformed/reversed cues rejected |
| Extensions | API version 1, semver manifests, explicit registration/activation/disposal and checked capabilities. No AI/effect provider implementation is claimed |
| Working extension example | `examples/make-social-square.ts` uses only read/dispatch capabilities, performs a real validated settings edit, and is undone by the same store with clip contents preserved |
| Bun tests | **31 passed, 0 failed, 209 assertions**, Bun **1.2.18** (`0d4089ea`), `bun test packages/editor-core/tests` |
| TypeScript | **Passed**, TypeScript **7.0.2**, `tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2023 --module ESNext --moduleResolution Bundler --lib ES2023,DOM packages/editor-core/src/index.ts packages/editor-core/examples/make-social-square.ts` |
| Dependency boundary | Source/tests import only core modules and `bun:test`; no filesystem, Electron, codec, network, Classic or WASM implementation imports |

Integration decisions and limits are recorded in `README.md`. Key points:
`validateProject` returns an independent validated project or throws;
`evaluateClip` returns a full evaluated clip with integer local time;
trim/split boundaries are absolute timeline time; keyframe context outside the
visible clip is retained; text defaults to Arial; CSS color multipliers are
neutral at 1; snapshots are immutable; Undo/Redo cannot cross project loads.

Fade edits use outer-edge/clamping semantics rather than sample-preserving fade
baking. SRT cannot retain sub-millisecond or word metadata. Extension capabilities
are an API boundary rather than a JavaScript sandbox. Native storage CAS,
codec/export-property support, job cancellation, real media preview and packaged
application behavior remain integration responsibilities with separate QA.

Integration review correction approved by root: asset FPS is source metadata,
not the project edit grid. Positive rational source rates up to 1000 fps now
validate without requiring integral timeline frame ticks. A 30017/1000 VFR-average
regression covers asset creation, atomic import and JSON reload while proving the
same rate remains invalid for project-grid settings. Invalid/zero/fractional
integer components and rates above 1000 fps are rejected. Shared types unchanged.

Second integration correction explicitly approved by root: `Asset.proxyUrl?:string`
and `asset.update {assetId,patch:Partial<Omit<Asset,"id">>}` were added to the
shared contract. Proxy metadata is a validated nonempty plain string; native owns
authoritative URL/protocol normalization. Updates validate the entire project,
including source bounds and kind compatibility, before committing. Regression
tests cover proxy persistence, unchanged original URL/clips, Undo/Redo, invalid
metadata, stale IDs, forbidden ID patches and failed-batch atomicity.
