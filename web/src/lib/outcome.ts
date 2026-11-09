import { has, tileName, tilesOf } from "./grid";

export type Outcome = {
  index: number;
  raider: string;
  route: number[];
  traveled: bigint;
  clicks: bigint;
  escaped: boolean;
  payout: bigint;
  /** Route tiles actually walked, in order. */
  steps: number;
  caughtAt: number | null;
  turnedAway: boolean;
};

export function outcome(
  index: number,
  raider: string,
  route: number[],
  traveled: bigint,
  clicks: bigint,
  escaped: boolean,
  payout: bigint,
): Outcome {
  let steps = 0;
  while (steps < route.length && has(traveled, route[steps])) steps++;
  const turnedAway = traveled === 0n;
  const caughtAt = !escaped && !turnedAway ? route[steps - 1] : null;
  return { index, raider, route, traveled, clicks, escaped, payout, steps, caughtAt, turnedAway };
}

export function summary(o: Outcome, stashValue: bigint): string {
  if (o.turnedAway) return "Turned away: not enough gold for the ticket";
  if (o.caughtAt !== null) return `Caught on ${tileName(o.caughtAt)} after ${o.steps} steps`;
  const loot = stashValue > 0n ? Number(o.payout / stashValue) : 0;
  return loot > 0 ? `Escaped with ${loot} stash${loot === 1 ? "" : "es"} (+${o.payout})` : "Escaped empty-handed";
}

export function clickedTiles(o: Outcome): number[] {
  return tilesOf(o.clicks);
}
