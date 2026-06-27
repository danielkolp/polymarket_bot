/**
 * Market categorization + correlation-key inference. Pure, dependency-light
 * heuristics used only for bucketing analytics — never for trading decisions.
 */
import type { Market } from "@/lib/polymarket/types";
import type { MarketCategory } from "./types";

const CATEGORY_KEYWORDS: Array<{ category: MarketCategory; patterns: RegExp[] }> = [
  {
    category: "sports",
    patterns: [
      /\b(nfl|nba|mlb|nhl|ncaa|epl|uefa|fifa|ufc|f1|formula 1|premier league|la liga|serie a|bundesliga)\b/i,
      /\b(vs\.?|@)\b.*\b(win|beat|defeat|score|game|match)\b/i,
      /\b(super bowl|world cup|champions league|playoffs?|grand prix|world series|stanley cup)\b/i,
      /\b(touchdown|goals?|points|rebounds|assists|home run)\b/i,
    ],
  },
  {
    category: "politics",
    patterns: [
      /\b(election|president|presidential|senate|congress|governor|parliament|primary|caucus)\b/i,
      /\b(democrat|republican|gop|nominee|ballot|vote share|approval rating|impeach)\b/i,
      /\b(trump|biden|harris|putin|zelensky|netanyahu|xi jinping)\b/i,
    ],
  },
  {
    category: "crypto",
    patterns: [
      /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|dogecoin|doge|altcoin|stablecoin|nft)\b/i,
      /\b(hit \$?\d+k?|reach \$?\d+|flip|halving|etf approval)\b.*\b(coin|token|price)\b/i,
    ],
  },
  {
    category: "economics",
    patterns: [
      /\b(fed|fomc|interest rate|rate cut|rate hike|inflation|cpi|gdp|recession|jobs report|unemployment)\b/i,
      /\b(s&p 500|nasdaq|dow jones|stock market|treasury yield)\b/i,
    ],
  },
  {
    category: "science-tech",
    patterns: [
      /\b(spacex|nasa|rocket|launch|satellite|ai model|gpt|openai|anthropic|nobel|vaccine|fda approval)\b/i,
      /\b(quantum|fusion|asteroid|mars|moon landing)\b/i,
    ],
  },
  {
    category: "weather",
    patterns: [/\b(hurricane|temperature|rainfall|snow|storm|el ni[nñ]o|climate|heat wave|tornado)\b/i],
  },
  {
    category: "pop-culture",
    patterns: [
      /\b(oscars?|grammys?|emmys?|box office|billboard|movie|album|netflix|taylor swift|kanye|spotify)\b/i,
      /\b(rotten tomatoes|imdb|tv show|reality show|tour)\b/i,
    ],
  },
];

/**
 * Infer the analytics category for a market. Prefers Gamma's own `category`
 * field when it maps cleanly, then falls back to title/slug keyword heuristics.
 */
export function categorizeMarket(market: Market | null, title?: string, slug?: string): MarketCategory {
  const gamma = (market?.category ?? "").toLowerCase().trim();
  const direct: Record<string, MarketCategory> = {
    sports: "sports",
    politics: "politics",
    crypto: "crypto",
    cryptocurrency: "crypto",
    economics: "economics",
    economy: "economics",
    business: "economics",
    science: "science-tech",
    tech: "science-tech",
    technology: "science-tech",
    weather: "weather",
    "pop-culture": "pop-culture",
    "pop culture": "pop-culture",
    entertainment: "pop-culture",
    culture: "pop-culture",
  };
  if (gamma && direct[gamma]) return direct[gamma];

  const haystack = `${market?.question ?? title ?? ""} ${market?.slug ?? slug ?? ""}`;
  for (const { category, patterns } of CATEGORY_KEYWORDS) {
    if (patterns.some((p) => p.test(haystack))) return category;
  }
  return "other";
}

/**
 * Derive correlation keys for a market so the analytics layer can detect when
 * open positions are exposed to the same underlying event. Two positions sharing
 * any non-trader key are correlated beyond simple diversification.
 */
export interface CorrelationKeys {
  /** Same event/condition. */
  event: string;
  /** Same sports match ("teama-vs-teamb"), when detectable. */
  match: string | null;
  /** Same league/competition, when detectable. */
  league: string | null;
  /** Same election cycle, when detectable. */
  election: string | null;
  /** Resolution-date bucket (YYYY-MM-DD), when known. */
  resolutionDate: string | null;
}

const LEAGUE_RE = /\b(nfl|nba|mlb|nhl|ncaa|epl|uefa|fifa|ufc|f1|premier league|la liga|serie a|bundesliga|champions league)\b/i;
const ELECTION_RE = /\b(\d{4})\b.*\b(election|presidential|senate|primary|midterm)\b/i;
const MATCH_RE = /\b([a-z][a-z .'-]{2,30}?)\s+(?:vs\.?|@|versus)\s+([a-z][a-z .'-]{2,30})\b/i;

/** Text/date-based correlation-key inference (storage-agnostic). */
export function inferCorrelationKeys(
  text: string,
  conditionId: string,
  resolvesAt: string | null,
): CorrelationKeys {
  const leagueMatch = text.match(LEAGUE_RE);
  const electionMatch = text.match(ELECTION_RE);
  const matchMatch = text.match(MATCH_RE);

  let match: string | null = null;
  if (matchMatch) {
    const teams = [matchMatch[1], matchMatch[2]]
      .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))
      .sort();
    match = teams.join("--vs--");
  }

  let resolutionDate: string | null = null;
  if (resolvesAt) {
    const d = new Date(resolvesAt);
    if (!Number.isNaN(d.getTime())) resolutionDate = d.toISOString().slice(0, 10);
  }

  return {
    event: conditionId,
    match,
    league: leagueMatch ? leagueMatch[1].toLowerCase() : null,
    election: electionMatch ? `${electionMatch[1]}-${electionMatch[2].toLowerCase()}` : null,
    resolutionDate,
  };
}

export function correlationKeys(market: Market | null, conditionId: string, title?: string): CorrelationKeys {
  const text = `${market?.question ?? title ?? ""} ${market?.slug ?? ""}`;
  return inferCorrelationKeys(text, market?.conditionId || conditionId, market?.endDate ?? null);
}
