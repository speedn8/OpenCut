# Editor core

Fresh, dependency-free TypeScript domain implementation for the modern editor.
All public exports are in `src/index.ts`; the shared contract is `src/types.ts`.
No UI, filesystem, codec, legacy editor, network or model-download code is used.

- `validateProject(unknown)` returns a validated independent `Project` or throws
  `EditorError`; unsupported schema fields and invalid references are rejected.
- `applyCommand(project, command)` returns an independent project. Failures are
  atomic. A batch is one revision and one store history entry. Existing locked
  tracks reject clip mutations; their lock/mute/name controls remain editable.
- `asset.update` applies authoritative metadata without changing asset identity.
  Native adapters own `url`/`proxyUrl` normalization; preview may use `proxyUrl`
  while native rendering resolves the registered original. Updates revalidate
  all clip references/source bounds atomically and participate in Undo/Redo.
- Timeline ticks are integer counts at 240000 Hz. Rational FPS must have integral
  frame durations for the project grid. Source metadata FPS is a positive rational
  of at most 1000 fps and may represent a VFR average without integral timeline
  frame ticks. Frame snapping uses integer arithmetic and half-away ties.
- `clip.trim.time` and `clip.split.time` are absolute timeline boundaries.
  `sourceIn` is integer source time; AV bounds use ceil(duration × speed), and
  cuts advance sourceIn using floor(delta × speed), keeping source quantization
  below one tick while preventing source overruns. Stills ignore source duration.
- Keyframes are local to a clip. Retained keys before zero or after duration keep
  linear/hold/smooth interpolation exact after cuts. UI should display only keys
  inside the visible clip. A key's easing controls its outgoing interval.
- Split retains fades at original outer edges and adds no fade at the cut.
  Trim clamps fade durations. Cuts within an existing fade can re-anchor/truncate
  that fade; this is the current editing policy, not sample-preserving fade baking.
- `evaluateClip` takes integer clip-local time and returns evaluated transform,
  opacity and volume. Fades affect opacity and volume. Active intervals are
  half-open [start, start + duration), checked by the rendering consumer.
- Color multipliers have neutral 1 and range 0..2. x/y are centered canvas pixels,
  scale is a positive multiplier, and rotation is degrees. Default text is Arial.
- `buildRenderPlan` is independent of the input, sorted bottom-to-top by original
  trackIndex then start/id. Muted tracks zero both base and animated volume.
  It does not strip keyframes/effects to accommodate export limitations; exporters
  must implement properties or reject them explicitly.
- `EditorStore` snapshots are deeply frozen and stable until a successful change.
  Undo/Redo revisions increase monotonically. Replacement clears history even for
  the same project ID. The history limit defaults to 100 entries.
- SRT parsing is strict and retains multiline cue text. SRT serialization rounds
  to milliseconds, retains a minimum 1 ms cue and cannot preserve word metadata.
- Extension API v1 exposes capability-checked project/command/render/subscription
  methods to explicitly registered extensions. It is an API contract, not a JS
  sandbox. Registration alone implements no AI provider or additional effect.

`examples/make-social-square.ts` is a working tool extension with only project-read
and command-dispatch capabilities. Explicit activation changes the current
canvas to a square based on its shorter side through `project.settings`; the
same store's Undo restores the previous canvas and keeps clips intact. This is
an extension integration example rather than an arbitrary third-party loader.

Run `bun test packages/editor-core/tests` from the repository root. A strict
standalone TypeScript check can target `packages/editor-core/src/index.ts` with
ES2023/DOM libraries and bundler module resolution. Host/renderer integration,
native persistence CAS, codecs, worker cancellation and export parity are owned
by their respective adapters and are not established by the pure-core tests.
