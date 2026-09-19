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

// Fetched once per manager and reused both for the standings table's Overall Rank
// column and for building each manager's squad file, instead of hitting /entry/{id}/
// twice for the same data.
async function fetchEntryInfos(classicManagers) {
  const entryInfoById = {};
  for (const m of classicManagers) {
    try {
      entryInfoById[m.entryId] = await getJson(`https://fantasy.premierleague.com/api/entry/${m.entryId}/`);
    } catch (e) {
      entryInfoById[m.entryId] = null;
    }
  }
  return entryInfoById;
}

function computeLastManStanding(classicManagers, histories, latestFinishedGw) {
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

  // The /history/ endpoint reflects the gameweek still in progress in real time, but bonus
  // points aren't locked in until FPL marks it finished + data_checked - so only eliminate
  // someone off a gameweek once it's fully finalized, not off a live/partial score. While a
  // gameweek is still live, survivors keep their current (live) gwPoints from classicManagers
  // so the frontend can show who's provisionally in last place without eliminating them yet.
  const lastDecidableGw = Math.min(maxGw, latestFinishedGw);
  const liveGwInProgress = maxGw > lastDecidableGw;

  const managerLookup = Object.fromEntries(classicManagers.map((m) => [m.entryId, m]));
  let survivors = classicManagers.map((m) => m.entryId);
  const eliminated = [];

  for (let gw = LMS_START_GW; gw <= lastDecidableGw; gw++) {
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
    liveGw: liveGwInProgress ? maxGw : null,
    survivors: survivors.map((id) => managerLookup[id]),
    eliminated: eliminated.sort((a, b) => b.eliminatedGw - a.eliminatedGw),
  };
}

// Mirrors the "filter by month" view on the official FPL standings page: each gameweek is
// bucketed into the calendar month its deadline falls in (deadline_time is real-world, unlike
// the GW number), then every classic-league manager's points across that month's gameweeks are
// summed. A month is "finalized" once every gameweek in it is finished + data_checked; otherwise
// it's the current in-progress leaderboard for that month.
function computeManagerOfTheMonth(classicManagers, histories, events) {
  const monthBuckets = new Map();
  for (const e of events) {
    if (!e.deadline_time) continue;
    const d = new Date(e.deadline_time);
    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!monthBuckets.has(monthKey)) {
      monthBuckets.set(monthKey, {
        monthKey,
        label: d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
        gwIds: [],
      });
    }
    monthBuckets.get(monthKey).gwIds.push(e.id);
  }

  const eventById = Object.fromEntries(events.map((e) => [e.id, e]));

  return [...monthBuckets.values()]
    .sort((a, b) => a.gwIds[0] - b.gwIds[0])
    .map(({ monthKey, label, gwIds }) => {
      const allFinished = gwIds.every((id) => eventById[id]?.finished && eventById[id]?.data_checked);
      const anyPlayed = gwIds.some((id) => eventById[id]?.finished || eventById[id]?.is_current);

      const leaderboard = classicManagers
        .map((m) => {
          const points = (histories[m.entryId] || [])
            .filter((rec) => gwIds.includes(rec.event))
            .reduce((sum, rec) => sum + (rec.points || 0), 0);
          return { entryId: m.entryId, managerName: m.managerName, teamName: m.teamName, points };
        })
        .sort((a, b) => b.points - a.points);

      const topScore = leaderboard.length ? leaderboard[0].points : 0;
      const winners = topScore > 0 ? leaderboard.filter((t) => t.points === topScore) : [];

      return {
        monthKey,
        label,
        gws: gwIds,
        status: allFinished ? "finalized" : anyPlayed ? "in_progress" : "not_started",
        leaderboard,
        winners,
      };
    })
    .filter((m) => m.status !== "not_started");
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
async function fetchSquad(entryId, gw, elementsById, teamsById, liveStatsById, fixturesByTeam, entryInfo) {
  const positionNames = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

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

  const info = entryInfo || {};
  return {
    entryId: Number(entryId),
    gw,
    managerName: `${info.player_first_name ?? ""} ${info.player_last_name ?? ""}`.trim(),
    teamName: info.name ?? null,
    gwPoints: info.summary_event_points ?? (picksResp.entry_history ? picksResp.entry_history.points : null),
    totalPoints:
      info.summary_overall_points ?? (picksResp.entry_history ? picksResp.entry_history.total_points : null),
    overallRank:
      info.summary_overall_rank ?? (picksResp.entry_history ? picksResp.entry_history.overall_rank : null),
    activeChip: picksResp.active_chip,
    picks,
  };
}

async function sendSlackMessage(text) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error(`Slack webhook failed: ${res.status} ${res.statusText}`);
  } catch (e) {
    console.error(`Slack webhook error: ${e.message}`);
  }
}

function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

// Covers a match's ~90 minutes of play plus stoppage time and the lag before bonus points/
// data_checked are confirmed, so a 10-min external trigger keeps polling through that tail
// instead of stopping the instant the final whistle blows.
const MATCH_WINDOW_TAIL_MS = 150 * 60 * 1000;

async function isMatchWindowActive(gwId) {
  if (!gwId) return false;
  let fixtures = [];
  try {
    fixtures = await getJson(`https://fantasy.premierleague.com/api/fixtures/?event=${gwId}`);
  } catch (e) {
    return true; // fixtures endpoint unavailable - fail open and run the full refresh anyway.
  }

  const now = Date.now();
  return fixtures.some((f) => {
    if (f.started && !f.finished) return true;
    if (!f.kickoff_time) return false;
    const kickoff = new Date(f.kickoff_time).getTime();
    return now >= kickoff && now <= kickoff + MATCH_WINDOW_TAIL_MS;
  });
}

