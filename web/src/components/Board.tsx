import { ArrowUpFromLine, ArrowUpToLine, Bomb, Gem } from "lucide-react";
import { WIDTH, isEntry, isExit, tileName, tileOf, xOf, yOf } from "../lib/grid";

export type CellView = {
  trap?: boolean;
  stash?: boolean;
  looted?: boolean;
  scan?: "trap" | "clear" | "loot";
  caught?: boolean;
  click?: boolean;
  badge?: string;
};

type Props = {
  label: string;
  route?: number[];
  /** How many route tiles to draw; the rest stay hidden (used to animate a run). */
  shown?: number;
  views?: Map<number, CellView>;
  runnerAt?: number | null;
  isClickable?: (tile: number) => boolean;
  /** Tiles that would be the next step of a route being drawn; they get a small marker. */
  isNext?: (tile: number) => boolean;
  onTile?: (tile: number) => void;
};

const rows = Array.from({ length: WIDTH }, (_, i) => WIDTH - 1 - i);
const columns = Array.from({ length: WIDTH }, (_, x) => x);

export function Board({ label, route = [], shown, views, runnerAt = null, isClickable, isNext, onTile }: Props) {
  const visible = route.slice(0, shown ?? route.length);
  const order = new Map(visible.map((tile, i) => [tile, i]));
  const points = visible.map((t) => `${xOf(t) + 0.5},${WIDTH - 1 - yOf(t) + 0.5}`).join(" ");

  return (
    <div className="board">
      <div className="board-frame">
        <div className="board-band">
          <span>
            <ArrowUpToLine size={12} aria-hidden /> Exit
          </span>
        </div>
        <div className="board-grid">
        <div className="ranks" aria-hidden>
          {rows.map((y) => (
            <span key={y}>{y + 1}</span>
          ))}
        </div>
        <div className="cells" role="grid" aria-label={label}>
          {rows.map((y) =>
            columns.map((x) => {
              const tile = tileOf(x, y);
              const view = views?.get(tile) ?? {};
              const step = order.get(tile);
              const clickable = Boolean(onTile && isClickable?.(tile));
              const description = [
                tileName(tile),
                step !== undefined ? `route step ${step + 1}` : null,
                view.caught ? "caught here" : null,
                view.click ? "trap clicked, jammed" : null,
                view.trap && !view.caught && !view.click ? "trap" : null,
                view.stash ? (view.looted ? "looted stash" : "stash") : null,
                view.scan === "trap" ? "scan found a trap nearby" : null,
                view.scan === "clear" ? "scan found no trap nearby" : null,
                view.scan === "loot" ? "scan found loot nearby" : null,
              ]
                .filter(Boolean)
                .join(", ");
              return (
                <button
                  key={tile}
                  type="button"
                  className="cell"
                  role="gridcell"
                  aria-label={description}
                  tabIndex={clickable ? 0 : -1}
                  aria-disabled={!clickable}
                  data-clickable={clickable}
                  data-alt={(x + y) % 2 === 1}
                  data-next={clickable && step === undefined && Boolean(isNext?.(tile))}
                  data-entry={isEntry(tile)}
                  data-exit={isExit(tile)}
                  data-route={step !== undefined}
                  data-scan={view.scan}
                  data-trap={Boolean(view.trap || view.click)}
                  data-stash={Boolean(view.stash)}
                  data-looted={Boolean(view.looted)}
                  data-caught={Boolean(view.caught)}
                  data-click={Boolean(view.click)}
                  data-runner={runnerAt === tile}
                  onClick={clickable ? () => onTile?.(tile) : undefined}
                >
                  {step !== undefined && <span className="cell-index">{step + 1}</span>}
                  {runnerAt === tile && !view.caught ? (
                    <span className="runner" aria-hidden />
                  ) : view.caught || view.trap || view.click ? (
                    <Bomb size={20} strokeWidth={1.5} aria-hidden opacity={view.click ? 0.7 : 1} />
                  ) : view.stash ? (
                    <Gem size={20} strokeWidth={1.5} aria-hidden opacity={view.looted ? 0.35 : 1} />
                  ) : null}
                  {view.badge && <span className="cell-badge">{view.badge}</span>}
                </button>
              );
            }),
          )}
          {visible.length > 1 && (
            <svg className="route-line" viewBox={`0 0 ${WIDTH} ${WIDTH}`} preserveAspectRatio="none" aria-hidden>
              <polyline
                points={points}
                fill="none"
                stroke="var(--accent)"
                strokeOpacity="0.9"
                strokeWidth="0.07"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
        <span aria-hidden />
        <div className="files" aria-hidden>
          {columns.map((x) => (
            <span key={x}>{String.fromCharCode(65 + x)}</span>
          ))}
        </div>
        </div>
        <div className="board-band">
          <span>
            <ArrowUpFromLine size={12} aria-hidden /> Start
          </span>
        </div>
      </div>
    </div>
  );
}
