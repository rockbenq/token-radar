// Token Radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and every
// other pre-token protocol that is not a wrapped, staked or bridged product of a token that already
// trades. A protocol is pre-token when its index entry records no token (no market cap, no
// CoinGecko id, no symbol); the snapshot's live-token protocols are kept apart and shown as the
// market's own values, never mixed into the ranked board.
//
// Implied value follows only from the snapshot's own figures, calibrated on the snapshot itself:
//
//   calibration  the protocols that already trade, with a real market cap and TVL (mcap_usd > 0
//                and tvl_usd > 0): their mcap/TVL ratios, by category. A row with mcap 0 or
//                negative is a dead token (Multichain, Autofarm, ...) and carries no pricing
//                signal, so it is left out of the calibration.
//   base         the category's median mcap/TVL where that category has at least 5 calibration
//                comps; otherwise the pooled median over the whole calibration sample. A thin
//                category never sets its own multiple from one or two observations: Risk Curators
//                has a single comp (Api3, 2.975) and would otherwise price every curator at
//                three times its TVL.
//   growth       = clamp(change_7d, -60, 120) per cent
//   growthMult   = 1 + (growth / 100) x 0.5
//   maturity     = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   implied      = max(1, round(tvl_usd x base x growthMult x maturity))
//
// The constants are the house model's growth and maturity weights, stated in the dashboard; the
// base multiple is the calibration above, computed from the snapshot at run time. No protocol name
// is ever special-cased: the same function scores every row.

const DAY_MS = 86_400_000;

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export function parseSnapshot(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not a JSON object');
  if (typeof raw.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.as_of)) throw new Error('snapshot.json has no as_of date');
  if (typeof raw.source !== 'string') throw new Error('snapshot.json has no source');
  if (typeof raw.floor_usd !== 'number' || !Number.isSafeInteger(raw.floor_usd) || raw.floor_usd <= 0) throw new Error('snapshot.json has no floor_usd');
  if (!Array.isArray(raw.protocols)) throw new Error('snapshot.json has no protocols array');
  if (!Array.isArray(raw.watchlist) || raw.watchlist.some((s) => typeof s !== 'string')) throw new Error('snapshot.json has no watchlist of slugs');
  const protocols = raw.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`snapshot.json's protocol ${i} is not an object`);
    if (typeof v.slug !== 'string' || typeof v.name !== 'string' || typeof v.tvl_usd !== 'number' || !Number.isFinite(v.tvl_usd)) {
      throw new Error(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: v.slug,
      name: v.name,
      category: typeof v.category === 'string' ? v.category : null,
      chains: Array.isArray(v.chains) ? v.chains.filter((c) => typeof c === 'string') : [],
      tvl_usd: v.tvl_usd,
      change_7d: typeof v.change_7d === 'number' && Number.isFinite(v.change_7d) ? v.change_7d : null,
      mcap_usd: typeof v.mcap_usd === 'number' && Number.isFinite(v.mcap_usd) ? v.mcap_usd : null,
      listed_at: typeof v.listed_at === 'string' ? v.listed_at : null,
      gecko_id: typeof v.gecko_id === 'string' ? v.gecko_id : null,
      symbol: typeof v.symbol === 'string' ? v.symbol : null,
    };
  });
  return { as_of: raw.as_of, source: raw.source, floor_usd: raw.floor_usd, protocols, watchlist: raw.watchlist };
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf, listedAt) {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** How many calibration comps a category needs before its own median is used. */
export const MIN_CATEGORY_COMPS = 5;

/** The growth and maturity weights, the house model's, as the dashboard states them. */
export const MODEL = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/**
 * The calibration: the snapshot's own listed protocols, priced by the market. A comp needs a real
 * market cap and TVL; a row with mcap 0 or negative is a dead token and is left out. Returns the
 * pooled median, the per-category medians with their sample sizes, and the sample size itself.
 */
export function calibrate(protocols) {
  const comps = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd !== null && p.tvl_usd > 0);
  const byCat = new Map();
  for (const p of comps) {
    const c = p.category ?? '(no category)';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(p.mcap_usd / p.tvl_usd);
  }
  const pooled = median(comps.map((p) => p.mcap_usd / p.tvl_usd));
  const cats = {};
  for (const [c, xs] of byCat) cats[c] = { n: xs.length, median: median(xs) };
  return { sample: comps.length, pooled, cats };
}

/** A category's base multiple: its own median where it has enough comps, else the pooled median. */
export function baseMultiple(category, cal) {
  const c = cal.cats[category ?? '(no category)'];
  if (c && c.n >= MIN_CATEGORY_COMPS) return { multiple: c.median, source: 'category', n: c.n };
  return { multiple: cal.pooled, source: 'pooled', n: cal.sample };
}

