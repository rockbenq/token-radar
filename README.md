# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/rockbenq/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/rockbenq/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: 198 pre-token protocols ranked by implied launch value, calibrated on the snapshot's own listed protocols, with a farm plan for each. Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

## Run it

```sh
node main.ts --input /input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=0z63wcct&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

## How it works

The entry reads the sealed snapshot of 758 protocols (DefiLlama, as of 2026-11-14), calibrates a hybrid model on the snapshot's own listed protocols, and scores every pre-token protocol that is not a wrapped, staked or bridged product of a token that already trades.

- **Calibration.** 128 protocols carry a real market cap and TVL. Their median mcap/TVL is computed per category, and a category uses its own median only where it has at least 5 such comps; thinner categories fall back to the pooled median (0.2138). Rows with a market cap of 0 or less are dead tokens and carry no pricing signal.
- **Implied value.** `implied = round(TVL × base multiple × growth multiplier × maturity multiplier)`, where the growth multiplier is `1 + clamp(change_7d, -60, 120)/100 × 0.5` and the maturity multiplier is `0.6 + min(age_days, 1095)/1095 × 0.4` (unknown age = 365 days).
- **Board.** 198 rows: all 40 watchlist protocols plus every rankable pre-token protocol, ranked by implied value. Wrapped, staked and bridged products, exchanges and versioned pools are left out, with the reason stated on the board.
- **Farm plans.** Six steps per protocol, derived from the snapshot fields alone (category, chains, TVL, age): the action line is category-specific, capital is tiered by TVL, and the hold is set by age.
- **Labels.** "No token" means the snapshot records no token for a protocol — a fact about the snapshot, never a claim that the protocol will never issue one.

`main.ts` (Node 22, standard library only) writes `board.json` and `dossier.json`, and copies `dashboard/` and `screenshots/` to the output directory. The dashboard is a static page with no network: it reads `dashboard/data.js`, which `main.ts` writes from the same board. Locally, set `MAKEFUN_OUTPUT_DIR` to choose the output directory:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
```
