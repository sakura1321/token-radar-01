// The radar's model: a sealed DefiLlama snapshot goes in, a ranked board of
// pre-token protocols comes out. Everything the board claims is derived from
// the snapshot's own ten fields per protocol; no protocol is ever named in
// this file, and the same code scores every row.
//
// Who is on the board
//   The snapshot's watchlist is the floor: all 40 of its slugs are ranked.
//   Below the floor the radar adds every other protocol that records no token
//   (no CoinGecko id, no symbol, no market cap) once the house's own
//   exclusions are applied to it: bridge, canonical bridge, liquid staking,
//   liquid restaking, restaked BTC and exchange categories are out, as are
//   names ending in a version marker, names carrying the whole words wrapped,
//   staked or staking, and names beginning with an exchange's name. Those are
//   products of tokens that already trade, not launches still to come. On
//   this snapshot that leaves 158 early rows beside the 40 watchlist rows.
//
// What a launch would be worth
//   Protocols whose token already trades report a market cap, so the snapshot
//   itself says what the market pays per dollar of TVL, category by category:
//
//     multiple(category) = median of mcap_usd / tvl_usd over the category's
//                          tokenised protocols, each ratio first winsorised
//                          to [0.005, 5] so one freak ratio cannot rule a
//                          category, then shrunk toward the global median
//                          with a weight of 5 phantom protocols, and finally
//                          clamped to [0.02, 3].
//     growth factor      = 1 + clamp(change_7d, -30, +60) / 100 x 0.5
//     age factor         = 1 + 0.30 x min(age in days, 1461) / 1461, where
//                          age runs from listed_at to the snapshot's as_of,
//                          and a protocol with no listed_at is given the
//                          snapshot's own median tracked age.
//     implied value      = round(tvl_usd x multiple x growth x age)
//
//   Ranks sort by implied value, ties by TVL then slug, and a final pass
//   steps any repeated value down a dollar at a time so the ranking is
//   strict: rank 1 is the board's most valuable protocol and no two rows
//   share a number.

/** One protocol of the snapshot: exactly the ten fields the sealed file carries. */
export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** The model's fixed constants, restated on the dashboard so a reader can re-run the arithmetic. */
export const MODEL = {
  version: 'catmed-1',
  ratio_floor: 0.005,
  ratio_cap: 5,
  shrink_weight: 5,
  multiple_min: 0.02,
  multiple_max: 3,
  growth_low: -30,
  growth_high: 60,
  growth_weight: 0.5,
  age_cap_days: 1461,
  age_bonus: 0.3,
  extra_min_tvl: 5_000_000,
  live_rows: 30,
} as const;

/** The value model's calibration, computed from the snapshot's tokenised protocols. */
export interface Calibration {
  /** The multiple each category uses, with the sample it was drawn from. */
  by_category: Map<string, { multiple: number; sample: number }>;
  /** The median winsorised mcap/TVL ratio across every tokenised protocol. */
  global_multiple: number;
  /** How many tokenised protocols the calibration read. */
  tokenised_count: number;
  /** The age given to a protocol whose listed_at is missing: the snapshot's median tracked age. */
  fallback_age_days: number;
}

/** The parts of one row's implied value, kept so the dashboard can show the arithmetic. */
export interface ValueParts {
  multiple: number;
  multiple_sample: number;
  growth_factor: number;
  age_factor: number;
  age_days: number | null;
  implied_value_usd: number;
}

/** One row of board.json. */
export interface BoardRow extends ValueParts {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  on_watchlist: boolean;
  farm_steps: string[];
}

