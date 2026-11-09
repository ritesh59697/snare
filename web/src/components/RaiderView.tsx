import { Clock, Footprints, Gem, Radar, RotateCcw, ShieldAlert, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { read, userDecrypt } from "../lib/fhe";
import * as game from "../lib/game";
import { type Raid, type Scan, type Vault } from "../lib/game";
import { areaTiles, canExtend, routeComplete, tileName, WIDTH } from "../lib/grid";
import { outcome, type Outcome, summary } from "../lib/outcome";
import { isLocal, useGame } from "../state";
import { Board, type CellView } from "./Board";
import { SpyPanel } from "./SpyPanel";
import { Button, duration } from "./ui";
import { usePlayback } from "./usePlayback";

type Tool = "route" | "trap" | "stash";
type KnownScan = Scan & { result: boolean };

export function RaiderView({ vault, raids, reload }: { vault: Vault; raids: Raid[]; reload(): Promise<void> }) {
  const { config, player, claimed, gold, run, refresh, refreshGold, nameOf } = useGame();
  const [route, setRoute] = useState<number[]>([]);
  const [tool, setTool] = useState<Tool>("route");
  const [scans, setScans] = useState<KnownScan[]>([]);
  const [mine, setMine] = useState<Outcome[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const playback = usePlayback();

  const me = player?.address ?? "";

  const loadMine = useCallback(async (): Promise<Outcome[]> => {
    if (!player) return [];
    const own = raids.filter((r) => r.raider.toLowerCase() === me.toLowerCase());
    const found = await game.loadScans(vault.id, me);
    const handles = [...own.flatMap((r) => [r.traveled, r.clicks, r.escaped, r.payout]), ...found.map((s) => s.found)];
    const values = await userDecrypt(player.signer, handles);
    const outcomes = own.map((r) =>
      outcome(
        r.index,
        r.raider,
        r.route,
        BigInt((read(values, r.traveled) as bigint) ?? 0n),
        BigInt((read(values, r.clicks) as bigint) ?? 0n),
        Boolean(read(values, r.escaped)),
        BigInt((read(values, r.payout) as bigint) ?? 0n),
      ),
    );
    setMine(outcomes);
    setScans(found.map((s) => ({ ...s, result: Boolean(read(values, s.found)) })));
    return outcomes;
  }, [player, raids, me, vault.id]);

  useEffect(() => {
    void loadMine();
  }, [loadMine]);

  useEffect(() => {
    void game.chainTime().then(setNow);
  }, [raids]);

  const knownTraps = useMemo(() => {
    const tiles = new Set<number>();
    for (const o of mine) {
      if (o.caughtAt !== null) tiles.add(o.caughtAt);
      for (const t of o.route) if ((o.clicks >> BigInt(t)) & 1n) tiles.add(t);
    }
    return tiles;
  }, [mine]);

  const views = useMemo(() => {
    const map = new Map<number, CellView>();
    const get = (t: number) => map.get(t) ?? (map.set(t, {}), map.get(t)!);
    const clear = new Set<number>();
    for (const s of scans.filter((s) => !s.forStash && !s.result)) areaTiles(s.center).forEach((t) => clear.add(t));
    for (const s of scans) {
      for (const t of areaTiles(s.center)) {
        if (s.forStash && s.result && get(t).scan !== "trap") get(t).scan = "loot";
        if (!s.forStash && s.result && !clear.has(t)) get(t).scan = "trap";
      }
    }
    for (const t of clear) if (get(t).scan !== "loot") get(t).scan = "clear";
    for (const s of scans) get(s.center).badge = s.forStash ? "loot?" : "scan";
    for (const t of knownTraps) get(t).trap = true;

    const p = playback.playing;
    if (p) {
      const walked = p.route.slice(0, playback.step);
      for (const t of walked) if ((p.clicks >> BigInt(t)) & 1n) Object.assign(get(t), { click: true, badge: "click" });
      if (playback.done && p.caughtAt !== null) Object.assign(get(p.caughtAt), { caught: true, badge: "snap" });
    }
    return map;
  }, [scans, knownTraps, playback.playing, playback.step, playback.done]);

  // Play the newest raid of mine once, as soon as it decrypts after a raid.
  const { play, playing } = playback;
  useEffect(() => {
    const newest = mine[mine.length - 1];
    if (!newest || busy !== null || playing || newest.index !== vault.raidCount - 1) return;
    const key = `snare.played.${vault.id}.${newest.index}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      /* storage blocked: playing again is harmless */
    }
    play(newest);
    void refreshGold();
  }, [mine, busy, playing, play, vault.id, vault.raidCount, refreshGold]);

  if (!config || !player) return null;

  const ended = now >= vault.expiresAt || vault.raidCount >= config.maxRaidsPerVault;
  const lastPlayed = playback.playing;
  const shownRoute = lastPlayed ? lastPlayed.route : route;
  const runnerAt = lastPlayed && playback.step > 0 ? lastPlayed.route[playback.step - 1] : null;
  const ready = routeComplete(route, WIDTH);
  const canAfford = (cost: bigint) => gold === null || gold >= cost;

  function onTile(tile: number) {
    if (!config) return;
    if (tool !== "route") return void doScan(tile, tool === "stash");
    playback.clear();
    setRoute((current) => {
      const at = current.indexOf(tile);
      if (at >= 0) return current.slice(0, at + 1 === current.length ? at : at + 1);
      if (canExtend(current, tile, config.maxRouteLength)) return [...current, tile];
      if (tile < WIDTH) return [tile];
      return current;
    });
  }

  function isClickable(tile: number) {
    if (busy || !config) return false;
    if (tool !== "route") return true;
    return route.includes(tile) || canExtend(route, tile, config.maxRouteLength) || tile < WIDTH;
  }

  async function doScan(center: number, forStash: boolean) {
    setBusy("scan");
    const done = await run(`Scanning around ${tileName(center)}`, (s) => game.scan(s, vault.id, center, forStash));
    if (done) {
      await loadMine();
      await refreshGold();
    }
    setBusy(null);
  }

  async function doRaid() {
    setBusy("raid");
    const done = await run("Running the route", (s) => game.raid(s, vault.id, route));
    if (done) {
      await reload();
      await refresh();
      setRoute([]);
    }
    setBusy(null);
  }

  async function doRetire() {
    setBusy("retire");
    if (await run("Retiring the vault", (s) => game.retire(s, vault.id))) await reload();
    setBusy(null);
  }

  async function skipTime() {
    setBusy("time");
    await run("Skipping ahead", async () => game.fastForward(config!.vaultLifetime));
    setNow(await game.chainTime());
    setBusy(null);
  }

  const owner = vault.isHouse ? "the house" : (nameOf(vault.owner) ?? "a stranger");

  return (
    <div className="stage">
      <div>
        {!claimed && (
          <div className="notice">
            <ShieldAlert size={16} aria-hidden />
            Claim your starting gold in the top bar before you scan or raid.
          </div>
        )}
        <Board
          label={`Vault ${vault.id + 1}, planning board`}
          route={shownRoute}
          shown={lastPlayed ? playback.step : undefined}
          views={views}
          runnerAt={runnerAt}
          isClickable={isClickable}
          onTile={lastPlayed && !playback.done ? undefined : onTile}
        />
        <div className="legend" aria-hidden>
          <span>
            <span className="chip chip-danger">red</span> scan says a trap is near
          </span>
          <span>
            <span className="chip chip-cipher">cyan</span> scan says no trap near
          </span>
          <span>
            <span className="chip chip-loot">green</span> loot nearby
          </span>
        </div>
      </div>

      <div>
        <div className="panel">
          <h3>Plan</h3>
          <div className="tools" role="group" aria-label="Board tool">
            <button type="button" aria-pressed={tool === "route"} onClick={() => setTool("route")}>
              <Footprints size={16} aria-hidden /> Draw route
            </button>
            <button type="button" aria-pressed={tool === "trap"} onClick={() => setTool("trap")}>
              <Radar size={16} aria-hidden /> Scan traps
            </button>
            <button type="button" aria-pressed={tool === "stash"} onClick={() => setTool("stash")}>
              <Gem size={16} aria-hidden /> Scan loot
            </button>
          </div>
          <p className="hint">
            {tool === "route"
              ? `Start on the bottom row and step to touching tiles until you reach the top. ${route.length}/${config.maxRouteLength} tiles.`
              : `Click a tile to privately check the 3×3 around it for ${tool === "trap" ? "traps" : "loot"}. Costs ${config.scanPrice} gold. Only you can read the answer.`}
          </p>
          <div className="controls">
            <Button
              tone="primary"
              icon={<Footprints size={16} aria-hidden />}
              disabled={!ready || !claimed || !canAfford(config.ticketPrice) || ended}
              busy={busy === "raid"}
              onClick={doRaid}
            >
              Raid for {config.ticketPrice.toString()} gold
            </Button>
            <Button tone="ghost" icon={<Undo2 size={16} aria-hidden />} disabled={route.length === 0} onClick={() => setRoute((r) => r.slice(0, -1))}>
              Undo step
            </Button>
            <Button tone="ghost" icon={<RotateCcw size={16} aria-hidden />} disabled={route.length === 0} onClick={() => setRoute([])}>
              Clear
            </Button>
          </div>
          <p className="hint">
            Caught: your ticket goes to {owner}. Escaped: you get it back plus any stash you walked over. About one trap in four
            jams on any raid, so a trap can click and let you live.
          </p>
        </div>

        {lastPlayed && playback.done && (
          <div className="panel result" data-tone={lastPlayed.escaped ? "escaped" : "caught"} role="status">
            <p className="result-title">{lastPlayed.escaped ? "You got out" : "Snap"}</p>
            <p style={{ margin: 0 }}>{summary(lastPlayed, config.stashValue)}</p>
            {lastPlayed.clicks !== 0n && (
              <p className="hint">A trap clicked under you and jammed. Now you know where it is.</p>
            )}
            <div className="controls">
              <Button size="sm" onClick={() => playback.play(lastPlayed)}>
                Replay
              </Button>
              <Button size="sm" tone="ghost" onClick={playback.clear}>
                Plan another run
              </Button>
            </div>
          </div>
        )}

        <div className="panel">
          <h3>Vault {vault.id + 1}</h3>
          <dl className="stat-row">
            <div className="stat">
              <dt>Owner</dt>
              <dd>{owner}</dd>
            </div>
            <div className="stat">
              <dt>Raids</dt>
              <dd>
                {vault.raidCount}/{config.maxRaidsPerVault}
              </dd>
            </div>
            <div className="stat">
              <dt>Closes in</dt>
              <dd>{duration(vault.expiresAt - now)}</dd>
            </div>
          </dl>
          {mine.length > 0 && (
            <>
              <h3 style={{ marginTop: "var(--s4)" }}>Your runs here</h3>
              <ul className="ledger">
                {mine
                  .slice()
                  .reverse()
                  .map((o) => (
                    <li key={o.index}>
                      <span className="who">#{o.index + 1}</span>
                      <span>{summary(o, config.stashValue)}</span>
                      <Button size="sm" tone="ghost" onClick={() => playback.play(o)}>
                        Replay
                      </Button>
                    </li>
                  ))}
              </ul>
            </>
          )}
          {(ended || isLocal) && (
            <div className="controls">
              {ended && (
                <Button tone="danger" busy={busy === "retire"} onClick={doRetire}>
                  Retire and open the books
                </Button>
              )}
              {!ended && isLocal && vault.isHouse && (
                <Button size="sm" tone="ghost" icon={<Clock size={14} aria-hidden />} busy={busy === "time"} onClick={skipTime}>
                  Local chain: skip to closing time
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="panel" style={{ padding: 0, border: 0, background: "none" }}>
          <SpyPanel vault={vault} raids={raids} />
        </div>
      </div>
    </div>
  );
}
