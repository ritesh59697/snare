import { type ContractTransactionReceipt, type Signer, ZeroAddress } from "ethers";
import { encryptTiles, publicDecrypt } from "./fhe";
import { network, provider, snare } from "./network";

export type Config = {
  starterGold: bigint;
  ticketPrice: bigint;
  scanPrice: bigint;
  stashValue: bigint;
  trapCount: number;
  stashCount: number;
  maxRouteLength: number;
  maxRaidsPerVault: number;
  vaultLifetime: number;
};

/** Mirrors Snare.Status. */
export const Status = { Active: 0, Retired: 1, Verified: 2 } as const;
export type Status = (typeof Status)[keyof typeof Status];

export type Vault = {
  id: number;
  owner: string;
  isHouse: boolean;
  expiresAt: number;
  status: Status;
  raidCount: number;
  traps: string;
  stashes: string[];
  remaining: string[];
  clearTraps: bigint;
  clearStashes: bigint[];
};

export type Raid = {
  index: number;
  raider: string;
  route: number[];
  jam: string;
  traveled: string;
  clicks: string;
  payout: string;
  escaped: string;
};

export type Scan = { index: number; center: number; forStash: boolean; found: string };

export async function loadConfig(): Promise<Config> {
  const c = await snare().config();
  return {
    starterGold: c.starterGold,
    ticketPrice: c.ticketPrice,
    scanPrice: c.scanPrice,
    stashValue: c.stashValue,
    trapCount: Number(c.trapCount),
    stashCount: Number(c.stashCount),
    maxRouteLength: Number(c.maxRouteLength),
    maxRaidsPerVault: Number(c.maxRaidsPerVault),
    vaultLifetime: Number(c.vaultLifetime),
  };
}

export async function loadVault(id: number): Promise<Vault> {
  const v = await snare().getVault(id);
  return {
    id,
    owner: v.owner,
    isHouse: v.owner === ZeroAddress,
    expiresAt: Number(v.expiresAt),
    status: Number(v.status) as Status,
    raidCount: Number(v.raidCount),
    traps: v.traps,
    stashes: [...v.stashes],
    remaining: [...v.remaining],
    clearTraps: v.clearTraps,
    clearStashes: [...v.clearStashes],
  };
}

/** True while a vault still takes raids: active, not past its expiry, and not full. */
export function isOpen(vault: Vault, config: Config | null, now: number): boolean {
  if (vault.status !== Status.Active || now >= vault.expiresAt) return false;
  return config === null || vault.raidCount < config.maxRaidsPerVault;
}

export async function loadVaults(): Promise<Vault[]> {
  const count = Number(await snare().vaultCount());
  const vaults = await Promise.all(Array.from({ length: count }, (_, id) => loadVault(id)));
  return vaults.reverse();
}

export async function loadRaids(vault: Vault): Promise<Raid[]> {
  const contract = snare();
  return Promise.all(
    Array.from({ length: vault.raidCount }, async (_, index) => {
      const r = await contract.getRaid(vault.id, index);
      return {
        index,
        raider: r.raider,
        route: [...r.route].map(Number),
        jam: r.jam,
        traveled: r.traveled,
        clicks: r.clicks,
        payout: r.payout,
        escaped: r.escaped,
      };
    }),
  );
}

export async function loadScans(vaultId: number, scanner: string): Promise<Scan[]> {
  const scans = await snare().getScans(vaultId, scanner);
  return [...scans].map((s, index) => ({
    index,
    center: Number(s.center),
    forStash: s.forStash,
    found: s.found,
  }));
}

export async function goldHandle(player: string): Promise<string> {
  return snare().goldOf(player);
}

export async function hasClaimed(player: string): Promise<boolean> {
  return snare().hasClaimed(player);
}

export async function chainTime(): Promise<number> {
  const block = await provider.getBlock("latest");
  return block ? block.timestamp : Math.floor(Date.now() / 1000);
}

export type Sent = { hash: string; receipt: ContractTransactionReceipt; ms: number };

async function sent(tx: Promise<{ hash: string; wait(): Promise<ContractTransactionReceipt | null> }>): Promise<Sent> {
  const started = performance.now();
  const response = await tx;
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Transaction failed.");
  provider.pinAfterWrite(receipt.blockNumber);
  return { hash: response.hash, receipt, ms: performance.now() - started };
}

export const claimStarter = (signer: Signer) => sent(snare(signer).claimStarter());

