import { Bomb, Gem, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import * as game from "../lib/game";
import { tileName } from "../lib/grid";
import { useGame } from "../state";
import { Board, type CellView } from "./Board";
import { Button } from "./ui";

export function BuildView() {
  const { config, claimed, gold, run, refresh, refreshGold, select } = useGame();
  const [traps, setTraps] = useState<number[]>([]);
  const [stashes, setStashes] = useState<number[]>([]);
  const [tool, setTool] = useState<"trap" | "stash">("trap");
  const [busy, setBusy] = useState(false);

  const views = useMemo(() => {
    const map = new Map<number, CellView>();
    for (const t of traps) map.set(t, { trap: true });
    for (const t of stashes) map.set(t, { stash: true });
    return map;
  }, [traps, stashes]);

  if (!config) return null;
  const deposit = config.stashValue * BigInt(config.stashCount);
  const full = traps.length === config.trapCount && stashes.length === config.stashCount;

  function onTile(tile: number) {
    if (!config) return;
    if (traps.includes(tile)) return setTraps(traps.filter((t) => t !== tile));
    if (stashes.includes(tile)) return setStashes(stashes.filter((t) => t !== tile));
    if (tool === "trap" && traps.length < config.trapCount) setTraps([...traps, tile]);
    if (tool === "stash" && stashes.length < config.stashCount) setStashes([...stashes, tile]);
  }

  async function seal() {
    setBusy(true);
    const result = await run("Encrypting and sealing your vault", (s) => game.createVault(s, traps, stashes));
    if (result) {
      await refresh();
      await refreshGold();
      select(result.vaultId);
    }
    setBusy(false);
  }

  return (
    <div className="stage">
      <div className="stage-board">
        <Board label="New vault layout" views={views} isClickable={() => !busy} onTile={onTile} />
      </div>
      <div className="side">
        <div className="panel">
          <h3>Place traps and stashes</h3>
          <div className="tools" role="group" aria-label="Placement tool">
            <button type="button" aria-pressed={tool === "trap"} onClick={() => setTool("trap")}>
              <Bomb size={16} aria-hidden /> Traps {traps.length}/{config.trapCount}
            </button>
            <button type="button" aria-pressed={tool === "stash"} onClick={() => setTool("stash")}>
              <Gem size={16} aria-hidden /> Stashes {stashes.length}/{config.stashCount}
            </button>
          </div>
          <p className="hint">
            Place every trap and stash, then seal. Your browser encrypts each position before it leaves this page, so the chain
            never sees where anything is. Seven traps can never wall off the grid, so every vault can be beaten.
          </p>
          <dl className="stat-row" style={{ marginTop: "var(--s5)" }}>
            <div className="stat">
              <dt>Stash deposit</dt>
              <dd>{deposit.toLocaleString("en-US")} gold</dd>
            </div>
            <div className="stat">
              <dt>Your gold</dt>
              <dd>{gold === null ? "…" : gold.toLocaleString("en-US")}</dd>
            </div>
          </dl>
          {gold !== null && gold < deposit && (
            <p className="hint">
              You can't cover the deposit, so the stashes would be sealed empty. Nobody can tell until the vault retires.
            </p>
          )}
          <div className="actions">
            <Button tone="primary" className="btn-lg btn-grow" icon={<Lock size={16} aria-hidden />} disabled={!full || !claimed} busy={busy} onClick={seal}>
              Encrypt and seal
            </Button>
            <Button tone="ghost" className="btn-lg" disabled={busy || (traps.length === 0 && stashes.length === 0)} onClick={() => (setTraps([]), setStashes([]))}>
              Reset
            </Button>
          </div>
          {(traps.length > 0 || stashes.length > 0) && (
            <p className="hint mono">
              traps {traps.map(tileName).join(" ") || "-"} · stashes {stashes.map(tileName).join(" ") || "-"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
