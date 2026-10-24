# Turnike

**One wallet, every city's turnstile.** Pay-per-trip public transit on Monad Testnet.

A tourist (or anyone from another city) should not need a new card and a top-up just to ride once. Here one phone
wallet works at every city's turnstile: scan the station QR to tap in, scan another to tap out, and the fare (by
distance) is paid straight to that city's operator. A turnstile cannot wait 12 seconds for a block; on Monad a tap
confirms in well under a second.

> **Status:** testnet demo. Runs fully on **localhost** (no Vercel, no external wallet connection).
> Turkish and English UI. Demo script: [DEMO.md](DEMO.md).

## Contents

- [Features](#features)
- [Why Monad](#why-monad)
- [Architecture](#architecture)
- [Quick start (localhost)](#quick-start-localhost)
- [Configuration](#configuration)
- [Pages and URLs](#pages-and-urls)
- [Smart contract](#smart-contract)
- [Testing](#testing)
- [Deploying the contract](#deploying-the-contract)
- [Wallets](#wallets)
- [Honest limits](#honest-limits)
- [Troubleshooting](#troubleshooting)

## Features

- **One balance, many cities.** A rider adds money once; every operator (Ankara, Istanbul) reads the same balance.
- **Priced in lira, paid in MON.** Tariffs are in lira cents; the contract converts with an owner-set rate
  (`weiPerCent`, a stand-in for a price oracle), so a ticket costs the same in lira whatever MON does.
- **Fare by distance.** `fare = min(base + |zoneA − zoneB| × perZone, max)`, paid to the operator of that city.
- **Transfers.** Tapping in again at the same operator within its transfer window skips the base fare.
- **Daily cap.** An operator can cap what one rider pays per day.
- **Forgot to tap out?** The next tap-in charges that trip's maximum fare as a penalty. A trip open for more than
  4 hours is charged the maximum at tap-out, and anyone can close it with `expire`.
- **Refunds and a kill switch.** An operator admin can refund a rider out of that operator's earnings; the owner can
  pause new trips (riders can still tap out and withdraw).
- **No gas for riders.** A rider signs an EIP-712 request locally (no popup); a sponsor wallet submits it (`relay`)
  and pays the gas, so a new rider needs no crypto.
- **Easy top-up.** Pick an amount and pay by (simulated) card.
- **Recoverable wallet.** New wallets come from a 12-word phrase that can be shown, downloaded and restored on any
  device; older single-key wallets still work.
- **Rotating station QR.** The gate screen shows a QR that changes every ~20 s (HMAC, verified by `/api/qr`).
- **Gate opens on confirmation.** Each turnstile on the gate screen opens only when its `TapIn`/`TapOut` event is
  confirmed on chain.
- **Demo mode.** With no contract address set, an in-browser simulated chain runs the whole app.

## Why Monad

- Tap confirmation is measured on the phone and shown in ms. A direct transaction confirmed in 376–407 ms; a sponsored
  (gas-free) tap, which adds a signature and one server hop, in about 0.7–1.2 s. Both are far from a 12 s block.
- **Parallel-friendly contract.** No global counters on the tap path. Operator earnings are split into 16 shards chosen
  by rider address, so simultaneous taps do not write the same storage slot; a rider's daily total and nonce live in
  that rider's own slots. Gate stats come from events.
- Measured on testnet: 9 wallets tapped in at the same moment and out at the same moment: 18 taps in 4 blocks, up to
  8 in one block, 2.3 s total, all successful (`web/public/stress.json`, `npm run stress`).

## Architecture

```
rider phone ──sign EIP-712──► /api/relay ──► sponsor wallet ──► Turnike contract (Monad Testnet)
     │                            ▲                                      │
     └── scan station QR ◄── /api/qr (rotating HMAC) ◄── gate screen ◄───┘ events (TapIn / TapOut)
```

```
src/Turnike.sol           the contract (operators, stations, balances, trips, fares, relay, sharded earnings)
test/Turnike.t.sol        23 Foundry tests
script/Deploy.s.sol       deploys and registers Ankara and Istanbul (3 stations each)
setup.sh                  deploys and writes web/.env.local
web/                      Vite + React + TypeScript + viem
  src/pages/Rider.tsx       phone app: tap in/out, penalty, top-up, withdraw, history, backup
  src/pages/Gate.tsx        turnstile screen: station QRs, gate state, live feed, stats
  src/pages/Operator.tsx    operator console: earnings, claim, tariff, printable QR sheet
  src/lib/                  chain/clients, wallet, i18n, demo chain (mock.ts), QR, relay client
  api/relay.ts              verifies a rider's signature and submits it (sponsor pays gas)
  api/topup.ts              simulated card top-up (no payment is collected)
  api/claim.ts              pays out an operator's earnings (sponsor pays the gas)
  api/qr.ts                 rotating QR: mint (gate) and verify (rider)
  scripts/admin.ts          owner / operator-admin commands from the command line
  shared/typed.ts           the EIP-712 request shared by the app and the API
  scripts/stress.ts         real load test (also recovers its own test wallets)
  scripts/check-eip712.ts   checks the client's signature hash against the deployed contract
  tests/                    48 Vitest tests
```

The `api/*.ts` handlers are plain functions. During `npm run dev`, a small Vite plugin in
[web/vite.config.ts](web/vite.config.ts) serves them at `/api/*`, so no hosting platform is needed.

## Quick start (localhost)

```bash
git clone https://github.com/emirmusakaraduman/turnike-transit-wallet-hackathon.git
cd turnike-transit-wallet-hackathon
```

(For contract tests, install forge-std first: `forge install foundry-rs/forge-std`.)

Requirements: Node 20+. Foundry only if you work on the contract.

```bash
cd web
npm install
npm run dev
```

Open http://localhost:5173.

- **Demo mode (no chain, no keys):** set `VITE_TURNIKE_ADDRESS=0x0000000000000000000000000000000000000000`
  (e.g. in `web/.env.local`). Everything runs on a simulated in-browser chain.
- **Live mode:** use the values in `web/.env.local` (see below). The dev server reads that file and the API handlers
  talk to Monad Testnet through the sponsor wallet.

## Configuration

`web/.env.local` (never committed):

| Variable | Purpose |
| --- | --- |
| `VITE_TURNIKE_ADDRESS` | Deployed contract address (zero address = demo mode) |
| `VITE_RPC_URL` | Monad Testnet RPC (falls back to public endpoints) |
| `FAUCET_PRIVATE_KEY` | Sponsor wallet: pays rider gas and funds demo top-ups. Keep it funded. `RELAYER_PRIVATE_KEY` overrides it |
| `QR_SECRET` | HMAC secret for the rotating station QR |
| `GATE_KEY` | Key required to mint QRs on the gate screen |
| `QR_REQUIRED=1` | Optional: make the rotating QR mandatory |

Network: Monad Testnet, chain id 10143, contract `0x5f3b429352f991f3b3bcc265b2f85bfba750c593`.

## Pages and URLs

| URL | Who | What |
| --- | --- | --- |
| `/#/rider` (default) | Rider | Tap in/out, balance, top-up, withdraw, history, backup |
| `/#/gate?key=<GATE_KEY>` | Station projector | Turnstiles, rotating QRs, live feed, stats |
| `/#/operator` | Operator | Earnings, tariffs, printable QR sheet |

## Smart contract

`src/Turnike.sol` holds deposits, runs trips and splits payments. Key calls: `depositFor`, `tapIn`, `tapOut`,
`relay` (signed, sponsored), `withdrawTo`, `expire`, `claim` (operator earnings), `pause`/`unpause`, `setRate`.

```bash
forge test        # 23 contract tests
```

## Testing

```bash
cd web
npx tsc --noEmit  # typecheck
npm test          # 48 Vitest tests: fares, translations, demo chain, wallet recovery, QR, API
npm run build     # typecheck + production build into web/dist
npm run stress    # real load test on testnet (needs the funded sponsor key)
```

## Deploying the contract

```bash
PRIVATE_KEY=0x... ./setup.sh     # deploys, registers Ankara + Istanbul, writes web/.env.local
cd web && npm run check:eip712   # after every deploy: client and contract must hash the request identically
```

## Wallets

- The rider's app wallet is a key kept in the browser, created from a 12-word phrase. **Back it up** from the app:
  clearing site data loses it.
- **External wallet connections (MetaMask, Rabby, …) are turned off.** The switch is
  `WALLET_CONNECT_ENABLED` in [web/src/lib/injected.ts](web/src/lib/injected.ts); set it to `true` to bring back
  "pay from my wallet" top-ups and the in-browser admin panel on the operator console.
- Operator earnings are claimed from the operator console through the sponsor wallet (`/api/claim`; the money always
  goes to the operator's own payout address). Owner and operator-admin actions run from the command line, signed by the
  owner key in `.deployer.env`:

  ```bash
  cd web
  npm run admin -- status                       # owner, paused, rate, operators
  npm run admin -- pause                        # stop new trips (riders can still tap out and withdraw)
  npm run admin -- unpause
  npm run admin -- rate 10000000000000          # wei per lira cent (1 lira = 0.001 MON here)
  npm run admin -- refund 1 0xRider 0.01        # operator 1 refunds a rider out of its earnings
  ```
- Never commit `.env.local`, `.deployer.env` or `.stress-wallets*.json` (all gitignored).
- **Status of the keys:** the deployer key (contract owner) and the sponsor key were deleted after the demo funds were
  moved out, so right now the app cannot pay riders' gas or credit demo top-ups, and `pause`/`rate`/`refund` cannot be
  run. The contract itself (and riders' balances in it) is untouched. To bring the app back, deploy a new contract with a
  new funded key (`PRIVATE_KEY=0x... ./setup.sh`); the old contract's owner functions are gone for good.

## Honest limits

- **No physical turnstile.** The gate screen simulates it by reacting to confirmed events; a real controller would too.
- **The card payment is simulated.** `/api/topup` credits a rider without charging anyone. A real deployment would
  call it only after a payment provider confirms the charge.
- **The lira rate is set by hand** (`setRate`), not by a real oracle.
- **One sponsor wallet** sends every sponsored transaction in nonce order, so it is a throughput ceiling and a budget.
  A pool of relayers removes the ceiling.
- **QR freshness is checked by the server**, not on chain; calling the contract directly skips it. An on-chain station
  signature is the next step.
- **Public RPC quirks.** The node estimates ~1M gas for `withdraw` and Monad charges the gas limit, so withdrawals use a
  fixed limit. A brand-new account's first transaction can be rejected for a while; sponsored mode avoids this.
- **The load test was small** (9 wallets) because of public RPC rate limits (about 20 requests per second).
- **The demo chain** models fares, penalties and transfers; daily caps, pause and refunds exist only on the real contract.

## Troubleshooting

- *API calls return 500 in dev:* check `web/.env.local` exists and the sponsor wallet has MON.
- *"sponsor wallet is out of funds":* top up the `FAUCET_PRIVATE_KEY` address from the Monad testnet faucet.
- *Blank balance after restore:* wait a moment; the app polls the chain until the deposit shows.
