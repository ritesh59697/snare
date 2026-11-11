# Snare

**Booby-trap a vault and log off. Strangers' raids still play out against traps nobody can see.**

Snare is a raid game for the [Zama Developer Program Season 5](https://www.zama.org/post/zama-developer-program-mainnet-season-5-confidential-gaming)
built on Zama's FHE protocol. You hide traps and loot in an 8×8 vault. Other players draw a route
through it and pay a ticket to run it. The contract walks every route over ciphertext while you are
offline, and nobody, including the raider, learns where an unfired trap is.

| | |
|---|---|
| Play | **https://snare-ashy.vercel.app** |
| Network | Sepolia testnet |
| Contract | [`0xc65D10862B242c2541E46296EBb4c5dc8F93a6B0`](https://sepolia.etherscan.io/address/0xc65D10862B242c2541E46296EBb4c5dc8F93a6B0) |
| Source | [`contracts/contracts/Snare.sol`](contracts/contracts/Snare.sol) |
| Tests | 30 passing on Zama's FHE mock (`cd contracts && npm test`) |
| Frontend | [`web/`](web), Vite + React, Zama relayer SDK |

## Why this game can't exist on a transparent chain

On a public blockchain a trap's position is public the moment it is stored. The usual workaround is
commit-reveal, but then the defender has to come back online to reveal every raid's result, or
publish the whole layout. Both kill the game.

Snare keeps the layout encrypted and lets the chain do the checking:

- **The defender can be offline.** Raids are evaluated by the contract against encrypted traps. The
  owner never signs anything after sealing the vault.
- **Unfired traps stay secret forever.** A raid reveals, to that raider only, the one tile they were
  caught on. Every other trap stays ciphertext, so the same vault can be raided again and again.
- **No one can preview a result.** The outcome is ciphertext inside the transaction, so a raider
  cannot simulate a run and revert if it goes badly.
- **House vaults nobody has seen.** Layouts drawn from on-chain encrypted randomness. Not the
  deployer, not the caller, nobody knows them until retirement.

If you made the state public, the game would reduce to reading storage and walking around the traps.

## How to play

1. **Rig a vault.** Place 7 traps and 3 stashes. The browser encrypts each position before it is
   sent; the stash deposit is taken from your encrypted gold.
2. **Raid.** Pick someone else's vault, draw a route from the bottom row to the top row and pay a
   50-gold ticket. Caught: the owner keeps your ticket. Escaped: your ticket comes back plus 100 gold
   for each stash you walked over.
3. **Scan** (10 gold). Privately ask "is there a trap (or loot) in this 3×3?" Only you can read the
   answer.
4. **Jams.** Every raid draws fresh encrypted randomness that disarms about a quarter of the traps
   for that raid only. A trap can click under you and let you live, which also tells you where it is.
5. **Retire and open the books.** The owner can retire at any time; anyone can once the vault expires
   or fills up. Retiring refunds unlooted stashes and makes the full history publicly decryptable.
   Anyone can then submit Zama's decryption proof, and the contract replays every raid in plaintext
   and refuses unless each one matches what the encrypted game decided at the time.

All numbers above come from [`contracts/config/game.json`](contracts/config/game.json) and are read
from the contract by the frontend.

## Confidentiality design

| Data | Stored as | Who can decrypt it, and when |
|---|---|---|
| Trap layout | one `euint64` bitmask | the owner; everyone after retirement |
| Each stash | one `euint64` bitmask | the owner; everyone after retirement |
| Gold balances | `euint64` | only that player |
| Raid route | plaintext `uint8[]` | public (a route is a choice, not a secret) |
| Tiles walked, traps that clicked, payout | `euint64` | that raider and the vault owner; everyone after retirement |
| Escaped or caught | `ebool` | that raider and the vault owner; everyone after retirement |
| Jam mask (randomness) | `euint64` | nobody until retirement |
| Scan answer | `ebool` | only the scanner |

Details that keep this honest:

- **Budgets hold by construction.** Each encrypted position becomes exactly one bit (`1 << tile`),
  and shifts wrap modulo 64, so an owner cannot hide extra traps and the contract needs no proof
  about the layout. Seven traps can never wall off an 8-wide grid, so every vault is beatable.
- **No leaks through reverts.** Encrypted balances never cause a revert. A raider who cannot pay the
  ticket is turned away inside the encrypted computation (they walk zero tiles); an owner who cannot
  cover the stash deposit gets empty stashes.
- **Stashes vanish silently.** Looting zeroes a stash's ciphertext. A later raider sees no change on
  chain, and a later loot scan simply stops finding it.
- **ACL on every handle.** Each ciphertext is granted to exactly the addresses in the table above.
  The in-app spy panel tries to decrypt the traps as a random stranger and shows the relayer
  refusing.

## Fairness

- **Randomness is on-chain.** House-vault layouts and every raid's jam mask come from
  `FHE.randEuint8` / `FHE.randEuint64` inside the transaction.
- **Every outcome is verifiable.** After retirement, `verifyReveal` checks the KMS decryption proof
  with `FHE.checkSignatures`, then replays each raid with `replayRoute` (a public, plaintext twin of
  the encrypted walk) and reverts on the first mismatch. The UI shows "Books verified" only after
  that transaction succeeds.
- **No owner tricks.** Layouts cannot change after sealing, so an owner cannot move a trap onto a
  route they have seen.

## Cost and limits

FHE work is metered in HCU per transaction. Snare uses bitmask operations (`and`, `or`, `select`,
scalar `ne`), which are among the cheapest, so a full raid is a single transaction.

| Measured on Zama's mock (with its real `HCULimit` contract) | Value |
|---|---|
| Longest allowed raid (20 tiles), global HCU | 6,994,905 (docs limit: 20,000,000) |
| Longest allowed raid, HCU depth | 1,944,065 (docs limit: 5,000,000) |
| Longest allowed raid, gas | 2,785,100 |

### Measured on Sepolia

One full round played by `npm run measure:sepolia` on 2026-11-10 (raw numbers in
[`contracts/reports/latency-sepolia.json`](contracts/reports/latency-sepolia.json)). Times include
waiting for the block and, for decryptions, for Zama's relayer.

| Step | Time | Gas |
|---|---|---|
| Encrypt a layout in the client | 6.8s | n/a |
| Create a vault | 8.3s | 3,425,336 |
| Scan, then decrypt the answer | 11.6s + 3.4s | 872,339 |
| Raid, then decrypt the outcome | 9.5s + 7.6s | 5,204,833 |
| Retire | 12.4s | 1,471,652 |
| Public decryption of the history, then on-chain replay | 4.4s + 8.4s | 745,976 |

In the browser, a raid takes about 16 seconds from click to the animated result. The app covers the
wait with the run animation; the board stays usable between raids.

## Run it locally

Requires Node 20+.

```bash
cd contracts && npm install && npm test
```

```bash
cd contracts && npx hardhat node
```

The node deploys Snare on start. In a second terminal:

```bash
cd web && npm install && cp .env.example .env.local
```

Fill in `.env.local` (the example lists every value; for a local node `VITE_LOCAL_FAUCET_KEY` can be
any funded Hardhat dev key), then:

```bash
cd web && npm run dev
```

The app makes a guest player in your browser, tops it up from the local faucet key, and needs no
wallet popups. Use the "new guest" button to play the owner and the raider side by side. On a local
chain, house vaults have a "skip to closing time" button so you can retire them.

## Deploy to Sepolia

```bash
cd contracts && cp .env.example .env
```

Set `MNEMONIC` and `SEPOLIA_RPC_URL` (or `INFURA_API_KEY`), fund account 0 with a little Sepolia ETH,
then:

```bash
cd contracts && npx hardhat deploy --network sepolia
```

```bash
cd contracts && npx hardhat --network sepolia snare:measure
```

```bash
cd web && npm run build:sepolia
```

The frontend reads the deployed address and ABI from `contracts/deployments/sepolia` (via
`web/scripts/sync.mjs`) and its public settings from `web/.env.sepolia`. `web/dist` is a static site.

### Hosting, and gas for guests

On the hosted site, a guest player gets test ETH automatically from a small gas drip
(`web/api/drip.js`, a serverless function), so nobody needs a faucet or a wallet to play. The drip
sizes each top-up from live fees and from the costliest transaction of the measured round, never
sends more than a small share of what its wallet holds, and skips players who already have enough.
If it can't help (for example when Sepolia fees spike), the app shows the address to fund, and a
browser wallet works too.

```bash
cd web && npm run package:sepolia
```

That builds the site and assembles `web/.site/snare`: the static files plus the drip function and
its generated settings. Upload that folder to Vercel. The drip needs one secret there, `DRIP_KEY`,
a testnet-only wallet holding a little Sepolia ETH; its limits are in `web/site.config.json`.

Two tasks help keep the live game ready:

```bash
cd contracts && npx hardhat --network sepolia snare:house
```

```bash
cd contracts && npx hardhat --network sepolia snare:fund --to <drip wallet> --eth 0.01
```

The first opens a house vault from account 0 (anyone can also do it with the "House vault" button);
the second refills the drip wallet.

## Project layout

```
contracts/
  contracts/Snare.sol      the game
  test/Snare.ts            30 tests on the FHE mock, including the replay check
  tasks/snare.ts           snare:measure, a timed full round on any network
  config/game*.json        game parameters per network
web/
  src/lib/fhe.ts           Zama relayer SDK (Sepolia) or Hardhat mock (local), same interface
  src/lib/game.ts          contract calls
  src/lib/grid.ts          plaintext mirror of the grid rules
  src/components/          board, raider, owner, books and spy views
```

## Known limits

- **Testnet only.** Gold has no value.
- **Routes are public.** Only layouts, outcomes and balances are private. A watcher can see which
  routes were tried, though not how they ended.
- **A raider learns what they touch.** Being caught reveals that tile to the raider, and a jammed
  trap that clicks reveals itself. That is part of the game.
- **Underfunded vaults look normal.** An owner without enough gold seals empty stashes; nobody can
  tell until retirement.
- **The owner can see their own vault's raids.** Owners can read each raid's outcome on their vault,
  by design.
