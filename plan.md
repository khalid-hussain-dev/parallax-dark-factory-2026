# PARALLAX Tablelight — Stage 2 delivery plan

## Goal and scope

Carry the complete Stage 1 service forward into `stage-2/` and add the required browser reservation experience and approved pair-table bookings. Stage 1 remains intact; no Stage 3 or Stage 4 work. The two full official specifications are the contract. The service must build and run in one container on `0.0.0.0:$PORT` (default 8080) without runtime outbound networking.

## Ownership and boundaries

| Owner | Files / responsibility | Acceptance evidence |
|---|---|---|
| Planner | `stage-2/src/domain/**`, `stage-2/src/state/**`: carry forward and extend domain/state for `combinable` pairs, set-based occupancy/capacity, combined seed/import validation, single and combined API invariants | Stage 1 regression checks; options ordering/capacity/conflicts; pair restrictions, atomic amendments/moves/cancellation, Stage 1 export import and timestamps/credentials/receipts preserved |
| Implementer | `stage-2/src/http/**`, `stage-2/src/ui/**`, static assets, `stage-2/Dockerfile`, `stage-2/RUN.md`, package metadata: carry forward API routing and add HTML routes/browser interactions, authentication/lookup/booking/cancel, responsive visual system, async search and uncertain idempotent recovery | Browser checks at 375px and desktop, required routes/test IDs and flows; competing search/booking outcomes; combined options; clean isolated Docker runtime |
| Reviewer | Independent reading of both complete specs and adversarial review of integrated `stage-2/`; run independent browser/API/container checks | Evidence-backed findings sent directly to author and Planner, exact revision and commands/results; focused re-review of fixes |

Shared interface: preserve Stage 1 state keys and domain semantics. Reservation records carry canonical `table_ids` arrays; single-table records keep the Stage 1 `table_id` compatibility field in public responses. Occupancy checks consider every member table. HTTP/server writes, idempotency receipt resolution and mutations remain serialized. Browser assets call only the service API; pending booking body/key remains in page memory across export/import.

## Dependencies and integration

1. Both seats use the selected shared checkout. Stage 2 begins from the complete `stage-1/` service; all implementation changes stay in `stage-2/`.
2. Planner extends the copied domain/state modules first and sends the exact exported API/state shape to Implementer. Implementer integrates routes and UI without editing domain/state modules.
3. Preserve existing Stage 1 request behavior, statuses and import compatibility while accepting Stage 2 combined-table exports and seeds.
4. Reviewer audits both full specs, the integrated revision and runnable behaviors; fix only evidenced defects.
5. Build a fresh image and exercise it under `--network none`; run the official Stage 2 harness from the kickoff checkout in isolated mode using a new output directory.
6. Commit the complete reviewed Stage 2 result with traceable history and leave the pre-existing root README modification untouched.

## Highest-risk cases

- Out-of-order search responses must not overwrite a newer query; conflict refreshes must preserve the attempted form.
- Lost booking responses retry the identical body and idempotency key and never show speculative confirmation.
- Combined occupancy, capacity, allowed pairs, ordering, and atomic moves must hold for concurrent requests and every read.
- Export/import must preserve Stage 1 credentials/tokens, records, receipts and pending browser retry identity across upgrade.
- Responsive UI must expose every required test ID, readable labels, visible keyboard focus, adequate contrast and no horizontal scrolling at 375px.

## Completion evidence

- `stage-2/Dockerfile` builds from a clean checkout; `RUN.md` starts a single network-isolated-capable container using `PORT`; `/health` and all required API and browser routes work.
- Reviewer accepts the integrated revision; material findings have a verified correction or are reported as a blocker.
- Exact Docker, browser/API probe and official harness commands and outputs are recorded. No harness pass is inferred from partial checks.
- Commit, seat contributions, handoffs, elapsed time and exposed usage data, limitations and remaining gaps are reported.
