# Parallax Tablelight — Stage 4

From the repository root, build and start the Stage 4 API and browser experience in one container:

```sh
docker build -t parallax-tablelight-stage-4 ./stage-4
docker run --rm -p 8080:8080 -e PORT=8080 parallax-tablelight-stage-4
```

The service listens on `0.0.0.0` and needs no external service or runtime network access. Check readiness with `GET /health`.
Open `http://localhost:8080/` to search for a table. Signup, login and reservation lookup are available at `/signup`, `/login` and `/lookup`.

Stage 4 starts with a synthetic `Tablelight Demo Bistro` and sample tables so the browser experience is populated immediately. Reservations and accounts live in memory and reset when the process restarts.

The Docker image enables `TABLELIGHT_ENABLE_TEST_ENDPOINTS` for the isolated harness. Do not expose that image publicly without setting `TABLELIGHT_ENABLE_TEST_ENDPOINTS=false`. A public Node deployment leaves the test reset, export and import routes disabled by default.
