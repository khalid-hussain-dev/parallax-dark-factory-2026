# PARALLAX Factory

## Purpose

PARALLAX is a three-seat BAND Desktop software factory used to build Tablelight for the `tablekeeper` track. Tablelight is a restaurant reservation service focused on accurate availability and dependable booking under retries, concurrent requests, time zones, policy changes, combined tables, and recurring reservations.

The factory is organized around the event's staged specifications. Each stage is a complete, separately buildable service in its own folder. Later stages carry forward and extend earlier work; earlier stage folders remain intact.

## Seats and setup

The submitted room uses three distinct seats:

| Seat | Harness | Model | Main responsibility |
|---|---|---|---|
| Planner | Codex | gpt-6-luna | Reads the full task/specifications, creates a bounded plan, owns a substantive domain/state implementation slice, coordinates integration, validation and reporting. |
| Implementer | Codex | gpt-6-luna | Owns a separate implementation slice, including HTTP integration, browser experience where required, and stage-specific Docker/run documentation. |
| Reviewer | Codex | gpt-6-luna | Independently checks the complete requirements and integrated revision, reports evidence-backed defects, and rechecks material fixes against the exact final commit. |

The reusable role instructions are stored under `mandates/`, one generic file per room seat. They describe how each role works and handoffs; track-specific requirements belong in the dispatched stage task and official specifications.

The factory runs in Ubuntu under WSL2. The prepared environment uses Python 3.14.4, Git 2.53.0, Docker CLI/daemon 29.4.3, and a Python virtual environment at `~/.venvs/dark-factory`. The event harness is run from the separate kickoff checkout:

`/mnt/i/Hackathons/LabLabAI/WeAreDevelopers X Band AI/dark-factory-wearedevs`

The result repository is:

`/mnt/i/Hackathons/LabLabAI/WeAreDevelopers X Band AI/parallax-dark-factory-2026`

Keeping the kickoff checkout and result repository separate prevents challenge inputs and harness files from becoming part of the submitted implementation. All stage services are designed to build as one-container Docker services, listen on `0.0.0.0` using `PORT` (default 8080), and work without outbound network access at runtime.

## How the factory works

I (Khalid Hussain) dispatch one complete stage task to the Planner in the same BAND room. The Planner reads the complete official specifications, posts a bounded plan, and assigns distinct work to the Planner and Implementer. The Reviewer independently audits the full requirements and integrated work. Seats communicate through direct `@handle` handoffs that state the revision, files, decisions, checks, and remaining gaps. Material findings are fixed by the owning seat and rechecked. The Planner integrates the work, preserves the commit history, runs cumulative validation, and reports the final revision and evidence.

For the submitted sequence, the same BAND room and result repository were continued across Stages 1-4. Each dispatched stage task was the only human input to BAND until that stage's coordinator report. The stage folders and commits are:

| Stage | Final reported commit | Main addition |
|---|---|---|
| 1 | `6f2ffdf846f5a67533ec0216a344e6bebee204b8` | Reservation API, authentication, idempotent operations, atomic moves, and import/export. |
| 2 | `f74347d44a020e23e99f01846660102ca182c0f6` | Browser reservation experience and combined-table bookings. |
| 3 | `b9ad790b65306ef060aff20cba4c9e108c4bc99a` | Effective-dated policies, accepted terms, revision-aware reservation history, explanations, and recurring reservations. |
| 4 | `218c6ca7240de8bb5c554a776e0921bcb8064f31` | Deterministic closure replanning and recurring-series amendments. |

After the Stage 4 feature work, the BAND team completed a UI polish follow-up in the same room. Final UI revision: `dade94e15b9b8e24d3bd6865ea9c1bb5cb7640f6`. It changed only `stage-4/src/ui/app.css` and `stage-4/src/ui/app.js`; Stage 1–3 and Stage 4 domain/state/API, package, and deployment files were unchanged. The update applied the Luminous Night styling and final supplied logo assets, added request-bound semantic loading indicators, and made table selection and reservation feedback more visibly illuminated. The exact follow-up commit was independently reviewed in headless Chromium at desktop and narrow mobile sizes. The user also manually opened the updated service and confirmed the refreshed UI, logo, and favicon. In ordinary use, requests complete quickly enough that loading indicators can be brief; no artificial request delay was added.

Each stage has its own service directory and run/build files. Stage 2 extends Stage 1; Stage 3 extends Stage 2; Stage 4 extends Stage 3. The committed history is kept intact so the room discussion and code revisions can be compared.

## Design choices and tradeoffs

- **Specification-led delivery:** The official stage specifications define behavior. Prompt summaries call attention to difficult areas but explicitly do not replace the full contracts. Delegated assignments and reviews carry the complete relevant task and specifications.
- **One repository and room across stages:** This preserves the chain of collaboration and lets each stage build on the prior stage while keeping each completed service in a distinct folder.
- **Separate complete services:** Every stage folder contains its own service, Dockerfile, and `RUN.md`. This costs some duplication, but lets judges build and assess each claimed stage independently and prevents a later-stage implementation from replacing an earlier-stage result.
- **Bounded deterministic Stage 4 planning:** The closure planner supports the specification's small limits and optimizes the required lexicographic objective. Exhaustive bounded search was chosen so the result can be checked against the exact objective rather than relying on a greedy assignment.
- **Review and evidence over activity:** Reviewers report only material, reproducible findings. Correct work is accepted without manufactured disagreement; actual review findings lead to fixes and exact-revision checks.
- **No speculative scope:** The factory implements the requested API and UI behavior and avoids adding unsupported services or endpoints.

## Example of finding and recovering from a defect

