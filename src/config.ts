import "dotenv/config";

// DraftKings API endpoints
export const DK_NAV_URL =
  "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/nav/sports";
export const DK_ODDS_BASE_URL =
  "https://sportsbook-nash.draftkings.com/sites/US-SB/api/v5/eventgroups";

// Tennis is displayGroupId "6" in DraftKings (API returns string)
export const TENNIS_DISPLAY_GROUP_ID = "6";

// Supabase edge function
export const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://atfqqsejqbtebwouggpl.supabase.co";
export const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || "";

// Scheduling
export const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 */2 * * *";
export const RUN_ON_START = process.env.RUN_ON_START !== "false";

/**
 * Tournaments already covered by The Odds API — skip to avoid duplicates.
 * Matching is case-insensitive substring check against tournament name.
 */
const SKIP_TOURNAMENT_KEYWORDS = [
  // Grand Slams
  "australian open",
  "french open",
  "roland garros",
  "wimbledon",
  "us open",
  // Masters 1000
  "indian wells",
  "bnp paribas",
  "miami",
  "monte carlo",
  "monte-carlo",
  "madrid",
  "italian open",
  "rome",
  "internazionali",
  "canadian open",
  "rogers cup",
  "national bank open",
  "cincinnati",
  "western & southern",
  "shanghai",
  "paris masters",
  "rolex paris",
  // Other tournaments covered by Odds API
  "dubai",
  "qatar",
  "doha",
  "china open",
  "beijing",
  "wuhan",
];

export function shouldSkipTournament(name: string): boolean {
  const lower = name.toLowerCase();
  return SKIP_TOURNAMENT_KEYWORDS.some((kw) => lower.includes(kw));
}
