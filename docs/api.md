# API implementation notes

Base: `/api/v1`, same-origin loopback service. Runtime schemas live in [shared contracts](../packages/contracts/src/index.ts); route-specific validation is in [app.ts](../apps/server/src/app.ts). These notes describe behavior and reference the schemas rather than maintaining a second set of field definitions.

## Session and revisions

`GET /session` with `X-App-Client: frame-to-video-studio` bootstraps an HttpOnly SameSite cookie and returns a CSRF token. Mutations need the cookie, exact Origin, X-App-Client and X-CSRF-Token. No CORS wildcard. Token remains in browser memory. See `security/session.ts` and its service tests.

Project mutations require `expectedRevision`. A stale revision returns 409 without silently merging changes. Most JSON API responses use `{data: ...}`; errors use `{error: {code,message,retryable,...}}`. Download endpoints deliberately return files, not the JSON envelope.

## Imports

- `POST /projects/:projectId/imports`: validates `importSchema`; requires an `Idempotency-Key` UUID. Purpose is frames/audio. Mode is replace/append/relink; audio accepts replace/relink only and exactly one file.
- `GET /projects/:projectId/imports`: open sessions for this project, newest first, for restoring UI after refresh.
- `PUT /imports/:importId/files/:fileId`: one multipart binary part named `file`, streaming to managed temporary storage. Size and SHA-256 are verified. Retry is whole-file, not byte resume. A changed retry cannot overwrite accepted source content.
- `GET /imports/:importId`: per-file status, accepted source identity and any error. Paths supplied by the client are display/sort metadata, never server write paths.
- `DELETE /imports/:importId/files/:fileId`: remove a non-active file before finalize.
- `POST /imports/:importId/finalize`: publish a complete valid manifest at `expectedRevision`. Project and registry are persisted before completion is returned. `lastImportId` permits recovery if project commit happened before import status was written.
- `DELETE /imports/:importId`: cancel and wait for active writes/temporary files to settle before releasing quota.

Creation idempotency is persisted in registry metadata. Same key and body return the same session; a different body returns 409. Open sessions survive restart with whole-file retries; incomplete `.part` bytes do not. Stalled streams timeout after 60 seconds. TTL maintenance cancels expired sessions and collects unreferenced source copies.

Relink mode accepts only content matching missing frame hashes (or the missing audio hash). It preserves frame IDs/order and rendering/audio settings. Different content is a replacement operation, not a relink. Finalize never silently drops missing frames.

## Export and CLI package jobs

- `POST /projects/:projectId/exports`: MP4 job with `expectedRevision`, display `fileName` and UUID `Idempotency-Key`.
- `GET /projects/:projectId/cli-estimate`: raw-frame reference size and staging note. PNG/ZIP actual size depends on image content; this is not a promised compressed size.
- `POST /projects/:projectId/cli-packages`: same revision/idempotency contract; `fileName` defaults to `frames-cli.zip`. Uses the same single global export lock and immutable source snapshot as MP4.
- Job status/SSE, cancellation and completed result/download routes are shared. CLI results have `application/zip`; the frontend offers a ZIP download instead of a video player.

CLI staging contains composed PNGs, optional unchanged audio, a hash manifest, README and Windows `encode.cmd`. Paths in the script are fixed package-relative names; original source names are never executed. The script expects a compatible FFmpeg on PATH on the separate machine where this exported package is encoded. This requirement concerns independent CLI encoding only; the main portable app uses its bundled engine.

The builder reserves workspace space for both staging and ZIP and expands reservations in batches. Interrupted/canceled/failed jobs clean their staging; completed results remain behind reader/deletion gates. Real archive extraction/CRC and Windows script execution are integration gates, separate from prepared-frame/command tests.

## Preview scheduling

Frame render, audio proxy and thumbnails share one native-work scheduler with MP4/CLI preparation. At most 64 tasks wait; at most one native task runs. An export lease pauses queued preview work until that export completes or cancels. An already-running preview finishes or cancels before the next task enters the native worker.

Preview service admission includes concurrent metadata loads and pending tasks (64 total). Duplicate pending render keys at the same revision share a request ID only within the same client/sequence/intent owner (or legacy unscoped harness). Terminal request metadata is pruned when the map reaches 2,048 entries; clients must handle expired IDs. Shutdown closes admission, waits metadata loads and native cleanup before releasing the workspace. Preview/thumbnail/audio share RAM/disk LRU budgets (128 MiB / 1 GiB by default), at most 4,096 entries, and reader leases. Native cache hits bypass the paused generation queue. Scoped seek replacement and independent audio cancellation are wired through services/routes/frontend source; actual HTTP/browser runtime validation remains unfinished.

The shared `previewRequestSchema` accepts paired UUID `clientId` and positive safe-integer `sequence`, plus `intent` (`seek` default / `prefetch`). Prefetch requires scoped ownership and cannot request output-check. A sequence groups ordinary playback and speculative lookahead; manual seek or project/revision/stop advances it. Registration happens before metadata I/O, so delayed older requests cannot supersede newer input. Native priority puts seek ahead of queued prefetch/thumbnail; newer sequences abort old queued/running work, retaining source leases until native cleanup settles.

- `POST /projects/:projectId/previews/cancel`: `previewCancelSchema` (`clientId,sequence`), returns 204. Cancels that sequence and older work; an old cancellation cannot affect a newer sequence. Cancellation tombstones prevent delayed request resurrection while retained.
- `POST /projects/:projectId/audio-preview`: `audioPreviewRequestSchema` (`revision` and optional paired client/sequence). Uses a separate lifecycle channel from image selection.
- `POST /projects/:projectId/audio-preview/cancel`: same cancellation schema and 204 semantics for audio only. Client cleanup on revision/project/unmount cancels stale proxy generation; frame scrubbing preserves valid audio generation.

