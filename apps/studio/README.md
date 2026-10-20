# OpenCut Studio

A local desktop video editor adapted from OpenCut Classic. Studio runs its built React/Vite renderer inside Electron, with no Next.js server, sign-in, cloud account, database service or API key required. Dependency installation needs network access; normal local editing does not depend on a hosted service.

This is a local preview with a verified editing, save/reopen and MP4 export workflow. See [QA.md](QA.md) for exact checks and their limits. Full CapCut parity remains open.

## Build and run on Windows x64

Run these commands from `apps/studio`, using Bun on your PATH. Development currently uses Bun **1.2.18**; the lockfile pins Electron **44.9.2** and electron-builder **26.15.3**.

```powershell
bun install --frozen-lockfile
bun run check
bun run test
bun run build
bun run start
```

`start` opens Electron against the existing `dist` build. Rebuild after renderer changes. It does not start a development server or require the repository's separate GPUI application.

The desktop origin is always **`http://127.0.0.1:38841`**. Keep the host and port unchanged so project storage retains the same origin. Studio binds only loopback, uses a single-instance lock, and refuses startup if another application owns the port. It never attaches to that application's server.

For browser development, `bun run dev` also uses port 38841. Stop Vite before starting Electron. A browser preview has its own browser profile and therefore separate project storage from the desktop application.

## Windows portable build

```powershell
bun run desktop:pack
bun run desktop:dist
```

`desktop:pack` builds an unpacked application under `release/win-unpacked`. `desktop:dist` builds the Windows x64 portable executable under `release`, named `OpenCut-Studio-<version>-Windows.exe`. These scripts rebuild the renderer first. Packaging and distribution checks are separate from editor feature QA; do not assume either is complete from these instructions.

The portable executable uses the profile below. Project data is not stored next to the executable.

## Local data and backups

The default profile is **`%APPDATA%\OpenCut Studio`**, with Chromium storage in its **`browser-session`** child. Projects, imported media and settings use local browser storage, including IndexedDB and the origin private file system (OPFS).

Close Studio, then back up the **entire profile folder**, including `browser-session`. Metadata alone is not a complete media backup. Keep original source media and exported files separately. Do not copy or replace a live profile while Studio is running; validate a restored copy before relying on it.

For a disposable development profile, set an absolute path before launch:

```powershell
$env:OPENCUT_STUDIO_DATA_DIR = Join-Path $env:TEMP "OpenCut-Studio-test-profile"
bun run start
Remove-Item Env:\OPENCUT_STUDIO_DATA_DIR
```

The override changes the profile directory, not the fixed origin or port. It is intended for tests and does not import another editor's projects. Removing the environment variable leaves the test folder on disk and restores the default profile on the next launch.

Studio shows local save status and a save/retry action. Closing asks the editor to finish pending saves. If saving fails, times out or the renderer stops, choose **Keep Editing** or explicitly **Discard and Close**. A forced process termination bypasses that exchange.

## Capability boundaries

| Status | Scope |
| --- | --- |
| Implemented | Local project library, media import, timeline editing and preview, text with system/CSS fonts, available GPU effects controls, export UI, local save/retry state and desktop close/save coordination. |
| Requires broader verification | Large/long timelines, codec and container combinations, long-clip audio/video fidelity, advanced effects and keyframes, GPU compatibility and interruption recovery. |
| Unavailable in this edition | Captions/transcription, hosted sounds/stickers/stock asset libraries, cloud sync, account/auth services, CapCut premium assets, CapCut project/draft compatibility, transitions and adjustment panels. |

Implemented means the code path is present. [QA.md](QA.md) distinguishes tested workflows from broader compatibility work.

## Provenance and licenses

The editor source derives from the MIT-licensed [OpenCut Classic](https://github.com/OpenCut-app/opencut-classic/tree/cf5e79e919144200294fb9fed22a222592a0aeea) commit **`cf5e79e919144200294fb9fed22a222592a0aeea`**. `CLASSIC-SOURCE.json` records the original paths and SHA-256 identities; local adaptations are tracked separately by Git. Preserve `LICENSE-CLASSIC` and `THIRD_PARTY_NOTICES.md` when redistributing.

The fork's GPUI rewrite remains a separate application. Studio uses published open-source dependencies, including `opencut-wasm`; it contains no extracted CapCut code, native binaries, models, proprietary assets or credentials.