/** The multipliers and the implied value one protocol gets under the calibration. */
export function impliedValue(protocol, asOf, cal) {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = typeof protocol.change_7d === 'number' && Number.isFinite(protocol.change_7d) ? protocol.change_7d : 0;
  const growthPct = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
  const ageForModel = age ?? MODEL.unknown_age_days;
  const maturityMult = MODEL.maturity_floor + (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const base = baseMultiple(protocol.category, cal);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * base.multiple * growthMult * maturityMult));
  return { implied, base, growthPct, growthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** The categories that are a wrapped, staked or bridged product of another protocol's token. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** The exchanges whose name at the start of a protocol's name marks it as their product. */
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A whole word wrapped, staked or staking in a name marks a product of a token that trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p) {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or bridged
 * product of a token that already trades. This is the watchlist's own rule from the snapshot's
 * README (product categories, wrapped/staked names, exchange-prefixed names, versioned names),
 * applied to every row, not only the watchlist: WBTC is Bitcoin on Ethereum and Binance staked
 * ETH is ETH in a staking product, and neither is a protocol still waiting on a launch of its own.
 */
export function isBoardRow(p) {
  if (!isPreToken(p)) return false;
  if (PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  for (const e of EXCHANGES) if (p.name.startsWith(e)) return false;
  return true;
}

/** A farm step: the action, what it costs, and how long it takes. */
function stepText(step) {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p) {
  return p.chains.length > 0 ? p.chains[0] : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p) {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age) {
  if (age === null || age === undefined) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p, capital, chain) {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list.
 */
export function farmSteps(p, age) {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  return [
    { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: actionFor(p, capital, chain), cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
    { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' },
  ].map(stepText);
}

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot) {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot, cal) {
  const watchlist = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter((p) => isBoardRow(p))
    .map((p) => {
      const v = impliedValue(p, snapshot.as_of, cal);
      return { p, ...v };
    });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: watchlist.has(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: s.base.multiple,
      base_source: s.base.source === 'category' ? `category median (n=${s.base.n})` : `pooled median (n=${s.base.n})`,
      growth_pct: s.growthPct,
      growth_multiplier: Math.round(s.growthMult * 1e4) / 1e4,
      maturity_multiplier: Math.round(s.maturityMult * 1e4) / 1e4,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board, snapshot) {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i].implied_value_usd > board[i - 1].implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0].implied_value_usd === board[board.length - 1].implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0].implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/**
 * Everything the dashboard renders, from the snapshot and the calibration. Rows are compact arrays
 * so the dossier's text cap holds the whole board: [slug, name, category, chains, tvl, change_7d,
 * age_days, implied, watchlist]. Categories and chains are lookup tables the page shares.
 */
export function buildRadar(snapshot, cal, board, live) {
  const cats = [];
  const catIdx = new Map();
  const chains = [];
  const chainIdx = new Map();
  const catOf = (c) => {
    const name = c ?? 'Other';
    if (!catIdx.has(name)) { catIdx.set(name, cats.length); cats.push(name); }
    return catIdx.get(name);
  };
  const chainOfIdx = (cs) => cs.map((c) => {
    if (!chainIdx.has(c)) { chainIdx.set(c, chains.length); chains.push(c); }
    return chainIdx.get(c);
  });
  const rows = board.map((r) => [r.slug, r.name, catOf(r.category), chainOfIdx(r.chains), r.tvl_usd, r.change_7d, r.age_days, r.implied_value_usd, r.watchlist ? 1 : 0]);
  const liveRowsCompact = live.map((r) => [r.slug, r.name, catOf(r.category), chainOfIdx(r.chains), r.tvl_usd, r.mcap_usd, r.change_7d]);
  // The calibration table the model panel shows: every category the board or the live view uses,
  // with its sample size and the multiple the board scored it at. The multiple is stored at full
  // precision, not rounded for display: the page recomputes each row from this table and the
  // recompute must land on the board's own implied value, not a near neighbour of it.
  const calTable = cats.map((name) => {
    const key = name === 'Other' ? '(no category)' : name;
    const c = cal.cats[key];
    const n = c ? c.n : 0;
    const base = n >= MIN_CATEGORY_COMPS ? c.median : cal.pooled;
    return [name, n, base, n >= MIN_CATEGORY_COMPS ? 0 : 1];
  });
  const early = board.filter((r) => !r.watchlist).length;
  return {
    as: snapshot.as_of,
    src: snapshot.source,
    fl: snapshot.floor_usd,
    mv: MODEL_VERSION,
    wl: snapshot.watchlist.length,
    n: board.length,
    e: early,
    l: live.length,
    mo: { gw: MODEL.growth_weight, gf: MODEL.growth_floor, gc: MODEL.growth_cap, mf: MODEL.maturity_floor, mr: MODEL.maturity_range, md: MODEL.maturity_days, ua: MODEL.unknown_age_days },
    pm: cal.pooled,
    ps: cal.sample,
    cats,
    cal: calTable,
    chains,
    rows,
    live: liveRowsCompact,
  };
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar) {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
