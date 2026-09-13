// Rebuilds data/standings.json and data/squads/*.json from the live FPL API.
// Replaces the two n8n Cloud webhooks (fpl-fairplay-managers, fpl-fairplay-squad) that
// previously powered this site, plus the fpl-gw-finish-detector workflow's "has a new
// gameweek just finished" check. Run on a schedule via GitHub Actions.

const fs = require("fs");
const path = require("path");

const CLASSIC_LEAGUE_ID = 684359; // FPL Fairplay League
const H2H_LEAGUE_ID = 1437968; // FPL Fairplay Head to Head
const LMS_START_GW = 5; // Last Man Standing begins at this gameweek

const DATA_DIR = path.join(__dirname, "..", "data");
const SQUADS_DIR = path.join(DATA_DIR, "squads");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const STANDINGS_FILE = path.join(DATA_DIR, "standings.json");

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function fetchLeague(kind, leagueId) {
  const base =
    kind === "classic"
      ? `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`
      : `https://fantasy.premierleague.com/api/leagues-h2h/${leagueId}/standings/`;

  let leagueName = null;
  const managers = [];

  let page = 1;
  let hasNext = true;
  while (hasNext) {
    const response = await getJson(`${base}?page_standings=${page}`);
    if (!leagueName) leagueName = response.league.name;

    for (const entry of response.standings.results) {
      if (entry.entry == null) continue; // skip synthetic "AVERAGE" benchmark row in H2H leagues
      managers.push({
        rank: entry.rank,
        managerName: entry.player_name,
        teamName: entry.entry_name,
        entryId: entry.entry,
        totalPoints: entry.total,
        gwPoints: entry.event_total ?? null,
        matchesWon: entry.matches_won ?? null,
        matchesDrawn: entry.matches_drawn ?? null,
        matchesLost: entry.matches_lost ?? null,
        pointsFor: entry.points_for ?? null,
        status: "scored",
      });
    }
    hasNext = response.standings.has_next;
    page += 1;
  }

  // Pre-season fallback: standings empty, use new_entries (people who joined, no GW played yet)
  if (managers.length === 0) {
    page = 1;
    hasNext = true;
    while (hasNext) {
      const response = await getJson(`${base}?page_new_entries=${page}`);
      if (!leagueName) leagueName = response.league.name;

      for (const entry of response.new_entries.results) {
        managers.push({
          rank: null,
          managerName: `${entry.player_first_name} ${entry.player_last_name}`,
          teamName: entry.entry_name,
          entryId: entry.entry,
          totalPoints: null,
          gwPoints: null,
          matchesWon: null,
          matchesDrawn: null,
          matchesLost: null,
          pointsFor: null,
          status: "joined_no_points_yet",
        });
      }
      hasNext = response.new_entries.has_next;
      page += 1;
    }
  }

  return { leagueName, managers };
}

async function fetchCup(classicManagers) {
  const matchesById = new Map();
  let anyStarted = false;

  for (const m of classicManagers) {
    try {
      const c = await getJson(`https://fantasy.premierleague.com/api/entry/${m.entryId}/cup/`);
      if (c.status && c.status.qualification_state && c.status.qualification_state !== "not_yet_started") {
        anyStarted = true;
      }
      for (const match of c.matches || []) {
        matchesById.set(match.id, match);
      }
    } catch (e) {
      // Cup not available for this manager yet - skip.
    }
  }

  return {
    notStarted: !anyStarted,
    matches: Array.from(matchesById.values()).sort((a, b) => (a.event ?? 0) - (b.event ?? 0)),
  };
}

async function fetchHistories(classicManagers) {
  const histories = {};
  for (const m of classicManagers) {
    try {
      const h = await getJson(`https://fantasy.premierleague.com/api/entry/${m.entryId}/history/`);
      histories[m.entryId] = h.current || [];
    } catch (e) {
      histories[m.entryId] = [];
    }
  }
  return histories;
}

