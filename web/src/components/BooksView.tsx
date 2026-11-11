import { BadgeCheck, BookOpen, Check, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as game from "../lib/game";
import { type Raid, Status, type Vault } from "../lib/game";
import { has, replayRoute, tilesOf } from "../lib/grid";
import { txLink } from "../lib/network";
import { outcome, type Outcome, summary } from "../lib/outcome";
import { useGame } from "../state";
import { Board, type CellView } from "./Board";
import { SpyPanel } from "./SpyPanel";
import { Button, seconds, shortAddress } from "./ui";
import { usePlayback } from "./usePlayback";

type Replayed = Outcome & { jam: bigint; matches: boolean };

/** A retired vault: open the books, then replay every raid against the revealed layout. */
export function BooksView({ vault, raids, reload }: { vault: Vault; raids: Raid[]; reload(): Promise<void> }) {
  const { config, run, nameOf, refresh } = useGame();
  const [history, setHistory] = useState<Replayed[]>([]);
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<{ hash: string; decryptMs: number; ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playback = usePlayback();
  const verified = vault.status === Status.Verified;

  useEffect(() => {
    if (!verified) return;
    let cancelled = false;
    game
      .revealedHistory(raids)
      .then((clear) => {
        if (cancelled) return;
        setHistory(
          raids.map((r) => {
            const c = clear.get(r.index)!;
            const o = outcome(r.index, r.raider, r.route, c.traveled, vault.clearTraps & c.jam & c.traveled, c.escaped, c.payout);
            const replay = c.traveled === 0n ? { traveled: 0n, escaped: false } : replayRoute(vault.clearTraps, c.jam, r.route);
            return { ...o, jam: c.jam, matches: replay.traveled === c.traveled && replay.escaped === c.escaped };
          }),
        );
      })
      .catch((e) => setError(game.decodeError(e)));
    return () => {
      cancelled = true;
    };
  }, [verified, vault, raids]);

  const views = useMemo(() => {
    const map = new Map<number, CellView>();
    if (!verified) return map;
    for (const t of tilesOf(vault.clearTraps)) map.set(t, { trap: true });
    for (const mask of vault.clearStashes) for (const t of tilesOf(mask)) map.set(t, { ...map.get(t), stash: true });
    const p = playback.playing as Replayed | null;
    if (p) {
      for (const t of tilesOf(vault.clearTraps)) {
        if (has(p.jam, t)) map.set(t, { ...map.get(t), badge: "jam" });
      }
      for (const t of p.route.slice(0, playback.step)) {
        if (has(p.clicks, t)) map.set(t, { ...map.get(t), click: true, badge: "click" });
      }
      if (playback.done && p.caughtAt !== null) map.set(p.caughtAt, { ...map.get(p.caughtAt), caught: true, badge: "snap" });
    }
    return map;
  }, [verified, vault, playback.playing, playback.step, playback.done]);

  if (!config) return null;

  async function openBooks() {
    setBusy(true);
    setError(null);
    const result = await run("Decrypting the history and replaying it on-chain", (s) => game.revealAndVerify(s, vault.id));
    if (result) {
      setProof({ hash: result.hash, decryptMs: result.decryptMs, ms: result.ms });
      await reload();
      await refresh();
    }
    setBusy(false);
  }

  const p = playback.playing;
  const link = proof ? txLink(proof.hash) : null;
  const allMatch = history.length > 0 && history.every((h) => h.matches);

  return (
    <div className="stage">
      <div className="stage-board">
        <Board
          label={`Vault ${vault.id + 1}, revealed layout`}
          route={p?.route}
          shown={p ? playback.step : undefined}
          runnerAt={p && playback.step > 0 ? p.route[playback.step - 1] : null}
          views={views}
        />
        {verified && (
          <div className="legend" aria-hidden>
            <span>"jam" marks a trap that was disarmed on the selected raid</span>
          </div>
        )}
      </div>
      <div className="side">
        {!verified ? (
          <div className="panel">
            <h3>Retired</h3>
            <p>
              The layout and every raid are now publicly decryptable. Anyone can open the books: the chain checks Zama's
              decryption proof, then replays every raid in plaintext and refuses if a single one disagrees with what the
              encrypted game decided at the time.
            </p>
            <div className="controls">
              <Button tone="primary" icon={<BookOpen size={16} aria-hidden />} busy={busy} onClick={openBooks}>
                Open the books
              </Button>
            </div>
            {error && <p className="hint">{error}</p>}
          </div>
        ) : (
          <div className="panel result" data-tone="escaped">
            <p className="result-title">
              <BadgeCheck size={20} strokeWidth={1.5} aria-hidden /> Books verified
            </p>
            <p>
              The contract replayed {vault.raidCount} raid{vault.raidCount === 1 ? "" : "s"} against the revealed layout and
              every outcome matched.
            </p>
            {proof && (
              <p className="hint">
                Public decryption {seconds(proof.decryptMs)}, verify transaction {seconds(proof.ms)}.{" "}
                {link && <a href={link}>View transaction</a>}
              </p>
            )}
          </div>
        )}

        {verified && (
          <div className="panel">
            <h3>Replay any raid {allMatch && <span className="tag">All match</span>}</h3>
            {history.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                {vault.raidCount === 0 ? "Nobody raided this vault." : "Loading the history…"}
              </p>
            ) : (
              <ul className="ledger">
                {history.map((h) => (
                  <li key={h.index}>
                    <span className="who">{nameOf(h.raider) ?? shortAddress(h.raider)}</span>
                    <span>
                      {summary(h, config.stashValue)}{" "}
                      {h.matches ? (
                        <Check size={14} aria-label="matches replay" className="ledger-mark" style={{ color: "var(--loot)" }} />
                      ) : (
                        <X size={14} aria-label="does not match" className="ledger-mark" style={{ color: "var(--destructive)" }} />
                      )}
                    </span>
                    <Button size="sm" tone="ghost" onClick={() => playback.play(h)}>
                      Replay
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <SpyPanel vault={vault} raids={raids} />
    </div>
  );
}