During Stage 4 review, the Reviewer found that a successful standalone booking did not increment the restaurant revision. That could let a previously previewed closure plan remain valid after the booking changed the restaurant's state. The Planner fixed the revision accounting in commit `218c6ca7240de8bb5c554a776e0921bcb8064f31`: a standalone booking increments the restaurant revision once, while atomic series creation increments it once for the overall operation. The Reviewer independently reproduced the sequence on the exact corrected commit: preview a plan, create a booking, then apply the old plan; application returned `409 stale_plan`. The corrected commit then passed the cumulative isolated harness.

Earlier reviews also produced concrete corrections, including fresh reservation lookup retrieving table labels from restaurant detail, validation of imported idempotency receipts and their request/response consistency, and preserving stale-revision error precedence for reservation changes. Each reported correction was followed by focused checks and cumulative validation on the updated revision.

## Validation and evidence

The cumulative isolated harness run for the Stage 4 feature revision, commit `218c6ca7240de8bb5c554a776e0921bcb8064f31`, reported:

| Suite | Result |
|---|---:|
| Stage 1 | 120/120 passed |
| Stage 2 | 25/25 passed |
| Stage 3 | 7/7 passed |
| Stage 4 | 6/6 passed |

The run claimed Stage 4. The final Stage 4 image also passed a no-cache Docker build and no-egress API checks for preview/apply, stale-plan handling, series amendments, replay, import/export, and revision accounting. The cumulative harness includes Stage 2's 17/17 browser checks.

After the UI polish follow-up at `dade94e15b9b8e24d3bd6865ea9c1bb5cb7640f6`, the project owner repeated the full cumulative isolated harness and repeated the UI walkthrough. The post-UI harness again reported Stage 1 120/120, Stage 2 25/25, Stage 3 7/7, and Stage 4 6/6, claiming Stage 4. This owner-run verification happened after the BAND review described below; the room log's statement that the Reviewer did not run a fresh cumulative harness or Docker build refers to the Reviewer's own follow-up work, not the owner's later rerun.

These harness suites are partial and directional; passing the shipped checks does not guarantee passing the full judging suites. Focused probes add evidence but do not exhaust every optimizer tie case, concurrency interleaving, rollback path, or malformed imported-record shape.

### UI polish follow-up evidence

Reviewer independently checked exact UI revision `dade94e15b9b8e24d3bd6865ea9c1bb5cb7640f6` in headless Chromium 1228 at 1440×960 and 375×812. The selected table remained visibly selected with amber fill, border, and localized glow; neither viewport had horizontal overflow. Reduced-motion mode suppressed the selected-table animation, including while hovered. The reviewer observed request-bound pending states for initial loading, signup, login, availability search, booking, lookup, cancellation, and logout; double activation produced only one booking request, and a simulated `409` cleared the pending state while retaining the booking form and showing the error. Sampled authentication, booking, lookup, and cancellation controls retained focus; search-button focus retention was not confirmed.

The measured pending intervals were approximately 50–183 ms for most actions, so the indicators may be too brief to notice when the local service responds quickly. A two-frame paint opportunity was added before requests, but no arbitrary network delay is imposed. The Reviewer reported JavaScript syntax, commit/diff checks and unchanged Stage 1–3. The Reviewer's own follow-up did not include a fresh Docker build or cumulative harness run; after that review, the project owner repeated the full cumulative harness and UI walkthrough as recorded above.
## Manual RUN.md and browser walkthrough

I followed each stage folder's `RUN.md` by hand. Stages 1-4 each built and started in a one-container Docker run, and `GET /health` returned `{"status":"ok"}`. Stage 1 is API-only, so it has no browser interface.

For the Stage 2 browser flow, I loaded the documented test fixture, signed in as the seeded test user, searched availability for a party of five, booked a suitable table, looked up the confirmed reservation by reference, cancelled it, and refreshed availability. The cancelled booking was shown as cancelled and its table was available again.

Stage 3 intentionally retains the Stage 2 screens; its specification requires no new screens for policy explanations or reservation history. I checked the inherited browser app and manually queried `GET /availability` with `explain=true`. The response included all eight slots, all three fixture tables, `policy_version: 0`, and both capacity and no-overlap rules for each table. All tables were available for a party of two with no reservations in the fixture.

For Stage 4, I searched for a party of two, booked Table 1 at 18:00, looked up the confirmation, and cancelled it. A refreshed availability query marked Table 1 unavailable at 18:00, 18:30, and 19:00, then available again at 19:30, matching the 90-minute booking duration. The lookup showed the booking as confirmed before cancellation and cancelled afterward.

## Time and usage

BAND now displays an estimated $6.81 for the main Tablelight room. The previously recorded setup/connectivity-test room estimates are $0.07 and $0.01. Taken together, those room-header estimates total $6.89. The agent cards separately show $1.92 for Reviewer, $2.02 for Implementer, and $2.94 for Planner ($6.88 combined). These figures do not reconcile, and their accounting scopes are unclear, so keep the room-header and agent-card estimates separate. The Stage 4 feature-revision harness run was reported at approximately 76.7 seconds; this is test runtime, not development time. No total hands-on duration across all stages or UI follow-up was measured.

## Evidence boundaries

- The shipped harness covers only a portion of the full contracts. Passing it is strong evidence for the published cases, but it cannot establish how every unpublished judging case will behave.
- The BAND cost figures are estimates. The current main Tablelight room header shows $6.81; the previously recorded setup/connectivity-test amounts are $0.07 and $0.01. The separate agent-card figures total $6.88 and do not reconcile with the $6.81 main-room figure; no accounting explanation is available. No total hands-on time across all stages or the UI follow-up was measured.

The public submission includes the BAND room export as `room.json`, along with the generic seat mandates and completed stage folders. Before committing, a bearer-like sample authorization value in one test message was redacted from the room export during credential review. Keep the Git history intact so the room's work remains traceable to its commits.
