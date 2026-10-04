# Parallax Tablelight — Stage 3

From the repository root, build and start the Stage 3 API and browser experience in one container:

```sh
docker build -t parallax-tablelight-stage-3 ./stage-3
docker run --rm -p 8080:8080 -e PORT=8080 parallax-tablelight-stage-3
```

The service listens on `0.0.0.0` and needs no external service or runtime network access. Check readiness with `GET /health`.
Open `http://localhost:8080/` to search for a table. Signup, login and reservation lookup are available at `/signup`, `/login` and `/lookup`.
