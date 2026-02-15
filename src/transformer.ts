import {
  DKContentResponse,
  DKContentEvent,
  DKContentMarket,
  DKContentSelection,
} from "./draftkings.js";

export interface SportEventInsert {
  external_id: string;
  sport: string;
  league: string;
  home_team_name: string;
  home_team_abbr: string;
  away_team_name: string;
  away_team_abbr: string;
  start_time: string;
  status: string;
  is_outdoor: boolean;
  moneyline_home: number | null;
  moneyline_away: number | null;
  spread_home: number | null;
  spread_away: number | null;
  total_over: number | null;
  total_under: number | null;
}

/**
 * "Jannik Sinner" → "J. Sinner"
 */
function abbreviateName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return fullName.substring(0, 3).toUpperCase();
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

/**
 * Parse DraftKings American odds string to a number.
 * DK uses Unicode characters: \u002B (+) and \u2212 (mathematical minus −)
 * as well as standard +/- characters.
 */
function parseAmericanOdds(oddsStr: string | undefined): number | null {
  if (!oddsStr) return null;
  if (oddsStr.toUpperCase() === "EVEN") return 100;
  // Normalize Unicode: \u2212 (−) → standard minus, \u002B (+) → standard plus
  const normalized = oddsStr.replace(/\u2212/g, "-").replace(/\u002B/g, "+");
  const num = parseInt(normalized, 10);
  return isNaN(num) ? null : num;
}

/**
 * Transform a DraftKings Content API response (events + markets + selections)
 * into an array of sports_events rows ready for upsert.
 *
 * The Content API links data as:
 *   events → markets (by eventId) → selections (by marketId)
 *
 * Selection.outcomeType: "Home" or "Away" indicates which participant
 * Selection.displayOdds.american: the American odds string (with Unicode chars)
 */
export function transformDKResponse(
  response: DKContentResponse,
  tournamentName: string
): SportEventInsert[] {
  const { events, markets, selections } = response;
  const results: SportEventInsert[] = [];

  // Build lookup maps
  const marketsByEvent = new Map<string, DKContentMarket[]>();
  for (const market of markets) {
    const existing = marketsByEvent.get(market.eventId) || [];
    existing.push(market);
    marketsByEvent.set(market.eventId, existing);
  }

  const selectionsByMarket = new Map<string, DKContentSelection[]>();
  for (const selection of selections) {
    const existing = selectionsByMarket.get(selection.marketId) || [];
    existing.push(selection);
    selectionsByMarket.set(selection.marketId, existing);
  }

  for (const event of events) {
    // Skip non-upcoming events
    if (event.status !== "NOT_STARTED") continue;

    // Skip events in the past
    const startDate = new Date(event.startEventDate);
    if (startDate < new Date()) continue;

    // Extract player names from participants
    const homeParticipant = event.participants?.find(
      (p) => p.venueRole === "Home"
    );
    const awayParticipant = event.participants?.find(
      (p) => p.venueRole === "Away"
    );

    // Fallback: parse from event name "Player1 v Player2"
    const player1 =
      homeParticipant?.name ||
      event.name?.split(/\s+v[s.]?\s+/i)?.[0]?.trim() ||
      "TBD";
    const player2 =
      awayParticipant?.name ||
      event.name?.split(/\s+v[s.]?\s+/i)?.[1]?.trim() ||
      "TBD";

    if (player1 === "TBD" || player2 === "TBD") continue;

    // Extract odds from markets/selections for this event
    let moneyline_home: number | null = null;
    let moneyline_away: number | null = null;
    let spread_home: number | null = null;
    let spread_away: number | null = null;
    let total_over: number | null = null;
    let total_under: number | null = null;

    const eventMarkets = marketsByEvent.get(event.id) || [];

    for (const market of eventMarkets) {
      const marketName = (
        market.name ||
        market.marketType?.name ||
        ""
      ).toLowerCase();
      const sels = selectionsByMarket.get(market.id) || [];

      // ── Moneyline / Match Winner ──
      if (
        marketName.includes("moneyline") ||
        marketName.includes("match winner") ||
        marketName.includes("winner") ||
        marketName.includes("match lines")
      ) {
        const homeSel = sels.find((s) => s.outcomeType === "Home");
        const awaySel = sels.find((s) => s.outcomeType === "Away");

        moneyline_home =
          parseAmericanOdds(homeSel?.displayOdds?.american) ?? moneyline_home;
        moneyline_away =
          parseAmericanOdds(awaySel?.displayOdds?.american) ?? moneyline_away;

        // Fallback: use index order if outcomeType not set
        if (moneyline_home === null && moneyline_away === null && sels.length >= 2) {
          moneyline_home = parseAmericanOdds(sels[0]?.displayOdds?.american);
          moneyline_away = parseAmericanOdds(sels[1]?.displayOdds?.american);
        }
      }

      // ── Game Spread / Handicap ──
      if (
        marketName.includes("spread") ||
        marketName.includes("handicap") ||
        marketName.includes("game spread")
      ) {
        const homeSel = sels.find((s) => s.outcomeType === "Home");
        const awaySel = sels.find((s) => s.outcomeType === "Away");

        // DK selections may have a `line` property or include line in label
        const homeLine = (homeSel as any)?.line ?? null;
        const awayLine = (awaySel as any)?.line ?? null;

        spread_home = homeLine ?? (sels.length >= 2 ? (sels[0] as any)?.line ?? null : null);
        spread_away = awayLine ?? (sels.length >= 2 ? (sels[1] as any)?.line ?? null : null);
      }

      // ── Total Games ──
      if (
        marketName.includes("total") ||
        marketName.includes("over/under") ||
        marketName.includes("total games")
      ) {
        const overSel = sels.find(
          (s) => s.label?.toLowerCase() === "over" || s.outcomeType === "Over"
        );
        const underSel = sels.find(
          (s) => s.label?.toLowerCase() === "under" || s.outcomeType === "Under"
        );

        total_over = (overSel as any)?.line ?? (sels.length >= 2 ? (sels[0] as any)?.line ?? null : null);
        total_under = (underSel as any)?.line ?? (sels.length >= 2 ? (sels[1] as any)?.line ?? null : null);
      }
    }

    results.push({
      external_id: `dk_tennis_${event.id}`,
      sport: "Tennis",
      league: tournamentName,
      home_team_name: player1,
      home_team_abbr: abbreviateName(player1),
      away_team_name: player2,
      away_team_abbr: abbreviateName(player2),
      start_time: event.startEventDate,
      status: "scheduled",
      is_outdoor: true,
      moneyline_home,
      moneyline_away,
      spread_home,
      spread_away,
      total_over,
      total_under,
    });
  }

  console.log(
    `[Transform] ${tournamentName}: ${events.length} total events → ${results.length} upcoming matches`
  );
  return results;
}