The registry holds at most 1,024 views per channel, expires inactive unreferenced views after 30 minutes, and keeps active refs across expiry. At most 64 scoped registrations can wait for the event-loop admission step, separately from the 64 metadata/native pending tasks. This step lets canceled queued work settle before its replacement needs a slot. No unbounded per-tab history or queue is retained.

Media responses serve either cached Buffer ranges or filesystem streams. A file reader lease remains held until the ReadStream closes, including after client disconnect; result deletion/clear cannot race an open file on Windows. `410 PREVIEW_EXPIRED` means LRU or cleanup removed a ready request's media: submit a fresh preview request. The browser downloads PNG to an owned Blob URL so server eviction cannot invalidate an already-loaded image; URLs are revoked on LRU/project/revision/stop/unmount. Browser behavior still needs runtime integration evidence.

## Portable configuration and projects

- `GET /projects/:projectId`: rechecks managed source availability when no export owns the project. Missing/edited sources become missing; repaired identical source content can become valid again. Revision only changes if source state changes.
- `GET /projects/:projectId/config`: download `project.ftvs.json`, validated by `projectConfigSchema`. The wrapper identifies the format/schema, carries Project settings/order and source SHA-256 identities. It contains no media binaries or executable commands.
- `POST /projects/import-config`: validate that wrapper and create a new project. Asset IDs from the file are not trusted for access. Available content is resolved by verified hash within this workspace; unavailable content is marked missing, preserving order/settings for relink. Relative source paths are validated as metadata.
- `PATCH /projects/:projectId`: name, render settings, ordering/removal and audio controls at expected revision. Audio source identity/integrity metadata cannot be forged through the volume/policy form.
- `DELETE /projects/:projectId`: `{expectedRevision,confirm:true}`. Refuses active exports, open imports and active output readers. Commits by renaming to an internal trash tombstone, removes project jobs/results and collects unused managed copies. Startup completes interrupted trash cleanup.

Export/import config is not a full backup. A full portable backup includes `data/` and its managed sources, taken while the backend is stopped.

## Storage lifecycle

- `GET /storage`: informational usage/quota/reservation/free-disk values, workspace location and `cache` entry/readers/RAM/disk bytes and configured limits. Remains available when new writes would be rejected, so cleanup is still accessible.
- `POST /storage/collect-garbage`: removes only managed asset copies with no references from current project, last-good project backup, job snapshot, open import or active reader/render lease. Corrupt authoritative metadata prevents GC instead of granting permission to delete.
- `POST /storage/clear-cache`: closes preview admission, waits generation, deletes only owned cache media and reopens admission. Returns 409 `PREVIEW_CACHE_BUSY` before deletion if a response is reading cache or paused queued work must wait for an active export. Unrelated files are preserved.

Deletion never targets original browser-selected file paths or browser download copies. Reader leases gate deletion of results while streamed, and project deletion prevents new result readers from entering during removal.

## Persisted metadata and recovery errors

Shared `exportJobSchema` defines the runtime status DTO and inferred TypeScript type. Disk-only `storage/manifests.ts` validates registry assets/imports/operation indexes with semantic checks and preserves filesystem errors separately from corruption. Startup preflights records/indexes before cleanup, validates job snapshot identity/revision/count, and rejects redirected folder IDs.

`CORRUPT_REGISTRY`, `CORRUPT_IMPORT`, `CORRUPT_IMPORT_INDEX`, `CORRUPT_JOB`, `CORRUPT_JOB_INDEX`, `CORRUPT_JOB_SNAPSHOT`, and `CORRUPT_PROJECT` identify unreadable/inconsistent durable state. A valid backup is restored atomically; missing primary plus invalid backup is not treated as empty data. Unrecoverable import corruption preserves its directory, partial bytes and source media and stops startup; it no longer recursively deletes unknown import state. Startup diagnostics expose failures before HTTP readiness. New records publish through private metadata staging with immutable creation intent; startup discards only unpublished known metadata, restores missing import/export idempotency bindings and keeps recovered jobs interrupted. Legacy incomplete UUID records remain errors. Actual process-kill/Windows fault validation remains release work.

Publication order is private `.creating-UUID` metadata → complete UUID directory → operation index → response/side effects. An interrupted index write can be reconstructed from `creation.json`; retry returns the same import/job. Conflicting identity/hash, unknown staging contents, or index references into private staging return `CORRUPT_CREATION` without guessing a binding or deleting user media. Project deletion tombstones prevent stale job intents from restoring removed indexes.

Startup also cleans owned atomic-update temp files only after durable metadata validates; absent optional registries retain the only candidate bytes. Cleanup never runs in a normal project GET against an active writer. These are internal persistence rules; request/response formats are unchanged.

A committed project's `lastImportId` can repair an old open upload checkpoint to finalized. Its per-file progress may be older than the committed project; repeated finalize returns the project and does not republish. Metadata/schema validity alone is not evidence of successful FFprobe verification or the Windows artifact gates.

## Evidence scope

Service tests exercise project transfer/relink, quotas, registry lifetime, import cancellation/retry/recovery and real local media encoding. HTTP routes, multipart parser integration, browser UI and Windows launcher still require full dependency installation and their own integration gates; service tests do not prove those layers.
