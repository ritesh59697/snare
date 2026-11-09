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

/** On a local chain, tops a guest up from the dev faucet key so it can pay gas. */
export async function ensureGas(address: string): Promise<boolean> {
  if (!network.faucetKey || !network.faucetAmount) return false;
  const amount = parseEther(network.faucetAmount);
  const balance = await provider.getBalance(address);
  if (balance * 2n >= amount) return false;
  const faucet = new Wallet(network.faucetKey, provider);
  await (await faucet.sendTransaction({ to: address, value: amount })).wait();
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
