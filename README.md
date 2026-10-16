# Linkguard

A free GitHub Action that finds outbound links in a Jekyll, Hugo or folderblog site, checks whether they still work, and looks up (or creates) Internet Archive Wayback Machine snapshots. When a link is dead and an archived copy exists, Linkguard reports the archived URL and can open a pull request that swaps it in.

Report-only by default. No account needed for lookups. No telemetry.

## Quick start

```yaml
# .github/workflows/linkguard.yml
name: Linkguard
on:
  schedule:
    - cron: '17 6 * * 1' # weekly
  workflow_dispatch:
permissions:
  contents: read
jobs:
  links:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: ninepointlabs/linkguard@v0.1.1
```

`@v0.1.1` pins this exact release. `@v0` moves to the newest v0.x release.

Results show up in the run's job summary as a table (URL, status, files:lines, archived URL, action taken), as warning annotations on the source lines of dead links, and as JSON and markdown report files.

Complete examples: [Jekyll](examples/jekyll.yml), [Hugo](examples/hugo.yml), [folderblog](examples/folderblog.yml).

## What it does

1. **Finds files.** `site-type: auto` looks at the repo root: `hugo.toml` (or `config.toml` plus `content/`) means Hugo, `_config.yml` means Jekyll, year folders plus `.nojekyll` or `feed.xml` mean folderblog. Default globs:

   | site-type | default `paths` |
   | --- | --- |
   | `jekyll` | `_posts/**/*.{md,markdown,html}`, `_pages/**/*.{md,markdown,html}`, `*.{md,markdown}` |
   | `hugo` | `content/**/*.{md,markdown,html}` |
   | `folderblog` | `[0-9][0-9][0-9][0-9]/**/*.{html,md,markdown}` (published posts live at `YYYY/MM/<slug>/index.html`) |
   | none detected | `**/*.{md,markdown,html,htm}` |

   `node_modules`, `.git`, `vendor`, `_site`, `public` and `resources` are always skipped.

2. **Extracts links.** Markdown inline links and images, reference definitions, `<https://…>` autolinks, and HTML `<a href>` (in both HTML and markdown files). Fenced code, inline code and HTML comments are ignored. Relative links, `mailto:`, `tel:`, `localhost`, `.local` names and private/loopback IPs are skipped, as is anything matching `ignore-urls`. Links are deduplicated (ignoring `#fragments`) and every `file:line` occurrence is kept.

3. **Checks each link.** `HEAD`, falling back to `GET` on 403/405/501 (and confirming 404/410 with `GET`). 10 s timeout, 2 retries with backoff, `Retry-After` honoured on 429. At most 4 requests in flight and 1 per host. Redirects are followed up to 5 hops.

   | status | meaning |
   | --- | --- |
   | `ok` | 2xx, or a redirect to the same host and path (e.g. http→https) |
   | `moved` | redirects to a different host or path; works, but consider updating it |
   | `dead` | 404/410, or a 5xx, timeout, DNS or connection failure that persisted through retries |
   | `blocked` | 401/403/999, persistent 429, other 4xx, or a redirect loop. Usually bot protection; **not** called dead |

4. **Looks up snapshots** for every checked link via the public Wayback availability API (no key). Only snapshots with a 2xx status count.

5. **Creates snapshots** (snapshot mode only, see below) for working links that have no snapshot, or whose newest snapshot is older than `max-snapshot-age-days`.

6. **Reports**, and with `open-pr: true` proposes replacements.

## Lookup-only mode vs snapshot mode

**Lookup-only (default, no secrets).** Linkguard checks links and looks up existing Wayback snapshots. Dead links with a snapshot get an archived URL in the report. Nothing is captured. The log and summary say "Lookup-only mode".

**Snapshot mode.** If you give Linkguard your own Internet Archive keys, it also asks the Wayback Machine's Save Page Now service to capture working links that have no recent snapshot, so a copy exists before they die.

Set it up:

1. Create a free account at [archive.org](https://archive.org/account/signup) and get your S3-style keys at <https://archive.org/account/s3.php>.
2. In your repo: **Settings → Secrets and variables → Actions → New repository secret**. Add `WAYBACK_ACCESS_KEY` and `WAYBACK_SECRET_KEY`.
3. Pass them to the action:

   ```yaml
   - uses: ninepointlabs/linkguard@v0.1.1
     with:
       wayback-access-key: ${{ secrets.WAYBACK_ACCESS_KEY }}
       wayback-secret-key: ${{ secrets.WAYBACK_SECRET_KEY }}
   ```

The keys are masked in logs and only sent to `web.archive.org` in the `Authorization` header. Captures count against your own Internet Archive account. Dead and blocked links are never submitted.

Captures are slow: submissions are paced to at most 6 per minute and each job is polled every 15 s (up to 20 polls). A first run over 100 links can take 15 minutes or more; `snapshot-time-budget-minutes` (default 20) caps it, and anything unfinished is reported as pending. If the Internet Archive keeps answering HTTP 429, Linkguard stops capturing for that run and says so in the report.

## Opening a pull request with archived links

With `open-pr: true`, Linkguard replaces each dead URL that has a 2xx snapshot with `https://web.archive.org/web/<timestamp>/<original-url>`, exactly where it appears and nothing else in the file, commits that to a new branch `linkguard/archived-links-<run>`, and opens a pull request. The PR lists every replacement and says plainly that each one is an archived copy, not the original. Dead links without a snapshot are only reported.

- It never pushes to your default branch. It only proposes changes when the workflow runs on the default branch (e.g. `schedule` or `workflow_dispatch` there).
- It uses the workflow's `GITHUB_TOKEN`, which needs:

  ```yaml
  permissions:
    contents: write
    pull-requests: write
  ```

- Also enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**, or GitHub will refuse to open the PR.
- PRs opened with `GITHUB_TOKEN` don't trigger other workflows (a GitHub rule). Review them, and close or push to re-run checks if you need them.

## Inputs

| input | default | description |
| --- | --- | --- |
| `paths` | per site type | Newline-separated globs to scan. Overrides the defaults. |
| `site-type` | `auto` | `jekyll`, `hugo`, `folderblog` or `auto`. |
| `max-links` | `100` | Unique links to check per run. Can be lowered; values above 100 are capped at 100. |
| `fail-on-dead` | `false` | Fail the step (and use error annotations) when dead links are found. |
| `open-pr` | `false` | Open a PR replacing dead links with archived copies. |
| `ignore-urls` | | One per line or comma-separated. Plain entries are URL prefixes; `/regex/flags` entries are regular expressions. |
| `snapshot-provider` | `wayback` | Only `wayback` is available. Any other value fails immediately. |
| `wayback-access-key` | | Your Internet Archive access key (secret). Enables snapshot mode with the secret key. |
| `wayback-secret-key` | | Your Internet Archive secret key (secret). |
| `max-snapshot-age-days` | `365` | In snapshot mode, re-capture links whose newest snapshot is older than this. |
| `snapshot-time-budget-minutes` | `20` | Time budget for creating snapshots. |
| `github-token` | `${{ github.token }}` | Used only for `open-pr`. |

## Outputs

| output | description |
| --- | --- |
| `dead-count` | Dead links found. |
| `checked-count` | Unique links checked. |
| `skipped-count` | Unique links not checked because of the cap. |
| `report-path` | Path to `linkguard-report.json` in `$RUNNER_TEMP/linkguard/`. `linkguard-report.md` sits next to it. Upload them with `actions/upload-artifact` if you want to keep them. |

## Free tier: 100 links per run

Each run checks the first 100 unique links, in file order (files sorted by path). Anything beyond that is skipped and the log says `N links skipped (free tier cap 100)`. `max-links` can lower the cap but not raise it.

## Honest limits

- A link check is one request from a GitHub-hosted runner. Sites that block data-centre IPs or bots show up as `blocked`, and a page can be up for people but down for the runner (or the reverse).
- `dead` after retries can still be a temporary outage. Read the report before merging a PR.
- Internet Archive rate limits are not published. Linkguard paces itself and backs off on 429, but lookups or captures can still fail. A failed lookup shows "no snapshot info" instead of failing the run. The availability API also sometimes returns no snapshot for pages that do have one.
- The availability API returns the closest snapshot. If that one isn't a 2xx capture, Linkguard treats the link as having no usable snapshot, even if an older good one exists.
- Each scheduled run that finds replaceable dead links opens a new PR. Merge or close the previous one.
- Link extraction uses patterns, not a full markdown/HTML parser. Unusual syntax can be missed, and shortcodes or templated links (e.g. Hugo `{{< ref >}}`, Liquid `{{ site.url }}`) are not resolved.
- Annotations follow GitHub's per-step limits; the job summary and report files always have the full list.

## Data and privacy

No telemetry, no analytics, no Linkguard server. Data leaves the runner only as:

- requests to the link targets themselves (with User-Agent `Linkguard/0.1`),
- requests to `archive.org` / `web.archive.org` containing link URLs only, never file contents (plus your keys, in snapshot mode),
- GitHub API calls, only when `open-pr` is on.

## Development

```sh
npm ci
npm run typecheck
npm test        # all network calls are mocked; tests fail if one escapes
npm run build   # bundles to dist/index.js, which is committed
```

## License

[MIT](LICENSE)