function computeLastManStanding(classicManagers, histories) {
  let maxGw = 0;
  for (const entryId in histories) {
    for (const rec of histories[entryId]) {
      if (rec.event > maxGw) maxGw = rec.event;
    }
  }

  if (maxGw < LMS_START_GW) {
    return {
      status: "not_started",
      startGw: LMS_START_GW,
      currentGw: maxGw,
      message: `Last Man Standing begins at GW${LMS_START_GW}. Current gameweek: ${maxGw || "pre-season"}.`,
      survivors: classicManagers,
      eliminated: [],
    };
  }

  const managerLookup = Object.fromEntries(classicManagers.map((m) => [m.entryId, m]));
  let survivors = classicManagers.map((m) => m.entryId);
  const eliminated = [];

  for (let gw = LMS_START_GW; gw <= maxGw; gw++) {
    const scores = survivors
      .map((id) => {
        const rec = (histories[id] || []).find((r) => r.event === gw);
        return rec ? { entryId: id, gwPoints: rec.points, total: rec.total_points } : null;
      })
      .filter(Boolean);

    if (scores.length === 0) continue;

    const minScore = Math.min(...scores.map((s) => s.gwPoints));
    let candidates = scores.filter((s) => s.gwPoints === minScore);

    if (candidates.length > 1) {
      const minTotal = Math.min(...candidates.map((c) => c.total));
      candidates = candidates.filter((c) => c.total === minTotal);
    }

    for (const c of candidates) {
      eliminated.push({ ...managerLookup[c.entryId], eliminatedGw: gw, gwPoints: c.gwPoints });
      survivors = survivors.filter((id) => id !== c.entryId);
    }

    if (survivors.length <= 1) break;
  }

  return {
    status: survivors.length === 1 ? "winner_decided" : "in_progress",
    startGw: LMS_START_GW,
    currentGw: maxGw,
    survivors: survivors.map((id) => managerLookup[id]),
    eliminated: eliminated.sort((a, b) => b.eliminatedGw - a.eliminatedGw),
  };
}

function computeSeasonHigh(classicManagers, histories, currentGw) {
  const managerLookup = Object.fromEntries(classicManagers.map((m) => [m.entryId, m]));
  let best = null;

  // For the current in-progress gameweek, use live standings data (accurate); the
  // /history/ endpoint can lag behind by a wide margin while that gameweek is still live.
  for (const m of classicManagers) {
    if (m.gwPoints != null) {
      if (!best || m.gwPoints > best.gwPoints) {
        best = {
          managerName: m.managerName,
          teamName: m.teamName,
          entryId: m.entryId,
          gwPoints: m.gwPoints,
          gw: currentGw,
        };
      }
    }
  }

  for (const entryId in histories) {
    for (const rec of histories[entryId]) {
      if (rec.event === currentGw) continue; // already covered by live standings above
      if (!best || rec.points > best.gwPoints) {
        const m = managerLookup[entryId] || {};
        best = {
          managerName: m.managerName,
          teamName: m.teamName,
          entryId: Number(entryId),
          gwPoints: rec.points,
          gw: rec.event,
        };
      }
    }
  }
  return best;
}

function computeGwSummary(classicManagers, currentGw, seasonHigh) {
  const withData = classicManagers.filter((m) => m.totalPoints != null && m.gwPoints != null);
  if (withData.length === 0) return null;

  const withPrevTotal = withData.map((m) => ({ ...m, prevTotal: m.totalPoints - m.gwPoints }));
  const sortedPrev = [...withPrevTotal].sort((a, b) => b.prevTotal - a.prevTotal);
  const prevRankByEntry = {};
  sortedPrev.forEach((m, idx) => {
    prevRankByEntry[m.entryId] = idx + 1;
  });

  const movers = withPrevTotal.map((m) => ({
    entryId: m.entryId,
    managerName: m.managerName,
    teamName: m.teamName,
    rank: m.rank,
    prevRank: prevRankByEntry[m.entryId],
    movement: prevRankByEntry[m.entryId] - m.rank,
    gwPoints: m.gwPoints,
  }));

  const topScorer = [...withPrevTotal].sort((a, b) => b.gwPoints - a.gwPoints)[0];
  const bottomScorer = [...withPrevTotal].sort((a, b) => a.gwPoints - b.gwPoints)[0];
  const averagePoints =
    Math.round((withPrevTotal.reduce((s, m) => s + m.gwPoints, 0) / withPrevTotal.length) * 10) / 10;
  const aboveAverageCount = withPrevTotal.filter((m) => m.gwPoints > averagePoints).length;

  const byRank = [...withData].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  const leader = byRank[0];
  const second = byRank[1];
  const leagueLeader = leader
    ? {
        managerName: leader.managerName,
        teamName: leader.teamName,
        entryId: leader.entryId,
        totalPoints: leader.totalPoints,
        gapToSecond: second ? leader.totalPoints - second.totalPoints : null,
      }
    : null;

  const isFirstGw = currentGw <= 1;

  return {
    gw: currentGw,
    isFirstGw,
    managerCount: withPrevTotal.length,
    averagePoints,
    aboveAverageCount,
    leagueLeader,
    seasonHigh,
    topScorer: {
      managerName: topScorer.managerName,
      teamName: topScorer.teamName,
      entryId: topScorer.entryId,
      gwPoints: topScorer.gwPoints,
    },
    bottomScorer: {
      managerName: bottomScorer.managerName,
      teamName: bottomScorer.teamName,
      entryId: bottomScorer.entryId,
      gwPoints: bottomScorer.gwPoints,
    },
    risers: isFirstGw
      ? []
      : movers
          .filter((m) => m.movement > 0)
          .sort((a, b) => b.movement - a.movement)
          .slice(0, 3),
    fallers: isFirstGw
      ? []
      : movers
          .filter((m) => m.movement < 0)
          .sort((a, b) => a.movement - b.movement)
          .slice(0, 3),
    movementByEntry: Object.fromEntries(movers.map((m) => [m.entryId, m.movement])),
  };
}