/** A protocol whose token already trades: set aside from the ranking, shown at the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  mcap_tvl: number;
}

/** Everything data.js hands the dashboard. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: {
    version: string;
    global_multiple: number;
    tokenised_count: number;
    shrink_weight: number;
    ratio_floor: number;
    ratio_cap: number;
    multiple_min: number;
    multiple_max: number;
    growth_low: number;
    growth_high: number;
    growth_weight: number;
    age_cap_days: number;
    age_bonus: number;
    fallback_age_days: number;
  };
  stats: {
    protocols: number;
    ranked: number;
    watchlist_covered: number;
    watchlist_total: number;
    early_rows: number;
    total_implied_usd: number;
    live_shown: number;
  };
  categories: string[];
  chains: string[];
  rows: BoardRow[];
  live: LiveRow[];
}

/** Why a snapshot cannot be scored. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const bySlugOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whole days from a protocol's listed_at to the snapshot date; null when either is unusable. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** A protocol records no token when all three of the snapshot's token fields are empty. */
export function recordsNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null && p.mcap_usd === null;
}

/** Categories that are products of a token that already trades, per the house's watchlist rule. */
const PRODUCT_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** A name ending in a release marker is one protocol's newer pool, not a launch of its own. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product of another asset. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Exchange names a product may begin with. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Whether a pre-token protocol below the watchlist may join the board: the
 * house's exclusion logic, applied to the fields the snapshot carries.
 */
export function passesExclusions(p: Protocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  for (const exchange of EXCHANGE_NAMES) {
    if (p.name === exchange || p.name.startsWith(`${exchange} `)) return false;
  }
  return true;
}

/** Calibrate the value model from the snapshot's own tokenised protocols. */
export function calibrate(snapshot: Snapshot): Calibration {
  const tokenised = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const ratios = tokenised.map((p) => clamp(p.mcap_usd! / p.tvl_usd, MODEL.ratio_floor, MODEL.ratio_cap));
  const globalMultiple = ratios.length > 0 ? median(ratios) : 0;

  const grouped = new Map<string, number[]>();
  tokenised.forEach((p, i) => {
    const key = p.category ?? 'Uncategorised';
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [ratios[i]!]);
    else list.push(ratios[i]!);
  });
  const byCategory = new Map<string, { multiple: number; sample: number }>();
  for (const [category, list] of grouped) {
    const shrunk = (list.length * median(list) + MODEL.shrink_weight * globalMultiple) / (list.length + MODEL.shrink_weight);
    byCategory.set(category, { multiple: round4(clamp(shrunk, MODEL.multiple_min, MODEL.multiple_max)), sample: list.length });
  }

  const ages = snapshot.protocols
    .map((p) => ageInDays(snapshot.as_of, p.listed_at))
    .filter((a): a is number => a !== null);
  const fallbackAge = ages.length > 0 ? Math.round(median(ages)) : 365;
  return { by_category: byCategory, global_multiple: round4(globalMultiple), tokenised_count: tokenised.length, fallback_age_days: fallbackAge };
}

/** The growth factor one protocol earns from its seven-day TVL change. */
export function growthFactor(change7d: number | null): number {
  const change = clamp(change7d ?? 0, MODEL.growth_low, MODEL.growth_high);
  return round4(1 + (change / 100) * MODEL.growth_weight);
}

/** The age factor: a mild bonus for every day a protocol has run while recording no token. */
export function ageFactor(ageDays: number | null, fallbackAgeDays: number): number {
  const age = ageDays ?? fallbackAgeDays;
  return round4(1 + MODEL.age_bonus * (Math.min(age, MODEL.age_cap_days) / MODEL.age_cap_days));
}

/** Score one protocol: its category multiple, its two factors and the implied value they produce. */
export function score(p: Protocol, snapshot: Snapshot, cal: Calibration): ValueParts {
  const entry = cal.by_category.get(p.category ?? 'Uncategorised');
  const multiple = entry?.multiple ?? cal.global_multiple;
  const growth = growthFactor(p.change_7d);
  const age = ageInDays(snapshot.as_of, p.listed_at);
  const ageF = ageFactor(age, cal.fallback_age_days);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growth * ageF));
  return {
    multiple,
    multiple_sample: entry?.sample ?? 0,
    growth_factor: growth,
    age_factor: ageF,
    age_days: age,
    implied_value_usd: implied,
  };
}

