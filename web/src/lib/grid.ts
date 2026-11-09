// Plaintext mirror of the grid rules in Snare.sol. The contract stays the authority; these
// helpers only keep the UI from offering moves the contract would reject.

export const WIDTH = 8;
export const TILES = WIDTH * WIDTH;

export const tileOf = (x: number, y: number) => y * WIDTH + x;
export const xOf = (tile: number) => tile % WIDTH;
export const yOf = (tile: number) => Math.floor(tile / WIDTH);
export const bit = (tile: number) => 1n << BigInt(tile);
export const has = (mask: bigint, tile: number) => (mask & bit(tile)) !== 0n;
export const maskOf = (tiles: number[]) => tiles.reduce((mask, t) => mask | bit(t), 0n);
export const tilesOf = (mask: bigint) => Array.from({ length: TILES }, (_, t) => t).filter((t) => has(mask, t));

export const isEntry = (tile: number) => tile < WIDTH;
export const isExit = (tile: number) => tile >= TILES - WIDTH;

export function adjacent(a: number, b: number): boolean {
  const [low, high] = a < b ? [a, b] : [b, a];
  if (high - low === WIDTH) return true;
  return high - low === 1 && high % WIDTH !== 0;
}

/** Whether `tile` can be appended to `route` without breaking a contract rule. */
export function canExtend(route: number[], tile: number, maxLength: number): boolean {
  if (route.length >= maxLength) return false;
  if (route.length === 0) return isEntry(tile);
  if (route.includes(tile)) return false;
  const last = route[route.length - 1];
  if (isExit(last)) return false;
  return adjacent(last, tile);
}

export function routeComplete(route: number[], minLength: number): boolean {
  return route.length >= minLength && isEntry(route[0]) && isExit(route[route.length - 1]);
}

/** Same as Snare.replayRoute. */
export function replayRoute(traps: bigint, jam: bigint, route: number[]) {
  const armed = traps & ~jam;
  let traveled = 0n;
  for (const tile of route) {
    traveled |= bit(tile);
    if (has(armed, tile)) return { traveled, escaped: false, caughtAt: tile };
  }
  return { traveled, escaped: true, caughtAt: null as number | null };
}

/** Same as Snare.areaMask. */
export function areaTiles(center: number): number[] {
  const tiles: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = xOf(center) + dx;
      const y = yOf(center) + dy;
      if (x >= 0 && y >= 0 && x < WIDTH && y < WIDTH) tiles.push(tileOf(x, y));
    }
  }
  return tiles;
}

export const tileName = (tile: number) => `${String.fromCharCode(65 + xOf(tile))}${yOf(tile) + 1}`;