async function main() {
  fs.mkdirSync(SQUADS_DIR, { recursive: true });

  const bootstrap = await getJson("https://fantasy.premierleague.com/api/bootstrap-static/");
  const finishedGws = bootstrap.events.filter((e) => e.finished && e.data_checked).map((e) => e.id);
  const latestFinishedGw = finishedGws.length ? Math.max(...finishedGws) : 0;

  // The 10-min external trigger fires around the clock, but there's no point hammering the
  // FPL API and pushing empty commits when no match is actually being played. The 4h in-repo
  // schedule (GITHUB_EVENT_NAME === "schedule") always runs the full refresh regardless, as a
  // backup that keeps data from ever going stale for more than a few hours.
  const activeGwEvent = bootstrap.events.find((e) => e.is_current) || bootstrap.events.find((e) => !e.finished);
  const matchLive = await isMatchWindowActive(activeGwEvent ? activeGwEvent.id : null);

  if (!matchLive && process.env.GITHUB_EVENT_NAME !== "schedule") {
    console.log("No live match window right now - skipping full refresh.");
    return;
  }

  const classic = await fetchLeague("classic", CLASSIC_LEAGUE_ID);
  const h2h = await fetchLeague("h2h", H2H_LEAGUE_ID);
  const cup = await fetchCup(classic.managers);
  const histories = await fetchHistories(classic.managers);
  const entryInfoById = await fetchEntryInfos(classic.managers);
  const lastManStanding = computeLastManStanding(classic.managers, histories, latestFinishedGw);
  const seasonHigh = computeSeasonHigh(classic.managers, histories, lastManStanding.currentGw);
  const gwSummary = computeGwSummary(classic.managers, lastManStanding.currentGw, seasonHigh);
  const managerOfTheMonth = computeManagerOfTheMonth(classic.managers, histories, bootstrap.events);

  if (gwSummary && !gwSummary.isFirstGw) {
    for (const m of classic.managers) {
      m.rankChange = gwSummary.movementByEntry[m.entryId] ?? null;
    }
  }

  for (const m of classic.managers) {
    const info = entryInfoById[m.entryId];
    m.overallRank = info ? info.summary_overall_rank ?? null : null;
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
        managerOfTheMonth,
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
      const squad = await fetchSquad(
        m.entryId,
        currentGw,
        elementsById,
        teamsById,
        liveStatsById,
        fixturesByTeam,
        entryInfoById[m.entryId]
      );
      fs.writeFileSync(path.join(SQUADS_DIR, `${m.entryId}.json`), JSON.stringify(squad, null, 2));
    } catch (e) {
      console.error(`Failed to build squad for entry ${m.entryId}: ${e.message}`);
    }
  }

  // --- GW finish detection (replaces fpl-gw-finish-detector.json) ---
  const state = readJsonIfExists(STATE_FILE, { lastNotifiedGw: 0 });

  if (latestFinishedGw > state.lastNotifiedGw) {
    const topScorer = [...classic.managers].sort((a, b) => (b.gwPoints ?? -1) - (a.gwPoints ?? -1))[0];
    const bottomScorer = [...classic.managers].sort((a, b) => (a.gwPoints ?? Infinity) - (b.gwPoints ?? Infinity))[0];
    const leader = [...classic.managers].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))[0];

    state.lastNotifiedGw = latestFinishedGw;
    // *bold* / _italic_ is the same plain-text syntax in both Slack and WhatsApp, so this
    // renders correctly if copy-pasted from Slack straight into a WhatsApp chat.
    state.lastFinishMessage =
      `🏆 *${classic.leagueName}* — GW${latestFinishedGw} Results\n\n` +
      `🔥 Top scorer: *${topScorer.managerName}* (${topScorer.teamName}) — ${topScorer.gwPoints} pts\n` +
      `🥶 Lowest score: *${bottomScorer.managerName}* (${bottomScorer.teamName}) — ${bottomScorer.gwPoints} pts\n\n` +
      `👑 League Leader: *${leader.managerName}* (${leader.teamName}) — ${leader.totalPoints} pts total`;

    const messages = [state.lastFinishMessage];

    // Last Man Standing update - only once eliminations for this specific gameweek have
    // actually been decided (guarded by the same latestFinishedGw the elimination loop uses).
    if (lastManStanding.status !== "not_started") {
      const eliminatedThisGw = lastManStanding.eliminated.filter((e) => e.eliminatedGw === latestFinishedGw);
      if (eliminatedThisGw.length > 0) {
        const eliminatedLines = eliminatedThisGw
          .map((e) => `☠️ *${e.managerName}* (${e.teamName}) — ${e.gwPoints} pts`)
          .join("\n");
        const survivorCount = lastManStanding.survivors.length;
        const statusLine =
          lastManStanding.status === "winner_decided"
            ? `🏆 *${lastManStanding.survivors[0]?.managerName ?? "The last manager standing"}* wins Last Man Standing! 🎉`
            : `👥 ${survivorCount} manager${survivorCount === 1 ? "" : "s"} still standing.`;
        messages.push(
          `💀 *Last Man Standing — GW${latestFinishedGw}*\n\n${eliminatedLines}\n\n${statusLine}`
        );
      }
    }

    state.lastFinishMessage = messages.join("\n\n---\n\n");
    for (const msg of messages) {
      await sendSlackMessage(msg);
    }
    console.log("New gameweek finished:\n" + state.lastFinishMessage);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
