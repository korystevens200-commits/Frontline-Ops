# Frontline Ops

Internal operations for Frontline Ops: the command center two operators dial
prospects from, track the pipeline in, and run client delivery out of.

Everything lives in [`app/`](app/) — start with [`app/README.md`](app/README.md)
for setup, tests, deploying to Fly.io, and the data model.

```
app/                         the command center (Node 22 + Fastify + Postgres)
.github/workflows/deploy.yml browser-run deploy to Fly.io (Actions → Deploy to Fly)
```

This repository is the home of the project from Phase 2 onward. Phase 1 was
built inside another repository and moved here with its history intact — see
[PROVENANCE.md](PROVENANCE.md).
