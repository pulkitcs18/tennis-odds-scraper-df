import { DKEventGroupResponse, DKEvent } from "./draftkings.js";

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

interface EventOdds {
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
 * Convert decimal odds to American format.
 * decimal >= 2.0 → positive (+150 for 2.50)
 * decimal < 2.0  → negative (-200 for 1.50)
 */
function americanFromDecimal(decimal: number): number {
  if (decimal >= 2.0) {
    return Math.round((decimal - 1) * 100);
  }
  return Math.round(-100 / (decimal - 1));
}

/**
 * Parse American odds string like "-200" or "+150" to a number.
 */
function parseAmericanOdds(oddsStr: string | undefined): number | null {
  if (!oddsStr) return null;
  // Remove "EVEN" → 100
  if (oddsStr.toUpperCase() === "EVEN") return 100;
  const num = parseInt(oddsStr, 10);
  return isNaN(num) ? null : num;
}

/**
 * Extract moneyline, spread, and total odds for a specific event
 * from the DraftKings offerCategories structure.
 */
function extractOddsForEvent(
  response: DKEventGroupResponse,
  event: DKEvent
): EventOdds {
  const odds: EventOdds = {
    moneyline_home: null,
    moneyline_away: null,
    spread_home: null,
    spread_away: null,
    total_over: null,
    total_under: null,
  };

  const categories = response.eventGroup.offerCategories || [];

  for (const category of categories) {
    const descriptors = category.offerSubcategoryDescriptors || [];

    for (const descriptor of descriptors) {
      const offersGrid = descriptor.offerSubcategory?.offers || [];

      for (const offerGroup of offersGrid) {
        for (const offer of offerGroup) {
          // Match offer to event
          const offerEventId =
            offer.eventId ??
            (offer.providerEventId
              ? parseInt(offer.providerEventId, 10)
              : null);
          if (offerEventId !== event.eventId) continue;
          if (offer.isSuspended) continue;

          const label = (
            offer.label ||
            descriptor.name ||
            ""
          ).toLowerCase();
          const outcomes = offer.outcomes || [];

          // ── Moneyline / Match Winner ──
          if (
            label.includes("moneyline") ||
            label.includes("match winner") ||
            label.includes("winner") ||
            label.includes("match lines")
          ) {
            if (outcomes.length >= 2) {
              const p1 = outcomes.find(
                (o) =>
                  o.participant === event.teamName1 ||
                  o.label === event.teamName1
              );
              const p2 = outcomes.find(
                (o) =>
                  o.participant === event.teamName2 ||
                  o.label === event.teamName2
              );

              if (p1) {
                odds.moneyline_home =
                  parseAmericanOdds(p1.oddsAmerican) ??
                  (p1.oddsDecimal
                    ? americanFromDecimal(p1.oddsDecimal)
                    : null);
              }
              if (p2) {
                odds.moneyline_away =
                  parseAmericanOdds(p2.oddsAmerican) ??
                  (p2.oddsDecimal
                    ? americanFromDecimal(p2.oddsDecimal)
                    : null);
              }

              // Fallback: if we couldn't match by name, use index order
              if (odds.moneyline_home === null && odds.moneyline_away === null) {
                odds.moneyline_home =
                  parseAmericanOdds(outcomes[0]?.oddsAmerican) ??
                  (outcomes[0]?.oddsDecimal
                    ? americanFromDecimal(outcomes[0].oddsDecimal)
                    : null);
                odds.moneyline_away =
                  parseAmericanOdds(outcomes[1]?.oddsAmerican) ??
                  (outcomes[1]?.oddsDecimal
                    ? americanFromDecimal(outcomes[1].oddsDecimal)
                    : null);
              }
            }
          }

          // ── Game Spread / Handicap ──
          if (
            label.includes("spread") ||
            label.includes("handicap") ||
            label.includes("game spread")
          ) {
            if (outcomes.length >= 2) {
              const p1 = outcomes.find(
                (o) =>
                  o.participant === event.teamName1 ||
                  o.label === event.teamName1
              );
              const p2 = outcomes.find(
                (o) =>
                  o.participant === event.teamName2 ||
                  o.label === event.teamName2
              );

              odds.spread_home = p1?.line ?? outcomes[0]?.line ?? null;
              odds.spread_away = p2?.line ?? outcomes[1]?.line ?? null;
            }
          }

          // ── Total Games ──
          if (
            label.includes("total") ||
            label.includes("over/under") ||
            label.includes("total games")
          ) {
            if (outcomes.length >= 2) {
              const over = outcomes.find(
                (o) => o.label?.toLowerCase() === "over"
              );
              const under = outcomes.find(
                (o) => o.label?.toLowerCase() === "under"
              );

              odds.total_over = over?.line ?? outcomes[0]?.line ?? null;
              odds.total_under = under?.line ?? outcomes[1]?.line ?? null;
            }
          }
        }
      }
    }
  }

  return odds;
}

/**
 * Transform a full DraftKings eventGroup response into an array of
 * sports_events rows ready for upsert.
 */
export function transformDKResponse(
  response: DKEventGroupResponse,
  tournamentName: string
): SportEventInsert[] {
  const events = response.eventGroup.events || [];
  const results: SportEventInsert[] = [];

  for (const event of events) {
    // Skip events already started or finished
    const state = event.eventStatus?.state || "";
    if (state === "RESULTED" || state === "STARTED" || state === "LIVE") {
      continue;
    }

    // Skip events in the past
    const startDate = new Date(event.startDate);
    if (startDate < new Date()) continue;

    // Player names — DK uses teamName1/teamName2, or parse from "X v Y" name
    const player1 =
      event.teamName1 ||
      event.name?.split(/\s+v[s.]?\s+/i)?.[0]?.trim() ||
      "TBD";
    const player2 =
      event.teamName2 ||
      event.name?.split(/\s+v[s.]?\s+/i)?.[1]?.trim() ||
      "TBD";

    // Skip qualifier/TBD matches
    if (player1 === "TBD" || player2 === "TBD") continue;

    const odds = extractOddsForEvent(response, event);

    results.push({
      external_id: `dk_tennis_${event.eventId}`,
      sport: "Tennis",
      league: tournamentName,
      home_team_name: player1,
      home_team_abbr: abbreviateName(player1),
      away_team_name: player2,
      away_team_abbr: abbreviateName(player2),
      start_time: event.startDate,
      status: "scheduled",
      is_outdoor: true,
      ...odds,
    });
  }

  console.log(
    `[Transform] ${tournamentName}: ${events.length} total events → ${results.length} upcoming matches`
  );
  return results;
}
