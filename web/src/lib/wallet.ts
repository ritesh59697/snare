import { BrowserProvider, Wallet, parseEther, type Signer } from "ethers";
import { network, provider } from "./network";

// Guest players are local burner keys kept in this browser, so a full game needs no wallet popups.
// Several guests let one person play both the vault owner and the raider.

export type Guest = { name: string; key: string };

const STORE = `snare.guests.${network.chainId}`;
const ACTIVE = `snare.active.${network.chainId}`;
const NAMES = ["Magpie", "Lockjaw", "Vesper", "Tumbler", "Wren", "Cinder", "Slate", "Juniper"];

function load(): Guest[] {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "[]") as Guest[];
  } catch {
    return [];
  }
}

function save(guests: Guest[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(guests));
  } catch {
    /* private window: guests last for this tab only */
  }
}

let memory: Guest[] = load();

export function guests(): Guest[] {
  return memory;
}

export function activeIndex(): number {
  try {
    const value = Number(localStorage.getItem(ACTIVE) ?? "0");
    return Number.isInteger(value) && value >= 0 && value < memory.length ? value : 0;
  } catch {
    return 0;
  }
}

export function setActive(index: number) {
  try {
    localStorage.setItem(ACTIVE, String(index));
  } catch {
    /* ignore */
  }
}

export function addGuest(): Guest {
  const used = new Set(memory.map((g) => g.name));
  const name = NAMES.find((n) => !used.has(n)) ?? `Guest ${memory.length + 1}`;
  const guest = { name, key: Wallet.createRandom().privateKey };
  memory = [...memory, guest];
  save(memory);
  setActive(memory.length - 1);
  return guest;
}

export function guestSigner(guest: Guest): Wallet {
  return new Wallet(guest.key, provider);
}

const DRIP_CONFIRM_TIMEOUT_MS = 120_000;

/**
 * Makes sure a guest can pay gas. A local chain uses the dev faucet key. A hosted site asks its gas
 * drip, which sizes the top-up from live fees. Resolves to true when a top-up arrived.
 */
export async function ensureGas(address: string, onSending?: () => void): Promise<boolean> {
  if (network.faucetKey && network.faucetAmount) {
    const amount = parseEther(network.faucetAmount);
    const balance = await provider.getBalance(address);
    if (balance * 2n >= amount) return false;
    onSending?.();
    const faucet = new Wallet(network.faucetKey, provider);
    await (await faucet.sendTransaction({ to: address, value: amount })).wait();
    return true;
  }
  if (!network.dripUrl) return false;
  const response = await fetch(network.dripUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const body = (await response.json().catch(() => ({}))) as { funded?: boolean; hash?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? `The gas drip answered ${response.status}.`);
  if (!body.funded || !body.hash) return false;
  onSending?.();
  const receipt = await provider.waitForTransaction(body.hash, 1, DRIP_CONFIRM_TIMEOUT_MS);
  if (receipt) provider.pinAfterWrite(receipt.blockNumber);
  return true;
}

type Injected = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as { ethereum?: Injected }).ethereum);
}

/** Connects a browser wallet and switches it to the configured chain. */
export async function connectInjected(): Promise<Signer> {
  const ethereum = (window as unknown as { ethereum?: Injected }).ethereum;
  if (!ethereum) throw new Error("No browser wallet found.");
  await ethereum.request({ method: "eth_requestAccounts" });
  const hexChain = `0x${network.chainId.toString(16)}`;
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChain }] });
  } catch {
    throw new Error(`Switch your wallet to chain ${network.chainId} and try again.`);
  }
  return new BrowserProvider(ethereum as never, network.chainId).getSigner();
}
