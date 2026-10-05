# Tablelight — PARALLAX

PARALLAX's completed entry for the `tablekeeper` track of the WeAreDevelopers x BAND Dark Factory hackathon.

**Tablelight** is a restaurant reservation app built to help diners find an available table and book with confidence. The project implements all four stages of the official Tablekeeper specification.

## Project stages

The repository contains four complete, independently buildable services. Each stage carries forward the earlier stages' behavior, and **Stage 4 is the final Tablelight app**.

- `stage-1/` — reservation API and core booking behavior.
- `stage-2/` — browser reservation experience and combined-table bookings.
- `stage-3/` — effective-dated policies, reservation history, and recurring reservations.
- `stage-4/` — final app, including closure replanning and recurring-series amendments.

## Run a stage

Each stage is a complete, independently buildable service. From the repository root, build and run the stage you want to inspect. Run one stage at a time; each uses port 8080.

### Stage 1

```sh
docker build -t tablelight-stage-1 ./stage-1
docker run --rm -p 8080:8080 -e PORT=8080 tablelight-stage-1
```

### Stage 2

```sh
docker build -t parallax-tablelight-stage-2 ./stage-2
docker run --rm -p 8080:8080 -e PORT=8080 parallax-tablelight-stage-2
```

### Stage 3

```sh
docker build -t parallax-tablelight-stage-3 ./stage-3
docker run --rm -p 8080:8080 -e PORT=8080 parallax-tablelight-stage-3
```

### Stage 4 — final Tablelight app

```sh
docker build -t parallax-tablelight-stage-4 ./stage-4
docker run --rm -p 8080:8080 -e PORT=8080 parallax-tablelight-stage-4
```

For Stages 2–4, open [http://localhost:8080/](http://localhost:8080/) in a browser. Stage 1 is API-only. Each stage's `RUN.md` has its build and start instructions; see the [Stage 4 run guide](stage-4/RUN.md) for the final app.

## Repository guide

- `FACTORY.md`, `mandates/`, and `room.json` document the reusable agent factory and the BAND room run that produced the project.
- The official [Tablekeeper stage specifications](https://github.com/band-ai/dark-factory-wearedevs/tree/main/tablekeeper/spec) define the requirements. See the [participant guide](https://github.com/band-ai/dark-factory-wearedevs/blob/main/docs/participant-guide.md) for event rules and submission details.
