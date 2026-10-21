# AI processing model

Decision confirmed by Nate on 2026-10-21: **Local by default, optional cloud providers.** This replaces the provisional default in the initial foundation milestone.

## Product behavior

- Every supported AI operation starts with its local implementation selected. If the required model or hardware is unavailable, explain what is missing and offer local setup or a deliberately selected cloud alternative. Never upload media as an automatic fallback.
- Cloud providers are optional integrations. Enabling one does not change the default for unrelated tools or projects. The feature must identify the selected provider, the data it will send and any available usage/cost estimate before starting the job.
- Selecting a cloud provider and starting that named operation is the user action authorizing that job. Do not add repeated confirmation dialogs to an already explicit cloud workflow. Imports, project opens, autosaves, thumbnails, proxies and local jobs must not trigger cloud processing.
- Send only the source range and data needed for the selected operation. Keep credentials in the native host's credential store, separate from project files, SQLite project payloads, logs, exports and evidence bundles. Do not place provider secrets in renderer state.
- Track provider/model identity and local-versus-cloud execution on each job and generated result. Cancellation, failure, network loss and unavailable models must remain explicit job outcomes. Do not silently switch providers or retry through another service.
- Cloud capability status stays unavailable until its actual adapter, configuration, job lifecycle and meaningful acceptance tests exist. A manifest, policy document or settings control alone is not a working AI feature.

## Current implementation

The delivered foundation preview already runs caption transcription locally through FFmpeg's Whisper filter with a pinned English tiny.en GGML model. Source audio is processed by the installed local executable. There is no cloud caption fallback or configured cloud provider in that build. Proxy generation and silence analysis are also local native jobs.

The renderer currently blocks remote networking. Any future cloud integration must use a specific native-host provider adapter and the validated job contract, rather than broadening renderer network or filesystem access. The existing extension API is an in-process editing API; it is not an implemented cloud provider or plugin security sandbox.

## Provider acceptance gates

| Check | Required result |
|---|---|
| Fresh profile | Local processing selected; cloud adapters disabled/unconfigured |
| Missing local model | Clear unavailable status; zero automatic cloud jobs |
| Optional provider configured | Local remains the default; unrelated project operations remain local |
| Explicit cloud job | Provider and transmitted range visible; only the chosen operation runs remotely |
| Failure or cancellation | Correct terminal state; no fallback upload or hidden alternate provider |
| Persistence and exports | No credentials in project JSON, database project payloads, logs, exports or evidence |
| Generated result | Provider/model and execution location retained as provenance |

These gates apply when real cloud adapters are implemented under the modern feature baseline. This decision does not mark those adapters or advanced AI features complete.
