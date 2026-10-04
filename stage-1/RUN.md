# Tablelight Stage 1

From the repository root, build and start the API in one container:

```sh
docker build -t tablelight-stage-1 ./stage-1
docker run --rm -p 8080:8080 -e PORT=8080 tablelight-stage-1
```

The service listens on `0.0.0.0` and needs no external service or runtime network access. Check readiness with `GET /health`.
