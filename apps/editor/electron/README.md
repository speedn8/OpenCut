# Native editor host

Original Electron host for the shared `EditorHost` contract. `main.cjs` loads the root-generated `core.cjs`; rebuild that bundle after domain changes. The renderer never receives Node, a generic IPC channel, source paths, or arbitrary filesystem operations.

## Ownership and storage

- The fixed renderer origin is `http://127.0.0.1:38851`. The host claims loopback exclusively and refuses an occupied port. There is no random port or foreign-server fallback.
- The profile is `%APPDATA%\OpenCut Next`; `OPENCUT_NEXT_DATA_DIR` selects an absolute disposable profile. Chromium data lives under `browser-session`.
- `state.sqlite` uses WAL, `synchronous=FULL`, a transaction per save, and compare-and-swap **storage versions**. Every acknowledged save inserts its JSON into the revision journal. Domain command revisions remain separate.
- Imported sources remain in their original locations. SQLite records native registrations and selected-source size/mtime. Opaque `app-media://media/<id>` URLs stream only those registrations, with GET/HEAD, single byte ranges, and renderer-origin CORS. Thumbnails and proxies use bounded identifier variants.
- Moving or changing a source makes playback/export reject that registration. Native project metadata can still be saved. Relinking and recovery UI are not implemented by this host.
- Back up the whole profile while closed, together with original source media. SQLite contains private source paths; assets returned to the renderer contain opaque URLs.

Native dialogs choose imports and export destinations. Output protection covers every registered original, including unused assets, realpath aliases and existing hardlinks, before encoding and again before commit. Encoding uses a staged output, then renames it after success. Cancellation removes the partial staged file.

## Codec and model configuration

FFmpeg/ffprobe discovery checks explicit `OPENCUT_FFMPEG_PATH` / `OPENCUT_FFPROBE_PATH`, then PATH, then a bounded Windows WinGet package-directory search. Executables are caller-installed; this host downloads and bundles none. Child processes use argument arrays, `shell:false`, hidden windows, file/pipe input protocol allowlists and cancellation that waits for process exit.

Local transcription uses the installed FFmpeg `whisper` filter on CPU, queue 20, and local SRT output parsed by shared `parseSrt`. `OPENCUT_WHISPER_MODEL` selects an explicit existing ggml file. Otherwise discovery checks packaged `resources/models/ggml-tiny.en.bin`, then the development `apps/editor/resources/models` folder. The default bundled model must match SHA-256 `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f`, checked once per host lifetime. Its redistribution/license/provenance files are owned by packaging. There are no model or network downloads in the host.

Proxy completion returns `Job.result = {asset: Asset}` with an authoritative `proxyUrl`; opening projects rehydrates it. Export always uses registered originals. Transcription returns `Job.result = Caption[]` in **whole-source 240000 Hz ticks**. Silence analysis returns `{assetId,timebase,thresholdDb,minimumDuration,ranges}` with a fixed -35 dB threshold and 0.5-second minimum.

## Rendering and explicit limits

Export consumes shared `buildRenderPlan`, in its bottom-to-top order. Both MP4/libx264/AAC and WebM/libvpx-vp9/Opus use the CPU filter pipeline. It implements cuts/source trim/speed, layered contain/position/static scale/static rotation, RGB brightness → contrast → saturation, opacity/fades, stereo 48 kHz audio mixing, text and all active captions. Font families map to installed regular Arial, Segoe UI, Times New Roman, Consolas or Calibri. Caption size/position/stroke and per-line spacing follow preview conventions; rasterizer/font metrics are not claimed pixel-identical.

All six animated properties generate bounded FFmpeg expressions from validated keys. Linear, hold and smooth easing preserve earlier/later interpolation context. Scale/rotation keys use a separate fixed transparent working surface, premultiplied alpha and per-frame destination-coordinate perspective; static geometry keeps its existing path. The [installed FFmpeg commit's perspective source](https://github.com/FFmpeg/FFmpeg/blob/4348bde2d2/libavfilter/vf_perspective.c) admits GBRAP and uses one-based output counters, so clip-local frame time is `(on-1)/fps`. **Nontransparent text backgrounds reject explicitly** until their preview box metrics are reproduced. No silent static flattening or background substitution is used.

Current export admission: even canvas dimensions 2–4096 per side, 1–120 fps, nonempty timeline at most six hours, at most 128 clips/5000 captions, 256 keys per animated property, static scale 0.01–8 with intermediate sides at most 8192, and text up to 10000 characters/font size 1–1000. Source import accepts known durations up to 24 hours; individual native time selectors are bounded to six hours. Unsupported values/codecs/filters fail the job with an error. Broad codec compatibility, long timelines, text raster parity and other GPU/OS combinations remain separate QA work.

## Lifecycle and IPC

The sandboxed preload exposes only named `EditorHost` calls and typed job/close subscriptions. Every main-process invocation validates the exact window, main frame and fixed origin. Remote networking, external navigation/new windows, webviews, capture/device and permission requests are denied.

Jobs run through one FIFO with progress and one terminal state. Cancel waits for the child to exit. Finished closures and large payloads are released after delivery. Closing sends a hidden-token save request; the renderer awaits its native save before acknowledging. Failure, timeout or a crashed renderer offers **Keep Editing / Discard and Close**. A late response cannot acknowledge a newer close request. Exit closes/cancels native jobs, closes SQLite and releases the local server.

## Verification

From `apps/editor`, after the root build generates the shared core:

```powershell
node --test electron/tests/native.test.cjs electron/tests/codecs.test.cjs
```

`OPENCUT_TEST_SPEECH` optionally selects the explicitly generated WAV fixture for the real import/proxy/silence/transcription test. Native codec tests use generated temporary media and never launch Electron or a listener. Missing local codecs/speech cause the applicable integration case to skip; read the test totals.

The final scoped run passed **15/15, zero skips**, including real H.264/VP9 layered exports and offline speech transcription. Decoded animation moved the red centroid from (45.5,32.5) to (81.5,62.5), increased red mean 65.96→217.34 and audio RMS 0.01980→0.06209. A separate geometry fixture increased colored-corner span 29.90→43.63 pixels, rotated 1.49°→148.57°, switched a hold key at frame 15, retained corner order and preserved transparent exterior pixels. This confirms those fixture behaviors; app-wide readiness and packaged-app QA belong to the root verification matrix.
