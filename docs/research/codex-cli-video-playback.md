# Codex playback of JSON CLI video artifacts

- **Status:** research only; product validation pending
- **Date:** 2026-09-27
- **Question:** What artifact format and access path should the `rip-dvd` JSON CLI provide so an agent using the Codex desktop app can show a playable Damage Preview and inspect a finished Encode Output in the conversation? How do a local path, an authenticated web URL, and an explicit CLI export behave when the application runs on another host?

## What the sources establish

The [official OpenAI file-preview documentation](https://learn.chatgpt.com/docs/artifacts-viewer) names desktop previews for documents, presentations, spreadsheets, PDFs, and available HTML previews. It says Codex CLI can create files but has no visual file-preview interface. It does **not** specify a supported video codec, maximum size, an inline-video Markdown contract, or transport of video from a remote host into a desktop conversation. A working video player in a browser page also would not prove that a video attachment renders inline in chat.

The [official OpenAI browser documentation](https://learn.chatgpt.com/docs/browser) says the desktop app can open local web apps in its built-in browser. The browser has its own profile and access controls. This supports testing an authenticated playback page or route in the app's browser, but it is not a guarantee that a media URL embedded in a CLI JSON response will play in the chat transcript.

The [official OpenAI remote-connections documentation](https://learn.chatgpt.com/docs/remote-connections) says remote work uses the connected host's files and tools, and commands may run on that host or its remote environment. It does not promise that an absolute path returned by a command on a remote server is directly readable by the desktop renderer. The path must be interpreted relative to the host that owns the bytes.

The Codex desktop integration available to this research session indicates that absolute-path Markdown image syntax can display a local video file. That is an app affordance, **not** a published compatibility promise in the official pages above. Its behavior with a synthetic MP4, remote-host paths, audio, seeking, and large clips remains unverified.

## Repository boundary

The current CLI emits one JSON value on stdout ([`emit` in `command.ts`](../../apps/operator-cli/src/command.ts)); its `inspect` command reads application operations rather than the web service ([`inspectCommand`](../../apps/operator-cli/src/command.ts)). The web operations route calls the same `inspectOperations` operation ([`route.ts`](../../apps/web/app/api/operations/route.ts)). The operation intentionally omits `outputPath` from the visible Encode Job ([`operations.ts`](../../packages/application/src/operations.ts)), though enqueue responses include the path ([`serializeJob`](../../packages/application/src/encode-jobs.ts)). No current output playback or export boundary is listed in the [operator capability inventory](../agents/operator-capability-parity.md). The existing DVD encode writes MKV ([`media-output-path.ts`](../../packages/application/src/media-output-path.ts)); its browser compatibility must not be assumed.

The [parity rule](../agents/operator-capability-parity.md) requires any new web playback operation to have a JSON CLI equivalent at the shared application-operation boundary, with public CLI behavior tests and focused adapter coverage. An `inspect` result alone does not make media bytes available to a Codex agent.

## Access paths

| Path | What it can provide | Limitation to validate |
| --- | --- | --- |
| CLI returns a server-local path | An agent running on that same filesystem could read an existing file. | A desktop app on another host cannot be assumed to resolve it. A path is neither media transfer nor playback authorization. Existing inspect output deliberately omits it. |
| CLI returns an authenticated playback URL | The app browser could open an operator-authorized web playback route when the URL is reachable and credentials are available. | Reachability, session authentication, expiry, browser format support, and chat-inline rendering are separate questions. Avoid durable URLs or tokens in copied JSON. |
| CLI explicitly exports a chosen artifact to a file | The CLI can materialize bytes in a caller-selected location while keeping stdout JSON-only. A local agent can then hand the absolute path to its app renderer or another player. | Export on a remote host still requires an authorized transfer to the desktop host, or playback through a reachable authenticated route. Clip size and cleanup require a policy. |

## Recommendation for product design

Make **explicit export** the dependable CLI operation: select an artifact by stable application identity, specify an output file, and return JSON metadata such as artifact identity, media type, byte count, and the path on the executing host. Keep media bytes off stdout so the CLI's JSON contract remains intact. Resolve and authorize the artifact in the shared application layer rather than accepting an arbitrary source path. Treat a local file path as usable for conversation playback only after a same-host Codex test proves it. For a remote deployment, use an authenticated, time-limited web playback/download route or an explicit authorized file transfer; a server path alone is insufficient.

An authenticated web route can serve the same artifact for app-managed playback, with the CLI reporting availability and a playback descriptor. If the product returns a URL, distinguish it from an exported file and avoid claiming it will render inline in chat. The browser route should be tested for seeking, audio, range requests, expiration, and access revocation. A browser-compatible derivative may be needed for MKV outputs; label that derivative as a playback rendition so operators do not mistake transport conversion for the exact encoded file. The Damage Preview should be produced with the selected title, angle, streams, and encoding choices used by the intended output, while any playback conversion is disclosed and checked for material visual or audio differences.

## Validation before committing to a Codex presentation path

Use only a tiny generated, synthetic clip and synthetic identifiers. Record app version and whether Codex runs locally or against a connected host in private test notes.

1. Export the clip with the proposed CLI command. Confirm stdout remains valid JSON, the file is readable on the executing host, and its reported type and size match the bytes.
2. In a local Codex desktop chat, try an absolute-path Markdown media reference to the exported MP4. Confirm **actual playback**, audio, and seeking. Try the app's file-opening path separately; do not infer one from the other.
3. Repeat from a connected remote host using a remote-only path. Determine whether the desktop renders it, downloads it, or cannot access it. Then test an explicit transfer to a local temporary file.
4. Open the authenticated playback route in the app browser. Confirm access, seek behavior, expiry, and whether a URL returned in JSON is merely clickable or actually playable inline in chat.
5. Repeat with a short synthetic MKV and its browser rendition. Compare picture, audio, subtitles, and timing; record which artifact the operator is viewing.

Until these tests pass on supported app versions, the CLI contract should promise **artifact export and playback availability**, not automatic in-conversation video rendering.
