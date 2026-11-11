import * as Dialog from "@radix-ui/react-dialog";
import {
  Coins,
  Copy,
  Fuel,
  HelpCircle,
  Home,
  KeyRound,
  LoaderCircle,
  Lock,
  Plus,
  Sparkles,
  TriangleAlert,
  UserPlus,
  Vault as VaultIcon,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BooksView } from "./components/BooksView";
import { BuildView } from "./components/BuildView";
import { OwnerView } from "./components/OwnerView";
import { RaiderView } from "./components/RaiderView";
import { Button, shortAddress } from "./components/ui";
import * as game from "./lib/game";
import { type Raid, Status, type Vault } from "./lib/game";
import { addressLink, network } from "./lib/network";
import { hasInjectedWallet } from "./lib/wallet";
import { isLocal, useGame } from "./state";

export default function App() {
  const state = useGame();
  return (
    <div className="shell">
      <TopBar />
      {state.needsGas && state.player && <GasNotice address={state.player.address} />}
      {state.setupError ? (
        <div className="notice notice-danger" role="alert">
          <TriangleAlert size={16} aria-hidden />
          <div>
            <strong>Can't reach the game contract.</strong>
            <div className="muted">{state.setupError}</div>
          </div>
        </div>
      ) : (
        <div className="layout">
          <Sidebar />
          <main>{state.building ? <BuildStage /> : <VaultStage />}</main>
        </div>
      )}
      {state.toast && (
        <div className="toast" data-tone={state.toast.tone} role="status" aria-live="polite">
          <span>{state.toast.message}</span>
          {state.toast.link && <a href={state.toast.link}>View</a>}
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Dismiss" onClick={() => state.notify(null)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

function GasNotice({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const link = addressLink(address);
  return (
    <div className="notice" role="status">
      <Fuel size={16} aria-hidden />
      <div>
        <strong>This player has no Sepolia ETH for gas.</strong>{" "}
        <span className="muted">
          Send a little test ETH from any Sepolia faucet to{" "}
          {link ? (
            <a className="mono" href={link}>
              {address}
            </a>
          ) : (
            <span className="mono">{address}</span>
          )}
          , or connect your own wallet with the wallet button. A whole game costs a tiny fraction of one test ETH.
        </span>
        <div className="controls" style={{ marginTop: "var(--s2)" }}>
          <Button
            size="sm"
            icon={<Copy size={14} aria-hidden />}
            onClick={() => {
              void navigator.clipboard?.writeText(address).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy address"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TopBar() {
  const { player, guests, claimed, gold, config, fheStatus, funding, run, refreshGold, switchGuest, newGuest, connectWallet } =
    useGame();
  const [busy, setBusy] = useState(false);
  const activeIndex = guests.findIndex((g) => g.name === player?.name);

  async function claim() {
    setBusy(true);
    if (await run("Claiming starting gold", (s) => game.claimStarter(s))) await refreshGold();
    setBusy(false);
  }

  return (
    <header className="topbar">
      <div className="wordmark">
        SNARE <small>trap a vault, log off, let them try</small>
      </div>
      <span className={`chip ${isLocal ? "" : "chip-cipher"}`}>
        {isLocal ? "Local chain · FHE mock" : `Sepolia · Zama FHE`} · {network.chainId}
      </span>
      {fheStatus !== "ready" && (
        <span className={`chip ${fheStatus === "error" ? "chip-danger" : ""}`} role="status">
          {fheStatus === "loading" ? (
            <>
              <LoaderCircle size={12} className="spin" aria-hidden /> Fetching Zama's FHE key
            </>
          ) : (
            "FHE unavailable"
          )}
        </span>
      )}
      <HowToPlay />
      <div className="spacer" />
      {player && (
        <div className="player">
          <KeyRound size={16} aria-hidden className="muted" />
          <div>
            <label className="sr-only" htmlFor="player-select">
              Player
            </label>
            {player.kind === "guest" ? (
              <select
                id="player-select"
                className="select"
                value={activeIndex}
                onChange={(e) => switchGuest(Number(e.target.value))}
              >
                {guests.map((g, i) => (
                  <option key={g.key} value={i}>
                    {g.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="player-name">{player.name}</div>
            )}
            <div className="player-address">{shortAddress(player.address)}</div>
          </div>
          <Button size="sm" tone="ghost" aria-label="New guest player" title="New guest player" onClick={newGuest}>
            <UserPlus size={16} aria-hidden />
          </Button>
          {hasInjectedWallet() && player.kind === "guest" && (
            <Button size="sm" tone="ghost" aria-label="Use my wallet" title="Use my browser wallet" onClick={() => void connectWallet()}>
              <Wallet size={16} aria-hidden />
            </Button>
          )}
          <div className="gold" aria-live="polite">
            <Coins size={16} aria-hidden />
            {claimed ? (
              gold === null ? (
                <span className="muted">decrypting</span>
              ) : (
                <span title="Decrypted in your browser. On-chain it is ciphertext.">{gold.toString()}</span>
              )
            ) : (
              <Button size="sm" tone="primary" busy={busy || funding} onClick={claim}>
                Claim {config?.starterGold.toString() ?? ""} gold
              </Button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

function HowToPlay() {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button size="sm" tone="ghost" icon={<HelpCircle size={16} aria-hidden />}>
          How it works
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <Dialog.Title>How Snare works</Dialog.Title>
          <Dialog.Description className="muted">
            On a normal blockchain anyone can read where your traps are. Snare keeps them encrypted with Zama's FHE, and the
            chain checks every raid against them while you're offline.
          </Dialog.Description>
          <ol className="steps">
            <li>Rig a vault: place traps and stashes. Your browser encrypts the positions before sending them.</li>
            <li>Raiders draw a route from the bottom row to the top and pay a ticket.</li>
            <li>The contract walks the route over ciphertext. Nobody, not even the raider, knows the result until they decrypt it.</li>
            <li>Each raid jams about a quarter of the traps with fresh encrypted randomness, so a trap can click and let you live.</li>
            <li>Scans privately answer "is there a trap in this 3×3?" Only the scanner can read the answer.</li>
            <li>When a vault retires, everything becomes public and the contract replays every raid to prove it was fair.</li>
          </ol>
          <div className="controls">
            <Dialog.Close asChild>
              <Button tone="primary">Got it</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Sidebar() {
  const { vaults, selected, select, setBuilding, building, run, refresh, nameOf, player, config, funding } = useGame();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Expiry is judged by the chain's clock, re-read whenever the list changes.
  useEffect(() => {
    let cancelled = false;
    void game.chainTime().then((time) => !cancelled && setNow(time));
    return () => {
      cancelled = true;
    };
  }, [vaults]);
  const noneOpen = vaults.length > 0 && !vaults.some((v) => game.isOpen(v, config, now));

  async function house() {
    setBusy(true);
    const result = await run("Sealing a house vault nobody has seen", (s) => game.createHouseVault(s));
    if (result) {
      await refresh();
      select(result.vaultId);
    }
    setBusy(false);
  }

  return (
    <aside className="sidebar" aria-label="Vaults">
      <h2>Vaults</h2>
      <div className="sidebar-actions">
        <Button tone={building ? "primary" : "default"} icon={<Plus size={16} aria-hidden />} onClick={() => setBuilding(true)}>
          Rig a vault
        </Button>
        <Button
          tone={noneOpen && !building ? "primary" : "default"}
          icon={<Sparkles size={16} aria-hidden />}
          busy={busy || funding}
          onClick={house}
          title="Random layout from encrypted randomness"
        >
          House vault
        </Button>
      </div>
      {noneOpen && <p className="empty">No vault is open right now. Open a house vault to raid one nobody has ever seen.</p>}
      {vaults.length === 0 ? (
        <p className="empty">No vaults yet. Open a house vault to raid one nobody has ever seen, or rig your own.</p>
      ) : (
        <ul className="vault-list">
          {vaults.map((v) => {
            const mine = player && v.owner.toLowerCase() === player.address.toLowerCase();
            const status =
              v.status === Status.Active
                ? !game.isOpen(v, config, now)
                  ? "ended"
                  : mine
                    ? "your vault"
                    : "open"
                : v.status === Status.Retired
                  ? "retired"
                  : "verified";
            return (
              <li key={v.id}>
                <button type="button" className="vault-item" aria-current={selected === v.id} onClick={() => select(v.id)}>
                  <span className="vault-number">{v.id + 1}</span>
                  <span className="vault-meta">
                    <strong>{v.isHouse ? "House vault" : `${nameOf(v.owner) ?? shortAddress(v.owner)}'s vault`}</strong>
                    <span>
                      {v.raidCount}/{config?.maxRaidsPerVault ?? "?"} raids
                    </span>
                  </span>
                  <span className={`chip ${status === "open" ? "chip-accent" : status === "verified" ? "chip-loot" : ""}`}>
                    {v.isHouse ? <Home size={12} aria-hidden /> : mine ? <Lock size={12} aria-hidden /> : null}
                    {status}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function BuildStage() {
  return (
    <>
      <div className="stage-head">
        <div>
          <h1 className="stage-title">Rig a vault</h1>
          <p className="stage-sub">Hide your traps where nobody would step. Nobody will ever see them unless they get caught.</p>
        </div>
      </div>
      <BuildView />
    </>
  );
}

function VaultStage() {
  const { vaults, selected, select, player, nameOf, config } = useGame();
  const [raids, setRaids] = useState<Raid[]>([]);
  const [vault, setVault] = useState<Vault | null>(null);

  // Land on the newest vault that still takes raids; fall back to the newest of any kind.
  useEffect(() => {
    if (selected !== null || vaults.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    select((vaults.find((v) => game.isOpen(v, config, now)) ?? vaults[0]).id);
  }, [selected, vaults, select, config]);

  const reload = useCallback(async () => {
    if (selected === null) return;
    const v = await game.loadVault(selected);
    setVault(v);
    setRaids(await game.loadRaids(v));
  }, [selected]);

  useEffect(() => {
    setVault(null);
    setRaids([]);
    void reload();
  }, [reload]);

  if (selected === null || !vault || vault.id !== selected) {
    return (
      <div className="empty" style={{ display: "flex", gap: "var(--s3)", alignItems: "center" }}>
        <VaultIcon size={20} aria-hidden />
        {vaults.length === 0 ? "Pick an action on the left to start." : "Opening the vault…"}
      </div>
    );
  }

  const mine = player && vault.owner.toLowerCase() === player.address.toLowerCase();
  const title = vault.isHouse ? "House vault" : mine ? "Your vault" : `${nameOf(vault.owner) ?? shortAddress(vault.owner)}'s vault`;
  const subtitle =
    vault.status !== Status.Active
      ? "Retired. Its secrets are public now."
      : mine
        ? "Watching your traps work while you're away."
        : vault.isHouse
          ? "Laid out by encrypted randomness. Nobody alive has seen it."
          : "Plan a route, scan if you dare, then run it.";

  return (
    <>
      <div className="stage-head">
        <div>
          <h1 className="stage-title">
            {title} <span className="muted">#{vault.id + 1}</span>
          </h1>
          <p className="stage-sub">{subtitle}</p>
        </div>
      </div>
      {vault.status !== Status.Active ? (
        <BooksView vault={vault} raids={raids} reload={reload} />
      ) : mine ? (
        <OwnerView vault={vault} raids={raids} reload={reload} />
      ) : (
        <RaiderView key={`${vault.id}-${player?.address}`} vault={vault} raids={raids} reload={reload} />
      )}
    </>
  );
}