// Builds one manager's squad view for the given gameweek, reusing a bootstrap/live
// payload fetched once per script run rather than once per manager (the old n8n
// "Fetch Squad" webhook fetched bootstrap fresh on every single click).
async function fetchSquad(entryId, gw, elementsById, teamsById, liveStatsById, fixturesByTeam) {
  const positionNames = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

  const entryInfo = await getJson(`https://fantasy.premierleague.com/api/entry/${entryId}/`);
  const picksResp = await getJson(`https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`);

  const picks = picksResp.picks.map((p) => {
    const el = elementsById[p.element] || {};
    const team = teamsById[el.team] || {};
    const liveStats = liveStatsById[p.element];
    const hasPlayed = !!(liveStats && liveStats.minutes > 0);

    // Before a player's fixture(s) for this gameweek kick off, show the upcoming
    // opponent (e.g. "MUN (H)") instead of a 0, matching the official FPL site.
    let fixtureLabel = null;
    if (!hasPlayed) {
      const upcoming = (fixturesByTeam[el.team] || []).filter((f) => !f.started);
      if (upcoming.length) {
        fixtureLabel = upcoming
          .map((f) => `${(teamsById[f.opponent] || {}).short_name || "?"} (${f.isHome ? "H" : "A"})`)
          .join(", ");
      }
    }

    return {
      name: el.web_name ?? "Unknown",
      team: team.short_name ?? "",
      crestUrl: team.code ? `https://resources.premierleague.com/premierleague/badges/50/t${team.code}.png` : null,
      position: positionNames[el.element_type] ?? "",
      isCaptain: p.is_captain,
      isViceCaptain: p.is_vice_captain,
      isStarting: p.position <= 11,
      // eventPoints applies the pick's multiplier (0 for an un-subbed-in bench player,
      // 2/3 for captain/triple-captain) - what actually counts toward the manager's total.
      // rawPoints is what the player actually scored in their match regardless of
      // multiplier, so a benched player who played and scored isn't shown as a flat 0.
      eventPoints: (liveStats ? liveStats.total_points : 0) * p.multiplier,
      rawPoints: liveStats ? liveStats.total_points : 0,
      fixtureLabel,
    };
  });

  return {
    entryId: Number(entryId),
    gw,
    managerName: `${entryInfo.player_first_name} ${entryInfo.player_last_name}`,
    teamName: entryInfo.name,
    gwPoints: entryInfo.summary_event_points ?? (picksResp.entry_history ? picksResp.entry_history.points : null),
    totalPoints:
      entryInfo.summary_overall_points ?? (picksResp.entry_history ? picksResp.entry_history.total_points : null),
    overallRank:
      entryInfo.summary_overall_rank ?? (picksResp.entry_history ? picksResp.entry_history.overall_rank : null),
    activeChip: picksResp.active_chip,
    picks,
  };
}

function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