/**
 * The protocols the board ranks: the whole watchlist, then every other
 * pre-token protocol at or above $5M of TVL that passes the exclusions,
 * strongest TVL first.
 */
export function selectProtocols(snapshot: Snapshot): Protocol[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, Protocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && recordsNoToken(p) && p.tvl_usd >= MODEL.extra_min_tvl && passesExclusions(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || bySlugOrder(a.slug, b.slug));
  for (const p of early) chosen.set(p.slug, p);
  return [...chosen.values()];
}

// ---------------------------------------------------------------- farm plans
//
// A plan is five steps, each one string carrying its action, its cost and its
// time. The wording is templated by category family, but every number in it
// (the capital, the gas, the weeks) is computed from the protocol's own
// record: its TVL tier, its primary chain's gas class and its age.

/** What one transaction costs in gas, in dollars, on a chain: mainnet is dear, rollups and Solana are not. */
const CHAIN_GAS: Record<string, number> = {
  Ethereum: 12,
  Bitcoin: 3,
  Tron: 1.5,
  Avalanche: 0.35,
  Binance: 0.25,
  Polygon: 0.05,
  Solana: 0.05,
  Sui: 0.05,
  Arbitrum: 0.15,
  Base: 0.1,
  Optimism: 0.1,
  Linea: 0.15,
  Scroll: 0.15,
  Mantle: 0.1,
  'zkSync Era': 0.15,
  Starknet: 0.1,
};

function gasFor(chain: string): number {
  return CHAIN_GAS[chain] ?? 0.5;
}

/** Dollars with no cents for whole amounts, two decimals under ten dollars. */
function usd(n: number): string {
  return n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

/** How much working capital a farm position on this protocol should carry, from its TVL tier. */
function capitalFor(tvl: number): number {
  if (tvl >= 2_000_000_000) return 400;
  if (tvl >= 500_000_000) return 250;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 25_000_000) return 90;
  return 50;
}

/** How many weeks the plan runs, from the protocol's age: younger protocols get the longer runway. */
function weeksFor(ageDays: number | null): number {
  if (ageDays === null) return 8;
  if (ageDays < 365) return 10;
  if (ageDays < 730) return 8;
  return 6;
}

