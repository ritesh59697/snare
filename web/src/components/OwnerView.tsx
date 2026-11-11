import { Bell, Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { read, userDecrypt } from "../lib/fhe";
import * as game from "../lib/game";
import type { Raid, Vault } from "../lib/game";
import { has, tilesOf } from "../lib/grid";
import { outcome, type Outcome, summary } from "../lib/outcome";
import { useGame } from "../state";
import { Board, type CellView } from "./Board";
import { SpyPanel } from "./SpyPanel";
import { Button, duration, shortAddress } from "./ui";
import { usePlayback } from "./usePlayback";

/** The owner's private view: their own layout plus every raid's outcome, all decrypted for them only. */
export function OwnerView({ vault, raids, reload }: { vault: Vault; raids: Raid[]; reload(): Promise<void> }) {
  const { config, player, run, nameOf, refresh, refreshGold } = useGame();
  const [layout, setLayout] = useState<{ traps: bigint; stashes: bigint[]; remaining: bigint[] } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const playback = usePlayback();

  useEffect(() => {
    if (!player) return;
    let cancelled = false;
    (async () => {
      const handles = [
        vault.traps,
        ...vault.stashes,
        ...vault.remaining,
        ...raids.flatMap((r) => [r.traveled, r.clicks, r.escaped, r.payout]),
      ];
      const values = await userDecrypt(player.signer, handles);
      const big = (h: string) => BigInt((read(values, h) as bigint) ?? 0n);
      if (cancelled) return;
      setLayout({
        traps: big(vault.traps),
        stashes: vault.stashes.map(big),
        remaining: vault.remaining.map(big),
      });
      setOutcomes(
        raids.map((r) =>
          outcome(r.index, r.raider, r.route, big(r.traveled), big(r.clicks), Boolean(read(values, r.escaped)), big(r.payout)),
        ),
      );
      setNow(await game.chainTime());
    })();
    return () => {
      cancelled = true;
    };
  }, [player, vault, raids]);

  const views = useMemo(() => {
    const map = new Map<number, CellView>();
    if (!layout) return map;
    for (const t of tilesOf(layout.traps)) map.set(t, { trap: true });
    layout.stashes.forEach((mask, i) => {
      for (const t of tilesOf(mask)) map.set(t, { ...map.get(t), stash: true, looted: layout.remaining[i] === 0n });
    });
    const p = playback.playing;
    if (p) {
      for (const t of p.route.slice(0, playback.step)) {
        if (has(p.clicks, t)) map.set(t, { ...map.get(t), click: true, badge: "click" });
      }
      if (playback.done && p.caughtAt !== null) map.set(p.caughtAt, { ...map.get(p.caughtAt), caught: true, badge: "snap" });
    }
    return map;
  }, [layout, playback.playing, playback.step, playback.done]);

  if (!config) return null;

  const caught = outcomes.filter((o) => o.caughtAt !== null).length;
  const looted = layout ? layout.remaining.filter((m) => m === 0n).length : 0;
  const p = playback.playing;

  async function doRetire() {
    setBusy(true);
    if (await run("Retiring the vault", (s) => game.retire(s, vault.id))) {
      await reload();
      await refresh();
      await refreshGold();
    }
    setBusy(false);
  }

  return (
    <div className="stage">
      <div className="stage-board">
        <Board
          label={`Vault ${vault.id + 1}, your layout`}
          route={p?.route}
          shown={p ? playback.step : undefined}
          runnerAt={p && playback.step > 0 ? p.route[playback.step - 1] : null}
          views={views}
        />
        <div className="legend" aria-hidden>
          <span>
            <Lock size={12} strokeWidth={1.5} /> Only you can see this layout
          </span>
        </div>
      </div>
      <div className="side">
        <div className="panel">
          <dl className="stat-row">
            <div className="stat">
              <dt>Raids</dt>
              <dd>
                {vault.raidCount}/{config.maxRaidsPerVault}
              </dd>
            </div>
            <div className="stat">
              <dt>Caught</dt>
              <dd>{caught}</dd>
            </div>
            <div className="stat">
              <dt>Tickets kept</dt>
              <dd>{(BigInt(caught) * config.ticketPrice).toString()}</dd>
            </div>
            <div className="stat">
              <dt>Stashes lost</dt>
              <dd>
                {looted}/{vault.stashes.length}
              </dd>
            </div>
            <div className="stat">
              <dt>Closes in</dt>
              <dd>{duration(vault.expiresAt - now)}</dd>
            </div>
          </dl>
          <p className="hint">
            You can log off. Raids run against your traps without you, and only you and each raider can read how their run went.
          </p>
          <div className="controls">
            <Button tone="danger" busy={busy} onClick={doRetire}>
              Retire and open the books
            </Button>
          </div>
          <p className="hint">Retiring refunds stashes nobody took and makes the whole history public so anyone can check it.</p>
        </div>

        <div className="panel">
          <h3>
            <Bell size={16} strokeWidth={1.5} aria-hidden /> Raids while you were away
          </h3>
          {outcomes.length === 0 ? (
            <p className="hint" style={{ marginTop: 0 }}>
              No raids yet. Switch to another player and try to rob it.
            </p>
          ) : (
            <ul className="ledger">
              {outcomes
                .slice()
                .reverse()
                .map((o) => (
                  <li key={o.index}>
                    <span className="who">{nameOf(o.raider) ?? shortAddress(o.raider)}</span>
                    <span>{summary(o, config.stashValue)}</span>
                    <Button size="sm" tone="ghost" onClick={() => playback.play(o)}>
                      Watch
                    </Button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>

      <SpyPanel vault={vault} raids={raids} />
    </div>
  );
}
