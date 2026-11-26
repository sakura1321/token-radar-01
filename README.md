# Token Radar — a token launch radar for make.fun's token-radar-01 bounty

A program and a static dashboard that read the sealed DefiLlama snapshot of
758 protocols, rank the ones that record no token yet by an implied launch
value, and give each one a concrete farm plan.

## The board

- All 40 protocols on the snapshot's watchlist are ranked — the watchlist is
  the floor, never the ceiling.
- Below the floor, every other pre-token protocol at or above $5M TVL joins
  the board once the house's own exclusions are applied (bridge, canonical
  bridge, liquid staking, liquid restaking, restaked BTC and exchange
  categories; versioned names; wrapped/staked/staking names; names beginning
  with an exchange's name). On this snapshot that adds 158 early rows, for
  198 ranked protocols in all.
- Protocols whose token already trades are never ranked. They calibrate the
  model, and the dashboard's "Already trading" view lists the largest of
  them at the market's own values.

## The value model

Implied value is derived only from the snapshot's own figures:

- **Multiple.** For each category, the median market-cap/TVL ratio of its
  tokenised protocols, each ratio winsorised to [0.005, 5], shrunk toward
  the global median with a weight of 5 phantom protocols, clamped to
  [0.02, 3].
- **Growth.** `1 + clamp(change_7d, -30, +60) / 100 x 0.5`.
- **Age.** `1 + 0.30 x min(age_days, 1461) / 1461`, age running from
  `listed_at` to the snapshot date; a missing listing date is given the
  snapshot's median tracked age.

`implied = round(TVL x multiple x growth x age)`. Ranks sort by implied
value and fall strictly: ties are stepped down a dollar at a time. The
dashboard restates the formula and shows each protocol's own three factors
in its detail view.

## Farm plans

Five steps per protocol, each carrying its cost and its time. The wording is
templated by category family; every figure in it — the working capital, the
gas, the weeks — is computed from the protocol's own TVL tier, primary
chain and age. No step promises a token or an airdrop.

## Run it

Node 22.18 or later, standard library only, no network:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <dir holding snapshot.json>
```

Outputs: `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` (written with `buildDossier` from `vendor/makefun-board.ts`,
byte-identical to the scorer's rebuild). The program is deterministic: two
runs over the same snapshot write the same bytes.

## Layout

- `main.ts` — the program: snapshot in, outputs out.
- `lib/model.ts` — selection, the value model and the farm plans.
- `vendor/makefun-board.ts` — make.fun's dossier library, vendored unchanged.
- `dashboard/` — the static page (index.html, app.css, app.js); it renders
  offline from `data.js` and names no network address.
- `screenshots/` — three captures of the page at 1440x900: the board, one
  protocol's detail view, and a filtered view.