/** The step-2 action for a category family, in words a farmer can follow. */
function coreAction(category: string | null, name: string, chain: string, capital: number): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') && !c.includes('uncollateral')) {
    return `Supply ${usd(capital)} of USDC to ${name}'s main lending market on ${chain} and borrow no more than 30% against it, so the wallet works both sides of the book while keeping a wide liquidation buffer.`;
  }
  if (c.includes('uncollateral')) {
    return `Take one undercollateralised loan line of about ${usd(capital)} through ${name} on ${chain} and repay it inside the first term: a clean repayment record is the history this kind of protocol keeps.`;
  }
  if (c.includes('dex') || c.includes('liquidity')) {
    return `Add ${usd(capital)} of liquidity to ${name}'s busiest pair on ${chain}, split evenly across the two assets, and leave the position in place between weekly checks instead of chasing pools.`;
  }
  if (c.includes('derivative') || c.includes('perpetual')) {
    return `Post ${usd(capital)} as margin on ${name} and run one small hedged position at a time, long spot elsewhere against a short perp, trading modest notional at low leverage so funding and fees stay small.`;
  }
  if (c.includes('cdp')) {
    return `Open a vault on ${name} with ${usd(capital)} of collateral on ${chain}, mint its stablecoin at a conservative ratio that keeps the health factor above 2, and hold the minted asset inside the same ecosystem.`;
  }
  if (c.includes('bridge')) {
    return `Bridge ${usd(capital)} through ${name} to ${chain} and straight back over the plan, two crossings a month, using the bridged funds in one app on the far side each time rather than letting them sit.`;
  }
  if (c.includes('restak') || c.includes('staking')) {
    return `Restake or stake ${usd(capital)} of the chain's staking asset through ${name} on ${chain} and keep the receipt position untouched, so the balance is present at every weekly snapshot the protocol might take.`;
  }
  if (c.includes('yield') || c.includes('farm') || c.includes('curator') || c.includes('allocator') || c.includes('basis')) {
    return `Deposit ${usd(capital)} into ${name}'s flagship vault on ${chain} and let the strategy compound: the flagship, not the highest-APY side vault, is the product a launch would be built around.`;
  }
  if (c.includes('rwa')) {
    return `Complete ${name}'s onboarding checks on ${chain} and mint ${usd(capital)} of its tokenised real-world asset, then hold it in the farm wallet for the whole plan rather than trading in and out.`;
  }
  if (c.includes('stable') || c.includes('algo')) {
    return `Mint or buy ${usd(capital)} of ${name}'s stable asset on ${chain} and hold it, or supply it to the protocol's own stability pool, so the wallet is a holder and not only a passer-through.`;
  }
  if (c.includes('prediction')) {
    return `Fund ${usd(capital)} on ${name} and take small positions in two or three liquid markets a week, sized so no single market can cost more than a tenth of the stake.`;
  }
  if (c.includes('insurance')) {
    return `Put ${usd(capital)} into ${name}'s underwriting pool on ${chain}, or buy cover on a position held elsewhere: underwriting capital is the side of this protocol that stays longest.`;
  }
  if (c.includes('chain')) {
    return `Bridge ${usd(capital)} onto ${name}'s network and use two or three of its native apps each week, so the wallet's history is ordinary activity on the chain itself.`;
  }
  if (c.includes('launchpad')) {
    return `Take part in one launch on ${name} with about ${usd(capital)} and hold whatever it allocates for the rest of the plan instead of flipping it on the first day.`;
  }
  if (c.includes('payment')) {
    return `Route real payments totalling about ${usd(capital)} a month through ${name} on ${chain}, paying an invoice or moving money between your own accounts, so the volume is genuine use.`;
  }
  if (c.includes('index')) {
    return `Mint ${usd(capital)} of ${name}'s index basket on ${chain} and hold it whole: do not split the basket apart, the position that counts is the basket itself.`;
  }
  return `Put ${usd(capital)} to work in ${name}'s core product on ${chain}, the deposit, position or balance its own interface is built around, and keep it there for the whole plan.`;
}

/** The five-step farm plan for one protocol, every figure drawn from its own record. */
export function farmSteps(p: Protocol, ageDays: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = gasFor(chain);
  const capital = capitalFor(p.tvl_usd);
  const weeks = weeksFor(ageDays);
  const weeklyGas = gas * 2;
  const steps = [
    `Open a fresh wallet for ${p.name} and fund it on ${chain} with ${usd(capital)} of working capital plus about ${usd(gas * 4)} of gas float. A separate wallet keeps this farm legible and caps the damage if a front end is ever compromised. Cost: about ${usd(gas)} in gas to fund and approve. Time: 20 minutes, once.`,
    `${coreAction(p.category, p.name, chain, capital)} Cost: ${usd(capital)} of capital at work plus about ${usd(gas)} in gas. Time: 15 minutes to open, then the position runs itself.`,
    `Repeat one qualifying action every week for ${weeks} weeks: a top-up, a rebalance or a second product inside ${p.name}, always from the same wallet, so the history reads as one steady user rather than a single burst. Cost: about ${usd(weeklyGas)} in gas a week, ${usd(weeklyGas * weeks)} across the plan. Time: 10 minutes a week for ${weeks} weeks.`,
    `${p.name} records no token yet, so watch the two places a launch would surface first: its official announcements and, where it runs one, its points or governance page. Check both weekly and note any snapshot or eligibility post the day it lands. Cost: nothing. Time: 5 minutes a week.`,
    `Set a review date ${weeks} weeks out. If ${p.name} has announced nothing by then, unwind to USDC on ${chain} in one session and redeploy the capital to the next protocol on this board; if it has announced a launch, follow only the instructions on its official page. Cost: about ${usd(gas)} in gas to exit. Time: 30 minutes, once.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 597)}...` : s));
}

