# Verification evidence scope

`linux-core.tap` records the actual Node test output from direct terminal execution with the explicit local FFmpeg/FFprobe wrappers. The latest run has 76 passed cases, no failures and no skips. It includes real Linux media encoding and source/project lifecycle tests; it is not evidence for all AC-01…AC-26, HTTP routes, browser playback or Windows execution.

`linux-core-typecheck.txt` is empty on success. The direct terminal compiler command exited 0 with strict/noUncheckedIndexedAccess over the tests' TypeScript dependency graph plus previews, config, launcher-control and frontend API utility. `latest-core.json` records that scope, versions and source digest. Full project semantic typechecking is a separate gate.

`full-typecheck-unavailable.txt` retains unresolved Fastify/frontend/build dependencies and their contextual typing errors. No fake declarations or replacement server were used to make this pass. Registry DNS is unavailable in this environment, so dependency installation and a reproducible lockfile are still incomplete.

`script-core.json` and `script-core-initial-failure.json` are failed tooling runs, not passing product-test results. The sandbox denies spawnSync; it may return a status of 0 alongside an EPERM error. The helper now treats that as failure, requires real TAP output and writes to separate `script-core.*` files so it cannot overwrite direct-terminal evidence.

No Windows machine, Go compilation, Windows binary checksum verification, portable ZIP or clean-machine/offline release validation has been proven. Those gates remain open regardless of the passing Linux core tests.

`cli-zip-integration-unavailable.tap` records a failed required integration run: the actual ZIP extractor dependency `yauzl` is not installed while registry DNS remains unavailable. Prepared PNG/manifest/command tests and an independent ZIP64 envelope fixture do not prove real Archiver ZIP generation, CRC/extraction, or Windows CMD execution. These gates remain open.

Cache evidence includes RAM/disk LRU budgets, zero-tier configurations, reader protection, competing producers, canceled/oversized/invalidated generation, quota cleanup and restart. Media-response tests cover file/Buffer Range and source-close leases. Real audio proxy tests decode generated AAC and compare duration/RMS for pad/loop and one application of volume. Blob URL/browser lifetime and actual HTTP client disconnect still require browser/HTTP integration; service tests alone do not prove them.

Scoped preview evidence includes delayed metadata and reordered sequence rejection, independent tab/project cancellation, seek priority, 64-item speculative queue replacement, bounded registration bursts, view TTL/lease protection, schemas and audio/frame channel separation. Frontend preserves playback state during buffered manual seek and sends cleanup cancellation, but that source has not yet been validated by a running browser. No service result is a browser seek-resume/timing pass.

Durable-state tests now cover semantic import backup restoration, preservation on unrecoverable corruption, missing-primary/invalid-backup distinction, folder identity recovery, ID/path/byte/completion schemas, job snapshot preflight, dangling indexes and replay of a committed project from an older incomplete upload checkpoint. These are controlled file fault injections on Linux, not evidence for Windows rename/sharing/crash behavior or arbitrary legacy orphan repair.

Creation tests cover staged directory publication, failure/collision ownership, private-stage cleanup, unknown/indexed stages, project restart and lock release, import/export index reconstruction with stable retry identity, interrupted export without engine execution, deletion tombstones and guarded atomic-temp cleanup. These tests construct real filesystem states for interrupted windows; they are not actual process-kill/power-loss or Windows rename/sharing tests. Newly created records are protected by staged publication; incomplete legacy UUID records remain preserved errors.

Pause checkpoint: the latest 76-pass report predates changes to `apps/web/src/features/export/submission.ts`, `CliExportButton.tsx`, and `main.tsx`. The new submission helper passed a standalone strict TypeScript check only. No submission tests/full UI build/browser validation have run for those changes; see `../HANDOFF.md`. The historical sourceDigest is intentionally not overwritten with the unverified worktree digest.
