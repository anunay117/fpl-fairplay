# FPL Fairplay

A live companion website for the **FPL Fairplay** mini-league (Season 7) — standings, rules, prizes, and gameweek recaps for all four competitions, pulled straight from the official Fantasy Premier League API.

🔗 **Live site:** https://anunay117.github.io/fpl-fairplay/

## What's in here

| File | Purpose |
|---|---|
| `index.html` | Home page — welcome banner, GW summary with AI-style commentary, competition rules, prizes tab, Buy Me a Coffee |
| `fpl-fairplay.html` | Live standings — League / Head to Head / Cup / Last Man Standing tabs, sortable & searchable tables, click-through squad viewer |
| `fpl-fairplay-managers.json` | n8n workflow (backup/reference) — the two webhooks that power both pages |
| `fpl-gw-finish-detector.json` | n8n workflow (backup/reference) — scheduled check for when a gameweek officially finishes |
| `prize.png`, `coffee-qr.png` | Images used on the site |

## How it works

The frontend is plain static HTML/CSS/JS — no build step, no framework. Data comes from `data/standings.json` and `data/squads/<entryId>.json`, both static files committed to this repo and served by GitHub Pages alongside the HTML.

Those files are regenerated every 10 minutes by `scripts/build-data.js`, run on a schedule by the `.github/workflows/update-data.yml` GitHub Action (also runnable manually via "Run workflow" in the Actions tab). The script calls the official (unofficial, but public) Fantasy Premier League API server-side and:

- Fetches classic + H2H league standings, cup bracket status, and per-manager history, then computes Last Man Standing state and a gameweek summary (top/bottom scorer, league leader, biggest risers/fallers, season-high score) — written to `data/standings.json`.
- Fetches each classic-league manager's squad for the current gameweek (starting XI, bench, captain/vice-captain, live per-player points, club crests) — one file per manager under `data/squads/`.
- Checks whether a gameweek has just been fully finalized (`finished` + `data_checked` on FPL's side) and logs a results message to `data/state.json` — a hook for a future notification step (Slack/WhatsApp/etc.), not wired to one yet.

This previously ran as three n8n Cloud webhooks/workflows, but n8n Cloud isn't free past a 14-day trial and this site earns no revenue, so the same logic was ported to a plain Node script that GitHub runs for free.

## Competitions covered

1. **FPL Fairplay League** — classic season-long standings
2. **FPL Fairplay Head to Head** — weekly 1v1 matchups
3. **FPL Cup** — knockout bracket (activates later in the season)
4. **Last Man Standing** — lowest scorer eliminated each week from GW5 onward

See the home page for full rules and prize details.

## Notes

- `fpl-fairplay-managers.json` and `fpl-gw-finish-detector.json` are kept only as a historical reference of the original n8n workflow logic — they are no longer used to run the site.
- League/H2H IDs and the Last Man Standing start gameweek are hardcoded for this specific league; swap `CLASSIC_LEAGUE_ID` / `H2H_LEAGUE_ID` / `LMS_START_GW` at the top of `scripts/build-data.js` to reuse this for a different league.
- The squad viewer only ever shows the current gameweek's squad (matching what the frontend previously requested) — past gameweeks aren't stored.
- GitHub auto-disables a repo's scheduled Actions workflows after 60 days with no other repo activity; if updates seem to have stopped, re-enable it from the Actions tab.