export async function createVault(signer: Signer, traps: number[], stashes: number[]) {
  const { handles, inputProof } = await encryptTiles(await signer.getAddress(), [...traps, ...stashes]);
  const result = await sent(
    snare(signer).createVault(handles.slice(0, traps.length), handles.slice(traps.length), inputProof),
  );
  return { ...result, vaultId: createdVaultId(result.receipt) };
}

export async function createHouseVault(signer: Signer) {
  const result = await sent(snare(signer).createHouseVault());
  return { ...result, vaultId: createdVaultId(result.receipt) };
}

function createdVaultId(receipt: ContractTransactionReceipt): number {
  const contract = snare();
  for (const log of receipt.logs) {
    const parsed = contract.interface.parseLog(log);
    if (parsed?.name === "VaultCreated") return Number(parsed.args.vaultId);
  }
  throw new Error("VaultCreated event not found.");
}

export const raid = (signer: Signer, vaultId: number, route: number[]) => sent(snare(signer).raid(vaultId, route));

export const scan = (signer: Signer, vaultId: number, center: number, forStash: boolean) =>
  sent(snare(signer).scan(vaultId, center, forStash));

export const retire = (signer: Signer, vaultId: number) => sent(snare(signer).retire(vaultId));

/** Public decryption of the whole history, then the contract re-checks every raid in plaintext. */
export async function revealAndVerify(signer: Signer, vaultId: number) {
  const started = performance.now();
  const handles: string[] = [...(await snare().revealHandles(vaultId))];
  const decrypted = await publicDecrypt(handles);
  const decryptMs = performance.now() - started;
  const result = await sent(
    snare(signer).verifyReveal(vaultId, decrypted.abiEncodedClearValues, decrypted.decryptionProof),
  );
  return { ...result, decryptMs, handles, clearValues: decrypted.clearValues };
}

/** Clear values of a verified vault's history, read back through public decryption. */
export async function revealedHistory(raids: Raid[]) {
  const handles = raids.flatMap((r) => [r.jam, r.traveled, r.escaped, r.payout]);
  if (handles.length === 0) return new Map<number, { jam: bigint; traveled: bigint; escaped: boolean; payout: bigint }>();
  const { clearValues } = await publicDecrypt(handles);
  const value = (h: string) => clearValues[h as `0x${string}`] ?? clearValues[h.toLowerCase() as `0x${string}`];
  return new Map(
    raids.map((r) => [
      r.index,
      {
        jam: BigInt(value(r.jam) as bigint),
        traveled: BigInt(value(r.traveled) as bigint),
        escaped: Boolean(value(r.escaped)),
        payout: BigInt(value(r.payout) as bigint),
      },
    ]),
  );
}

/** Local chains only: moves block time forward so expired vaults can be retired in a demo. */
export async function fastForward(seconds: number) {
  if (network.fheMode !== "mock") throw new Error("Time travel only works on a local chain.");
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

export function decodeError(error: unknown): string {
  const e = error as { shortMessage?: string; message?: string; data?: string; info?: { error?: { message?: string } } };
  const data = e?.data;
  if (typeof data === "string" && data.length >= 10) {
    try {
      const parsed = snare().interface.parseError(data);
      if (parsed) return friendly(parsed.name);
    } catch {
      /* not a Snare error */
    }
  }
  const message = e?.info?.error?.message || e?.shortMessage || e?.message || String(error);
  const match = message.match(/reverted with custom error '(\w+)/);
  if (match) return friendly(match[1]);
  if (/user rejected|denied/i.test(message)) return "You cancelled the request.";
  if (/insufficient funds/i.test(message)) return "This player has no gas. Fund the address and try again.";
  return message.length > 220 ? `${message.slice(0, 220)}…` : message;
}

function friendly(name: string): string {
  const messages: Record<string, string> = {
    NotClaimed: "Claim your starting gold first.",
    AlreadyClaimed: "Starting gold was already claimed.",
    OwnVault: "You can't raid your own vault. Switch player.",
    VaultClosed: "This vault is closed.",
    NotAllowedToRetire: "Only the owner can retire this vault before it expires or fills up.",
    NotRetired: "Retire the vault before opening its books.",
    RouteLength: "That route is too short or too long.",
    BadStart: "Routes start on the bottom row.",
    BadExit: "Routes end on the top row.",
    NotAdjacent: "Each step has to touch the last one.",
    TileRepeated: "A route can't cross itself.",
    ReplayMismatch: "Replay did not match the encrypted history.",
  };
  return messages[name] ?? name;
}
