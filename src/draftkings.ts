import { ProxyAgent } from "undici";
import {
  DK_NAV_URL,
  DK_ODDS_BASE_URL,
  TENNIS_DISPLAY_GROUP_ID,
  shouldSkipTournament,
} from "./config.js";

// Proxy dispatcher for geo-blocked endpoints (odds API)
// Node's native fetch uses undici — must use undici's ProxyAgent with `dispatcher`
const PROXY_URL = process.env.PROXY_URL;
const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

// ── Types for DraftKings API responses ──

export interface DKTournament {
  eventGroupId: number;
  name: string;
}

export interface DKEvent {
  eventId: number;
  name: string;
  startDate: string;
  teamName1: string;
  teamName2: string;
  eventStatus?: { state: string };
}

export interface DKOutcome {
  label: string;
  oddsDecimal: number;
  oddsAmerican: string;
  line?: number;
  participant?: string;
}

export interface DKOffer {
  providerEventId?: string;
  eventId?: number;
  label: string;
  outcomes: DKOutcome[];
  isSuspended?: boolean;
}

export interface DKEventGroupResponse {
  eventGroup: {
    eventGroupId: number;
    name: string;
    events?: DKEvent[];
    offerCategories?: Array<{
      offerCategoryId: number;
      name: string;
      offerSubcategoryDescriptors?: Array<{
        subcategoryId: number;
        name: string;
        offerSubcategory?: {
          offers?: DKOffer[][];
        };
      }>;
    }>;
  };
}

/**
 * Fetch all active tennis tournaments from DraftKings nav API.
 * This endpoint is NOT geo-blocked.
 *
 * Response shape:
 *   { displayGroupInfos: [{ displayGroupId: "6", displayName: "Tennis",
 *       eventGroupInfos: [{ eventGroupId: 207726, eventGroupName: "ATP - Dallas" }, ...] }] }
 */
export async function fetchTennisTournaments(): Promise<DKTournament[]> {
  console.log("[DK] Fetching tennis tournaments from nav API...");

  const res = await fetch(DK_NAV_URL);
  if (!res.ok) {
    throw new Error(`Nav API returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();

  // Nav API returns { displayGroupInfos: [...] }
  const groups: any[] = data.displayGroupInfos || [];

  const tennisSport = groups.find(
    (g: any) =>
      String(g.displayGroupId) === String(TENNIS_DISPLAY_GROUP_ID) ||
      g.displayName?.toLowerCase() === "tennis"
  );

  if (!tennisSport) {
    console.log("[DK] Tennis sport not found in nav response");
    console.log(
      "[DK] Available sports:",
      groups
        .map((g: any) => `${g.displayName} (${g.displayGroupId})`)
        .join(", ")
    );
    return [];
  }

  // Event groups (tournaments) are in eventGroupInfos
  const eventGroups: any[] = tennisSport.eventGroupInfos || [];
  const tournaments: DKTournament[] = [];

  for (const eg of eventGroups) {
    const name: string = eg.eventGroupName || eg.displayName || eg.name || "";
    const eventGroupId: number | undefined = eg.eventGroupId;

    if (!eventGroupId || !name) continue;

    if (shouldSkipTournament(name)) {
      console.log(`[DK] Skipping "${name}" (covered by Odds API)`);
      continue;
    }

    // Skip doubles tournaments
    if (name.toLowerCase().includes("doubles")) {
      console.log(`[DK] Skipping "${name}" (doubles)`);
      continue;
    }

    tournaments.push({ eventGroupId, name });
  }

  console.log(
    `[DK] Found ${tournaments.length} uncovered tournaments to scrape`
  );
  for (const t of tournaments) {
    console.log(`  - ${t.name} (eventGroupId: ${t.eventGroupId})`);
  }

  return tournaments;
}

/**
 * Fetch odds for a specific tournament from DraftKings v5 API.
 * NOTE: This endpoint IS geo-blocked — must run from a US IP.
 */
export async function fetchTournamentOdds(
  eventGroupId: number
): Promise<DKEventGroupResponse | null> {
  const url = `${DK_ODDS_BASE_URL}/${eventGroupId}?format=json`;
  console.log(`[DK] Fetching odds for eventGroup ${eventGroupId}...`);

  try {
    const fetchOptions: any = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
      },
    };
    if (proxyDispatcher) {
      fetchOptions.dispatcher = proxyDispatcher;
      console.log(`[DK] Using proxy for odds request`);
    }
    const res = await fetch(url, fetchOptions);

    if (res.status === 403) {
      console.error(
        `[DK] Geo-blocked for eventGroup ${eventGroupId}. Ensure Railway is deployed in a US region.`
      );
      return null;
    }

    if (!res.ok) {
      const body = await res.text();
      console.error(
        `[DK] Error ${res.status} for eventGroup ${eventGroupId}: ${body.slice(0, 200)}`
      );
      return null;
    }

    const data: DKEventGroupResponse = await res.json();

    // Log response shape for debugging
    const eventCount = data.eventGroup?.events?.length ?? 0;
    const categoryCount = data.eventGroup?.offerCategories?.length ?? 0;
    console.log(
      `[DK] eventGroup ${eventGroupId}: ${eventCount} events, ${categoryCount} offer categories`
    );

    return data;
  } catch (err) {
    console.error(`[DK] Failed to fetch eventGroup ${eventGroupId}:`, err);
    return null;
  }
}
