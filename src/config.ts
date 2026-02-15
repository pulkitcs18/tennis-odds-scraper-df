import "dotenv/config";

// DraftKings API endpoints
export const DK_NAV_URL =
  "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/nav/sports";
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
 * Only scrape ATP 500 and WTA 500 tournaments.
 * DK names look like "ATP - Rotterdam" or "WTA - Adelaide".
 * We match against these keywords (case-insensitive).
 */
const ALLOWED_TOURNAMENT_KEYWORDS = [
  // ATP 500 (13)
  "rotterdam",
  "rio",
  "acapulco",
  "mexican open",
  "barcelona",
  "hamburg",
  "queen's",
  "queens",
  "halle",
  "washington",
  "china open",
  "beijing",
  "tokyo",
  "vienna",
  "basel",
  "dubai",
  // WTA 500 (13)
  "adelaide",
  "brisbane",
  "st. petersburg",
  "st petersburg",
  "petersburg",
  "charleston",
  "stuttgart",
  // "washington" already listed above (shared keyword)
  "san diego",
  // "tokyo" already listed above (shared keyword)
  "zhengzhou",
  "linz",
  "moscow",
  "abu dhabi",
  "eastbourne",
];

export function isAllowedTournament(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_TOURNAMENT_KEYWORDS.some((kw) => lower.includes(kw));
}
