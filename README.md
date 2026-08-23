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

The frontend is plain static HTML/CSS/JS — no build step, no framework. All FPL data comes from two **n8n Cloud webhooks** that call the official (unofficial, but public) Fantasy Premier League API server-side, since the FPL API doesn't allow direct browser requests (no CORS headers):

- `fpl-fairplay-managers` — returns standings for the classic league and H2H league, cup bracket status, Last Man Standing state, and a computed gameweek summary (top/bottom scorer, league leader, biggest risers/fallers, season-high score).
- `fpl-fairplay-squad` — given a manager's entry ID, returns their squad for a given gameweek (starting XI, bench, captain/vice-captain, live per-player points, club crests).

A third workflow (`fpl-gw-finish-detector.json`) polls periodically and detects the moment a gameweek is fully finalized (`finished` + `data_checked` on FPL's side), ready to trigger a notification step in future.

## Competitions covered

1. **FPL Fairplay League** — classic season-long standings
2. **FPL Fairplay Head to Head** — weekly 1v1 matchups
3. **FPL Cup** — knockout bracket (activates later in the season)
4. **Last Man Standing** — lowest scorer eliminated each week from GW5 onward

See the home page for full rules and prize details.

## Notes

- The `fpl-fairplay-managers.json` and `fpl-gw-finish-detector.json` files are kept here as a backup of the n8n workflow logic — importing them into a fresh n8n instance recreates the webhooks, but the *live* workflows run on n8n Cloud, not from this repo directly.
- League/H2H IDs and the Last Man Standing start gameweek are hardcoded for this specific league; swap `CLASSIC_LEAGUE_ID` / `H2H_LEAGUE_ID` / `LMS_START_GW` in the workflow code to reuse this for a different league.
