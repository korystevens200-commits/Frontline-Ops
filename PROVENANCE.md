# Provenance

Phase 1 of Frontline Ops (the command center) was built in
[`korystevens200-commits/lockedinleads-site`](https://github.com/korystevens200-commits/lockedinleads-site),
under `app/`, alongside the unrelated LockedinLeads marketing site. It was moved
here with its history intact.

## How it was moved

From `lockedinleads-site` at `main` = `f6b2770fe2553ed6b5b47108ac8474144e76ff31`:

```bash
git filter-repo --path app/ --path .github/workflows/deploy.yml
```

- Only `app/` and `.github/workflows/deploy.yml` came across. The marketing site
  (`index.html`, `terms.html`, `privacy.html`, `static/`) stays where it was — it
  is a separate public GitHub Pages deploy and the A2P opt-in evidence page.
- Paths are unchanged, so `cd app`, the Dockerfile, `fly.toml` and the deploy
  workflow's `working-directory: app` all work without edits.
- Authors, dates and messages are preserved. Commit ids changed, which extracting
  a subdirectory always does. All 43 files are blob-identical to the source, and
  the Phase 1 test suite (19 tests) passes on the moved tree.

## Where the history came from

"Pull request #N" in a merge message refers to
`https://github.com/korystevens200-commits/lockedinleads-site/pull/N`.

| Here | In lockedinleads-site | Commit |
|---|---|---|
| `7c4b2da` | `2f147d1` | Add Frontline Ops command center (Phase 1) |
| `053660c` | `e8ef8ba` | Restructure Today around the call loop; verify the production image |
| `3650fc8` | `9e2a4e7` | Add a browser-run deploy so no laptop is needed |
| `8f0ee6b` | `c8276cc` | Merge pull request #2 |
| `f3b5f7e` | `205d778` | Use Managed Postgres; unmanaged Fly Postgres is being retired |
| `43f8113` | `e426ffb` | Merge pull request #3 |
| `759966b` | `4d6e3ea` | Correct the Managed Postgres invocation from flyctl's own help |
| `84f0b47` | `a4cf7c8` | Merge pull request #4 |
| `58ec989` | `447e79d` | Name the org on every mpg list, and capture the cluster id at creation |
| `84cce03` | `895c9cd` | Merge pull request #5 |
| `0516259` | `a5e75e3` | Move the app out of the deprecated mia region |
| `08425cc` | `f6b2770` | Merge pull request #6 |

Pull request #1's merge (`0c6aef3`) has no counterpart: its other parent only
touched the marketing site, so once that was filtered out the merge carried no
change of its own and was dropped. Its two commits are the first two rows above.

## Cutting over

The live Fly app (`frontline-ops`) and its database are unchanged by the move.
To deploy from this repository instead of the old one:

1. Add the repository secrets here (Settings → Secrets and variables → Actions):
   `FLY_API_TOKEN` and `APP_PASSWORD`. Secrets cannot be copied between
   repositories — they have to be entered again.
2. Actions → Deploy to Fly → Run workflow. It is idempotent: same app, same
   database, the existing `SESSION_SECRET` is kept, and nobody is signed out.
3. In `lockedinleads-site`, disable its Deploy to Fly workflow so two
   repositories cannot deploy the same app.