/** Rank the selected protocols into the board: ranks 1..N, implied values strictly falling. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const cal = calibrate(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const scored = selectProtocols(snapshot).map((p) => ({ p, parts: score(p, snapshot, cal) }));
  scored.sort(
    (a, b) =>
      b.parts.implied_value_usd - a.parts.implied_value_usd ||
      b.p.tvl_usd - a.p.tvl_usd ||
      bySlugOrder(a.p.slug, b.p.slug),
  );
  let previous = Number.POSITIVE_INFINITY;
  return scored.map(({ p, parts }, i) => {
    const implied = Math.max(1, Math.min(parts.implied_value_usd, previous - 1));
    previous = implied;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      on_watchlist: watchlist.has(p.slug),
      multiple: parts.multiple,
      multiple_sample: parts.multiple_sample,
      growth_factor: parts.growth_factor,
      age_factor: parts.age_factor,
      age_days: parts.age_days,
      implied_value_usd: implied,
      farm_steps: farmSteps(p, parts.age_days),
    };
  });
}

/** The largest tokenised protocols by market cap, set aside from the ranking. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || bySlugOrder(a.slug, b.slug))
    .slice(0, MODEL.live_rows)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      mcap_tvl: p.tvl_usd > 0 ? round4(p.mcap_usd! / p.tvl_usd) : 0,
    }));
}

/** The whole dashboard dataset from one snapshot. */
export function buildData(snapshot: Snapshot): { board: BoardRow[]; data: RadarData } {
  const board = buildBoard(snapshot);
  const cal = calibrate(snapshot);
  const live = liveRows(snapshot);
  const categories = [...new Set(board.map((r) => r.category ?? 'Uncategorised'))].sort();
  const chains = [...new Set(board.flatMap((r) => r.chains))].sort();
  const data: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      version: MODEL.version,
      global_multiple: cal.global_multiple,
      tokenised_count: cal.tokenised_count,
      shrink_weight: MODEL.shrink_weight,
      ratio_floor: MODEL.ratio_floor,
      ratio_cap: MODEL.ratio_cap,
      multiple_min: MODEL.multiple_min,
      multiple_max: MODEL.multiple_max,
      growth_low: MODEL.growth_low,
      growth_high: MODEL.growth_high,
      growth_weight: MODEL.growth_weight,
      age_cap_days: MODEL.age_cap_days,
      age_bonus: MODEL.age_bonus,
      fallback_age_days: cal.fallback_age_days,
    },
    stats: {
      protocols: snapshot.protocols.length,
      ranked: board.length,
      watchlist_covered: board.filter((r) => r.on_watchlist).length,
      watchlist_total: snapshot.watchlist.length,
      early_rows: board.filter((r) => !r.on_watchlist).length,
      total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
      live_shown: live.length,
    },
    categories,
    chains,
    rows: board,
    live,
  };
  return { board, data };
}

/** The snapshot parsed out of a file's text, refused unless it has the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json carries no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json carries no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json carries no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json carries no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json carries no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why this board is not one the gate takes, or null when it is. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
  }
  for (const slug of snapshot.watchlist) if (!seen.has(slug)) return `watchlist slug ${slug} is missing`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is held by ${byRank[i]!.slug} with rank ${byRank[i]!.rank}`;
    if (i > 0 && byRank[i]!.implied_value_usd >= byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} does not fall below rank ${i}`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** data.js: the dashboard's dataset as one script, read from disk, never fetched. */
export function dataScript(data: RadarData): string {
  return `window.RADAR=${JSON.stringify(data)};\n`;
}
