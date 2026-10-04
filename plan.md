# PARALLAX Tablelight — Stage 1 delivery plan

## Goal and scope

Deliver only the Tablekeeper Stage 1 API in `stage-1/`, matching the complete official Stage 1 specification. The service must build and start from a clean checkout, listen on `0.0.0.0` at `PORT` (default `8080`), run in one container without runtime outbound access, and include `Dockerfile` and `RUN.md`. Do not add browser UI or later-stage behavior.

## Ownership and boundaries

| Owner | Files / responsibility | Completion evidence |
|---|---|---|
| Planner | `stage-1/src/domain/**`: restaurant-local time and DST conversion, availability, reservation validation and occupancy, cancellation/amendment, all-or-nothing moves | Unit-level edge probes for gap/fold resolution and half-open intervals; integrated HTTP checks for conflicts and atomic move behavior |
| Implementer | `stage-1/src/http/**`, `stage-1/src/state/**`, `stage-1/Dockerfile`, `stage-1/RUN.md`, package metadata: HTTP routing/errors/authentication, fixture handling, idempotency, export/import, deployment | Clean Docker build and isolated HTTP checks for status/error behavior, auth, replay/concurrency, and import/export |
| Reviewer | Independent full-contract review of the integrated revision; no overlapping implementation edits | Evidence-backed findings with paths/lines and spec clauses, sent directly to the author and Planner; focused re-review after any material correction |
| Planner + Implementer | Agree on the canonical state/domain interface before edits; keep implementation paths disjoint | Shared interface: canonical arrays for users, restaurants, reservations, tokens and idempotency receipts; millisecond epochs for occupancy |

## Dependencies and integration

1. Read the complete official Stage 1 specification before implementation or review; use it as the acceptance contract.
2. Confirm all seats use the selected host checkout. Planner owns domain files; Implementer owns HTTP/state/deployment files.
3. Integrate the disjoint modules through the shared state shape. Serialize writes around idempotency lookup, domain mutation and receipt persistence so concurrent retries and conflicts remain atomic.
4. Have Reviewer inspect the integrated revision against every requirement; send material defects to the owner and re-review corrected behavior.
5. Build and run the service in a clean Docker container with outbound networking disabled. Exercise the written contract, not only any partial event harness.
6. Commit the verified Stage 1 result with traceable history. Keep pre-existing root README changes untouched and stop before Stage 2.

## Acceptance evidence

- Docker builds from `stage-1/`; `RUN.md` starts the image with `PORT`; `/health` becomes healthy within 60 seconds.
- Auth, fixture reset, public reads, bookings, cancellation/amendment, idempotency, moves, and export/import satisfy the stated status codes, error bodies, ownership rules and preservation requirements.
- Concurrent conflicting writes cannot double-book; identical unused-key requests have one `201` and successful `200` replays; failed moves/imports leave state unchanged.
- Berlin and New York spring gaps and fall folds follow the specified offsets and absolute-duration rules; adjacent half-open intervals do not conflict.
- Reviewer findings, corrections, exact check commands/results, remaining gaps, and commit are recorded in the coordinator report.

## Main risks and assumptions

- The prepared kickoff checkout and event harness are absent from this repository; the official specification is retrieved from its supplied primary URL. Treat any harness as partial evidence if later found.
- Concurrent writes must share one serialization boundary, including successful receipt persistence.
- Import validation must fully validate a replacement before atomically swapping it in, while preserving valid exported identities and credentials.
- The container's `--network none` mode prevents host-side port access in this Docker environment; use container-loopback HTTP probes for isolated runtime checks.