async function main() {
  fs.mkdirSync(SQUADS_DIR, { recursive: true });

  const bootstrap = await getJson("https://fantasy.premierleague.com/api/bootstrap-static/");

  const classic = await fetchLeague("classic", CLASSIC_LEAGUE_ID);
  const h2h = await fetchLeague("h2h", H2H_LEAGUE_ID);
  const cup = await fetchCup(classic.managers);
  const histories = await fetchHistories(classic.managers);
  const lastManStanding = computeLastManStanding(classic.managers, histories);
  const seasonHigh = computeSeasonHigh(classic.managers, histories, lastManStanding.currentGw);
  const gwSummary = computeGwSummary(classic.managers, lastManStanding.currentGw, seasonHigh);

  if (gwSummary && !gwSummary.isFirstGw) {
    for (const m of classic.managers) {
      m.rankChange = gwSummary.movementByEntry[m.entryId] ?? null;
    }
  }

  fs.writeFileSync(
    STANDINGS_FILE,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        classicLeague: classic,
        h2hLeague: h2h,
        cup,
        lastManStanding,
        gwSummary,
      },
      null,
      2
    )
  );

  // --- Squad files: current gameweek only, one per classic-league manager ---
  const currentGw =
    (bootstrap.events.find((e) => e.is_current) || {}).id ||
    ([...bootstrap.events].reverse().find((e) => e.finished) || {}).id ||
    1;

  const elementsById = Object.fromEntries(bootstrap.elements.map((e) => [e.id, e]));
  const teamsById = Object.fromEntries(bootstrap.teams.map((t) => [t.id, t]));

  let liveStatsById = {};
  try {
    const live = await getJson(`https://fantasy.premierleague.com/api/event/${currentGw}/live/`);
    liveStatsById = Object.fromEntries(live.elements.map((e) => [e.id, e.stats]));
  } catch (e) {
    // Live feed can 404 before a gameweek's data is published yet; squads just show 0 pts.
  }

  // Map each team to its fixture(s) this gameweek, so players who haven't kicked off
  // yet can show their opponent instead of a 0.
  const fixturesByTeam = {};
  try {
    const fixtures = await getJson(`https://fantasy.premierleague.com/api/fixtures/?event=${currentGw}`);
    for (const f of fixtures) {
      (fixturesByTeam[f.team_h] = fixturesByTeam[f.team_h] || []).push({
        opponent: f.team_a,
        isHome: true,
        started: f.started,
      });
      (fixturesByTeam[f.team_a] = fixturesByTeam[f.team_a] || []).push({
        opponent: f.team_h,
        isHome: false,
        started: f.started,
      });
    }
  } catch (e) {
    // Fixtures endpoint unavailable - fall back to plain 0s, no fixture labels.
  }

  for (const m of classic.managers) {
    try {
      const squad = await fetchSquad(m.entryId, currentGw, elementsById, teamsById, liveStatsById, fixturesByTeam);
      fs.writeFileSync(path.join(SQUADS_DIR, `${m.entryId}.json`), JSON.stringify(squad, null, 2));
    } catch (e) {
      console.error(`Failed to build squad for entry ${m.entryId}: ${e.message}`);
    }
  }

  // --- GW finish detection (replaces fpl-gw-finish-detector.json) ---
  const state = readJsonIfExists(STATE_FILE, { lastNotifiedGw: 0 });
  const finishedGws = bootstrap.events.filter((e) => e.finished && e.data_checked).map((e) => e.id);
  const latestFinishedGw = finishedGws.length ? Math.max(...finishedGws) : 0;

  if (latestFinishedGw > state.lastNotifiedGw) {
    const topScorer = [...classic.managers].sort((a, b) => (b.gwPoints ?? -1) - (a.gwPoints ?? -1))[0];
    const bottomScorer = [...classic.managers].sort((a, b) => (a.gwPoints ?? Infinity) - (b.gwPoints ?? Infinity))[0];
    const leader = [...classic.managers].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))[0];

    state.lastNotifiedGw = latestFinishedGw;
    state.lastFinishMessage =
      `🏆 ${classic.leagueName} — GW${latestFinishedGw} Results\n\n` +
      `Top scorer: ${topScorer.managerName} (${topScorer.teamName}) — ${topScorer.gwPoints} pts\n` +
      `Lowest score: ${bottomScorer.managerName} (${bottomScorer.teamName}) — ${bottomScorer.gwPoints} pts\n\n` +
      `League Leader: ${leader.managerName} (${leader.teamName}) — ${leader.totalPoints} pts total`;
    // Hook a notification (Slack/WhatsApp/etc) here in future by reading state.lastFinishMessage
    // right after this block runs, before it's persisted below.
    console.log("New gameweek finished:\n" + state.lastFinishMessage);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
