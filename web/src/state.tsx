import { type Signer, Wallet } from "ethers";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { fhe, read, userDecrypt } from "./lib/fhe";
import { type Config, decodeError, goldHandle, hasClaimed, loadConfig, loadVaults, type Vault } from "./lib/game";
import { network, provider, txLink } from "./lib/network";
import * as wallet from "./lib/wallet";

type Toast = { tone: "info" | "error"; message: string; link?: string | null };

type Player = {
  kind: "guest" | "wallet";
  name: string;
  signer: Signer;
  address: string;
};

type GameState = {
  config: Config | null;
  player: Player | null;
  guests: wallet.Guest[];
  claimed: boolean;
  gold: bigint | null;
  /** The current player has no ETH for gas on this chain. */
  needsGas: boolean;
  /** A gas top-up for the current guest is being checked or is on its way. */
  funding: boolean;
  fheStatus: "loading" | "ready" | "error";
  vaults: Vault[];
  selected: number | null;
  building: boolean;
  setupError: string | null;
  toast: Toast | null;
  nameOf(address: string): string | null;
  select(id: number | null): void;
  setBuilding(building: boolean): void;
  switchGuest(index: number): void;
  newGuest(): void;
  connectWallet(): Promise<void>;
  refresh(): Promise<void>;
  refreshGold(): Promise<void>;
  notify(toast: Toast | null): void;
  run<T>(label: string, action: (signer: Signer) => Promise<T>): Promise<T | undefined>;
};

const TOAST_MS = 5000;
/** A public RPC drops the odd request; the first load tries this many times before it gives up. */
const LOAD_ATTEMPTS = 3;
const LOAD_RETRY_MS = 1200;

const Context = createContext<GameState | null>(null);

export function useGame(): GameState {
  const state = useContext(Context);
  if (!state) throw new Error("useGame outside GameProvider");
  return state;
}

export function GameProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null);
  // Idempotent, so React's double-invoked initialisers still create a single first guest.
  const [guestList, setGuestList] = useState(() => {
    if (wallet.guests().length === 0) wallet.addGuest();
    return wallet.guests();
  });
  const [active, setActive] = useState(wallet.activeIndex());
  const [injected, setInjected] = useState<Player | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [gold, setGold] = useState<bigint | null>(null);
  const [needsGas, setNeedsGas] = useState(false);
  const [funding, setFunding] = useState(false);
  const [fheStatus, setFheStatus] = useState<"loading" | "ready" | "error">("loading");
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const player = useMemo<Player | null>(() => {
    if (injected) return injected;
    const guest = guestList[active];
    if (!guest) return null;
    const signer = wallet.guestSigner(guest);
    return { kind: "guest", name: guest.name, signer, address: signer.address };
  }, [injected, guestList, active]);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of guestList) map.set(new Wallet(g.key).address.toLowerCase(), g.name);
    if (injected) map.set(injected.address.toLowerCase(), injected.name);
    return map;
  }, [guestList, injected]);

  const refresh = useCallback(async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const [cfg, list] = await Promise.all([loadConfig(), loadVaults()]);
        setConfig(cfg);
        setVaults(list);
        setSetupError(null);
        return;
      } catch (error) {
        if (attempt >= LOAD_ATTEMPTS) return setSetupError(decodeError(error));
        await new Promise((resolve) => setTimeout(resolve, LOAD_RETRY_MS * attempt));
      }
    }
  }, []);

  const refreshGold = useCallback(async () => {
    if (!player) return;
    try {
      const isClaimed = await hasClaimed(player.address);
      setClaimed(isClaimed);
      if (!isClaimed) return setGold(null);
      const handle = await goldHandle(player.address);
      const values = await userDecrypt(player.signer, [handle]);
      const value = read(values, handle);
      setGold(value === undefined ? 0n : BigInt(value as bigint));
    } catch (error) {
      setToast({ tone: "error", message: `Could not read your gold: ${decodeError(error)}` });
    }
  }, [player]);

  useEffect(() => {
    void refresh();
    // Warm up the FHE client early: on Sepolia it downloads Zama's public key, which takes seconds.
    fhe()
      .then(() => setFheStatus("ready"))
      .catch((error) => {
        setFheStatus("error");
        setToast({ tone: "error", message: `Could not connect to Zama FHE: ${decodeError(error)}` });
      });
  }, [refresh]);

  useEffect(() => {
    if (!player) return;
    let cancelled = false;
    setGold(null);
    setFunding(player.kind === "guest");
    (async () => {
      let funded = false;
      if (player.kind === "guest") {
        try {
          funded = await wallet.ensureGas(player.address, () => {
            if (!cancelled) setToast({ tone: "info", message: "Sending this guest a little test ETH for gas…" });
          });
          if (funded && !cancelled) setToast({ tone: "info", message: "This guest has gas now. No faucet needed." });
        } catch (error) {
          if (!cancelled) setToast({ tone: "error", message: `Gas top-up failed: ${decodeError(error)}` });
        }
      }
      if (cancelled) return;
      setFunding(false);
      // Right after a top-up a lagging RPC node can still report zero, so the top-up itself is trusted.
      setNeedsGas(!funded && (await provider.getBalance(player.address)) === 0n);
      await refreshGold();
    })();
    return () => {
      cancelled = true;
    };
  }, [player, refreshGold]);

  // Finished messages clear themselves; progress ("…") and errors stay until replaced or dismissed.
  useEffect(() => {
    if (!toast || toast.tone !== "info" || toast.message.endsWith("…")) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const run = useCallback(
    async <T,>(label: string, action: (signer: Signer) => Promise<T>) => {
      if (!player) return undefined;
      setToast({ tone: "info", message: `${label}…` });
      try {
        const result = await action(player.signer);
        const hash = (result as { hash?: string } | undefined)?.hash;
        setToast({ tone: "info", message: `${label}: done`, link: hash ? txLink(hash) : null });
        return result;
      } catch (error) {
        setToast({ tone: "error", message: `${label}: ${decodeError(error)}` });
        return undefined;
      }
    },
    [player],
  );

  const state: GameState = {
    config,
    player,
    guests: guestList,
    claimed,
    gold,
    needsGas,
    funding,
    fheStatus,
    vaults,
    selected,
    building,
    setupError,
    toast,
    nameOf: (address) => names.get(address.toLowerCase()) ?? null,
    select: (id) => {
      setBuilding(false);
      setSelected(id);
    },
    setBuilding: (value) => {
      setBuilding(value);
      if (value) setSelected(null);
    },
    switchGuest: (index) => {
      setInjected(null);
      wallet.setActive(index);
      setActive(index);
    },
    newGuest: () => {
      setInjected(null);
      wallet.addGuest();
      setGuestList(wallet.guests());
      setActive(wallet.activeIndex());
    },
    connectWallet: async () => {
      try {
        const signer = await wallet.connectInjected();
        setInjected({ kind: "wallet", name: "Your wallet", signer, address: await signer.getAddress() });
      } catch (error) {
        setToast({ tone: "error", message: decodeError(error) });
      }
    },
    refresh,
    refreshGold,
    notify: setToast,
    run,
  };

  return <Context.Provider value={state}>{children}</Context.Provider>;
}

export const isLocal = network.fheMode === "mock";
