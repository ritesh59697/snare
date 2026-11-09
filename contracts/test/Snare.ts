import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, fhevm } from "hardhat";
import { Snare, Snare__factory } from "../types";

const config = JSON.parse(readFileSync(join(__dirname, "../config/game.json"), "utf8"));

const WIDTH = 8;
const tile = (x: number, y: number) => y * WIDTH + x;
const column = (x: number) => Array.from({ length: WIDTH }, (_, y) => tile(x, y));

// Traps fill the right edge of the grid, so columns 0-5 are always clean.
const TRAPS = Array.from({ length: config.trapCount }, (_, i) => tile(7, i));
// Stashes sit in column 0, so a straight run up it collects all of them.
const STASHES = Array.from({ length: config.stashCount }, (_, i) => tile(0, i + 1));
const CLEAN_RUN = column(0);
const TRAPPED_RUN = column(7);

describe("Snare", function () {
  let owner: HardhatEthersSigner;
  let raider: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let game: Snare;
  let address: string;

  before(async function () {
    [owner, raider, stranger] = await ethers.getSigners();
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    const factory = (await ethers.getContractFactory("Snare")) as Snare__factory;
    game = (await factory.deploy(config)) as Snare;
    address = await game.getAddress();
    await (await game.connect(owner).claimStarter()).wait();
    await (await game.connect(raider).claimStarter()).wait();
  });

  async function createVault(signer = owner, traps = TRAPS, stashes = STASHES) {
    const input = fhevm.createEncryptedInput(address, signer.address);
    for (const position of [...traps, ...stashes]) input.add8(position);
    const encrypted = await input.encrypt();
    const handles = encrypted.handles;
    const tx = await game
      .connect(signer)
      .createVault(handles.slice(0, traps.length), handles.slice(traps.length), encrypted.inputProof);
    await tx.wait();
    return Number(await game.vaultCount()) - 1;
  }

  const decrypt = (handle: string, signer: HardhatEthersSigner) =>
    fhevm.userDecryptEuint(FhevmType.euint64, handle, address, signer);

  const goldOf = async (signer: HardhatEthersSigner) => decrypt(await game.goldOf(signer.address), signer);

  async function raidResult(vaultId: number, index: number, signer = raider) {
    const raid = await game.getRaid(vaultId, index);
    return {
      traveled: await decrypt(raid.traveled, signer),
      clicks: await decrypt(raid.clicks, signer),
      payout: await decrypt(raid.payout, signer),
      escaped: await fhevm.userDecryptEbool(raid.escaped, address, signer),
    };
  }

  const maskOf = (tiles: number[]) => tiles.reduce((mask, t) => mask | (1n << BigInt(t)), 0n);

  async function revealAndVerify(vaultId: number) {
    const handles = await game.revealHandles(vaultId);
    const { abiEncodedClearValues, decryptionProof, clearValues } = await fhevm.publicDecrypt([...handles]);
    await (await game.verifyReveal(vaultId, abiEncodedClearValues, decryptionProof)).wait();
    return { handles, clearValues };
  }

  describe("gold", function () {
    it("grants the starter balance once, readable by the player", async function () {
      expect(await goldOf(raider)).to.eq(BigInt(config.starterGold));
      await expect(game.connect(raider).claimStarter()).to.be.revertedWithCustomError(game, "AlreadyClaimed");
    });

    it("hides a balance from everyone else", async function () {
      const handle = await game.goldOf(raider.address);
      await expect(decrypt(handle, stranger)).to.be.rejected;
    });
  });

  describe("createVault", function () {
    it("charges the owner for the stashes and builds exact masks", async function () {
      const id = await createVault();
      const vault = await game.getVault(id);
      expect(await decrypt(vault.traps, owner)).to.eq(maskOf(TRAPS));
      for (let i = 0; i < STASHES.length; i++) {
        expect(await decrypt(vault.stashes[i], owner)).to.eq(maskOf([STASHES[i]]));
      }
      const cost = BigInt(config.stashValue) * BigInt(config.stashCount);
      expect(await goldOf(owner)).to.eq(BigInt(config.starterGold) - cost);
    });

    it("rejects any budget other than the configured one", async function () {
      const input = fhevm.createEncryptedInput(address, owner.address);
      for (const position of [...TRAPS, 0, ...STASHES]) input.add8(position);
      const { handles, inputProof } = await input.encrypt();
      await expect(
        game
          .connect(owner)
          .createVault(handles.slice(0, TRAPS.length + 1), handles.slice(TRAPS.length + 1), inputProof),
      ).to.be.revertedWithCustomError(game, "WrongLayoutSize");
    });

    it("wraps out-of-range positions onto the grid", async function () {
      const id = await createVault(owner, [64 + 3, ...TRAPS.slice(1)]);
      const vault = await game.getVault(id);
      expect(await decrypt(vault.traps, owner)).to.eq(maskOf([3, ...TRAPS.slice(1)]));
    });

    it("creates empty stashes when the owner cannot pay", async function () {
      const cost = config.stashValue * config.stashCount;
      const vaultsAffordable = Math.floor(config.starterGold / cost);
      for (let i = 0; i < vaultsAffordable; i++) await createVault();
      const id = await createVault();
      const vault = await game.getVault(id);
      for (const stash of vault.stashes) expect(await decrypt(stash, owner)).to.eq(0n);
      expect(await goldOf(owner)).to.eq(BigInt(config.starterGold - vaultsAffordable * cost));
    });

    it("keeps the layout from the raider and from strangers", async function () {
      const id = await createVault();
      const vault = await game.getVault(id);
      await expect(decrypt(vault.traps, raider)).to.be.rejected;
      await expect(decrypt(vault.stashes[0], stranger)).to.be.rejected;
    });
  });

  describe("raid", function () {
    it("pays stashes on a clean escape and returns the ticket", async function () {
      const id = await createVault();
      await (await game.connect(raider).raid(id, CLEAN_RUN)).wait();

      const result = await raidResult(id, 0);
      expect(result.escaped).to.eq(true);
      expect(result.traveled).to.eq(maskOf(CLEAN_RUN));
      expect(result.clicks).to.eq(0n);
      const looted = BigInt(config.stashValue) * BigInt(config.stashCount);
      expect(result.payout).to.eq(looted);
      expect(await goldOf(raider)).to.eq(BigInt(config.starterGold) + looted);
    });

    it("removes looted stashes for later raiders without any visible change", async function () {
      const id = await createVault();
      await (await game.connect(raider).raid(id, CLEAN_RUN)).wait();
      await (await game.connect(stranger).claimStarter()).wait();
      await (await game.connect(stranger).raid(id, CLEAN_RUN)).wait();

      const second = await raidResult(id, 1, stranger);
      expect(second.escaped).to.eq(true);
      expect(second.payout).to.eq(0n);
      const vault = await game.getVault(id);
      for (const stash of vault.remaining) expect(await decrypt(stash, owner)).to.eq(0n);
    });

    it("stops a caught raider at the trap and hands the ticket to the owner", async function () {
      const id = await createVault();
      const ownerBefore = await goldOf(owner);
      // Every jam is random, so retry until a trap fires, then check the books for that raid.
      let caught = false;
      let index = 0;
      while (!caught && index < config.maxRaidsPerVault) {
        await (await game.connect(raider).raid(id, TRAPPED_RUN)).wait();
        caught = !(await raidResult(id, index)).escaped;
        index++;
      }
      expect(caught, "no trap fired in the allowed raids").to.eq(true);

      const result = await raidResult(id, index - 1);
      expect(result.payout).to.eq(0n);
      const lastTile = [...TRAPPED_RUN].reverse().find((t) => (result.traveled >> BigInt(t)) & 1n);
      expect(TRAPS).to.include(lastTile);
      // Nothing past the trap may be visible to the raider.
      const beyond = TRAPPED_RUN.slice(TRAPPED_RUN.indexOf(lastTile!) + 1);
      expect(result.traveled & maskOf(beyond)).to.eq(0n);
      expect(await goldOf(owner)).to.be.greaterThan(ownerBefore);
    });

    it("lets the owner read the result but not a stranger", async function () {
      const id = await createVault();
      await (await game.connect(raider).raid(id, CLEAN_RUN)).wait();
      const raid = await game.getRaid(id, 0);
      expect(await decrypt(raid.traveled, owner)).to.eq(maskOf(CLEAN_RUN));
      await expect(decrypt(raid.traveled, stranger)).to.be.rejected;
    });

    it("turns away a raider who cannot pay, without leaking it through a revert", async function () {
      const id = await createVault();
      const afford = Math.floor(config.starterGold / config.scanPrice);
      for (let i = 0; i < afford; i++) {
        await (await game.connect(raider).scan(id, 0, false)).wait();
      }
      expect(await goldOf(raider)).to.be.lessThan(BigInt(config.ticketPrice));
      const before = await goldOf(raider);

      await (await game.connect(raider).raid(id, CLEAN_RUN)).wait();
      const result = await raidResult(id, 0);
      expect(result.traveled).to.eq(0n);
      expect(result.escaped).to.eq(false);
      expect(result.payout).to.eq(0n);
      expect(await goldOf(raider)).to.eq(before);
    });

    it("refuses to let the owner raid their own vault", async function () {
      const id = await createVault();
      await expect(game.connect(owner).raid(id, CLEAN_RUN)).to.be.revertedWithCustomError(game, "OwnVault");
    });

    it("rejects malformed routes", async function () {
      const id = await createVault();
      const raid = (route: number[]) => game.connect(raider).raid(id, route);

      await expect(raid(column(0).slice(0, WIDTH - 1))).to.be.revertedWithCustomError(game, "RouteLength");
      await expect(
        raid(
          column(0)
            .map((t) => t + 0)
            .reverse(),
        ),
      ).to.be.revertedWithCustomError(game, "BadStart");
      await expect(raid([...column(0).slice(0, 7), tile(1, 6)])).to.be.revertedWithCustomError(game, "BadExit");
      await expect(raid([0, 1, 2, 3, 4, 5, 6, 7, 15, 23, 31, 39, 47, 55, 63, 64])).to.be.revertedWithCustomError(
        game,
        "TileOutOfRange",
      );
      await expect(raid([0, 9, 17, 25, 33, 41, 49, 57])).to.be.revertedWithCustomError(game, "NotAdjacent");
      // Tile 7 to tile 8 is numerically adjacent but wraps around the grid edge.
      await expect(raid([7, 8, 16, 24, 32, 40, 48, 56])).to.be.revertedWithCustomError(game, "NotAdjacent");
      await expect(raid([0, 1, 0, 8, 16, 24, 32, 40, 48, 56])).to.be.revertedWithCustomError(game, "TileRepeated");

      const snake: number[] = [];
      for (let y = 0; y < WIDTH; y++) {
        for (let i = 0; i < WIDTH; i++) snake.push(tile(y % 2 === 0 ? i : WIDTH - 1 - i, y));
      }
      expect(snake.length).to.be.greaterThan(config.maxRouteLength);
      await expect(raid(snake)).to.be.revertedWithCustomError(game, "RouteLength");
    });

    it("fits a longest-allowed route inside the transaction limits", async function () {
      const id = await createVault();
      // Zigzag sideways while the budget allows, then climb straight to the exit row.
      const route = [tile(0, 0)];
      let [x, y, step] = [0, 0, 1];
      while (y < WIDTH - 1) {
        const spare = config.maxRouteLength - route.length > WIDTH - 1 - y;
        const nx = x + step;
        if (spare && nx >= 0 && nx < WIDTH) {
          x = nx;
        } else {
          y++;
          if (nx < 0 || nx >= WIDTH) step = -step;
        }
        route.push(tile(x, y));
      }
      expect(route.length).to.eq(config.maxRouteLength);
      expect(route[route.length - 1]).to.be.at.least(WIDTH * (WIDTH - 1));
      // Zama's HCULimit contract runs inside the mock and reverts on overflow, so reaching here proves the fit.
      const receipt = await (await game.connect(raider).raid(id, route)).wait();
      const hcu = fhevm.computeTransactionHCU(receipt!);
      console.log(
        `      route of ${route.length} tiles: ${receipt!.gasUsed} gas, ${hcu.globalHCU} HCU, depth ${hcu.maxHCUDepth}`,
      );
    });
  });

  describe("scan", function () {
    it("answers privately and charges the scanner", async function () {
      const id = await createVault();
      const scanAt = async (center: number, forStash: boolean, index: number) => {
        await (await game.connect(raider).scan(id, center, forStash)).wait();
        const scans = await game.getScans(id, raider.address);
        return fhevm.userDecryptEbool(scans[index].found, address, raider);
      };

      expect(await scanAt(tile(7, 0), false, 0)).to.eq(true);
      expect(await scanAt(tile(1, 7), false, 1)).to.eq(false);
      expect(await scanAt(tile(0, 1), true, 2)).to.eq(true);
      expect(await scanAt(tile(5, 5), true, 3)).to.eq(false);
      expect(await goldOf(raider)).to.eq(BigInt(config.starterGold - 4 * config.scanPrice));

      const scans = await game.getScans(id, raider.address);
      await expect(fhevm.userDecryptEbool(scans[0].found, address, stranger)).to.be.rejected;
    });

    it("stops seeing a stash once it is looted", async function () {
      const id = await createVault();
      await (await game.connect(raider).raid(id, CLEAN_RUN)).wait();
      await (await game.connect(stranger).claimStarter()).wait();
      await (await game.connect(stranger).scan(id, tile(0, 1), true)).wait();
      const [scan] = await game.getScans(id, stranger.address);
      expect(await fhevm.userDecryptEbool(scan.found, address, stranger)).to.eq(false);
    });
  });

  describe("areaMask", function () {
    it("clips at the corners and keeps nine tiles in the middle", async function () {
      expect(await game.areaMask(tile(0, 0))).to.eq(maskOf([0, 1, 8, 9]));
      expect(await game.areaMask(tile(7, 7))).to.eq(maskOf([54, 55, 62, 63]));
      expect(await game.areaMask(tile(3, 3))).to.eq(
        maskOf([
          tile(2, 2),
          tile(3, 2),
          tile(4, 2),
          tile(2, 3),
          tile(3, 3),
          tile(4, 3),
          tile(2, 4),
          tile(3, 4),
          tile(4, 4),
        ]),
      );
      await expect(game.areaMask(64)).to.be.revertedWithCustomError(game, "TileOutOfRange");
    });
  });

  describe("house vaults", function () {
    it("spawn a random layout nobody can read, within budget", async function () {
      await (await game.connect(stranger).createHouseVault()).wait();
      const vault = await game.getVault(0);
      expect(vault.owner).to.eq(ethers.ZeroAddress);
      await expect(decrypt(vault.traps, stranger)).to.be.rejected;
      await expect(decrypt(vault.traps, owner)).to.be.rejected;

      await (await game.connect(raider).raid(0, CLEAN_RUN)).wait();
      await expect(game.connect(stranger).retire(0)).to.be.revertedWithCustomError(game, "NotAllowedToRetire");
      await time.increase(config.vaultLifetime);
      await (await game.connect(stranger).retire(0)).wait();

      const { handles, clearValues } = await revealAndVerify(0);
      const traps = clearValues[handles[0] as `0x${string}`] as bigint;
      const bits = traps.toString(2).split("1").length - 1;
      expect(bits).to.be.greaterThan(0);
      expect(bits).to.be.at.most(config.trapCount);
    });
  });

  describe("retire and verify", function () {
    it("refunds unlooted stashes to the owner", async function () {
      const id = await createVault();
      const before = await goldOf(owner);
      await (await game.connect(owner).retire(id)).wait();
      const refund = BigInt(config.stashValue) * BigInt(config.stashCount);
      expect(await goldOf(owner)).to.eq(before + refund);
    });

    it("does not refund a stash that was looted", async function () {
      const id = await createVault();
      await (await game.connect(raider).raid(id, CLEAN_RUN)).wait();
      const before = await goldOf(owner);
      await (await game.connect(owner).retire(id)).wait();
      expect(await goldOf(owner)).to.eq(before);
    });

    it("limits who can retire and closes the vault to raids", async function () {
      const id = await createVault();
      await expect(game.connect(stranger).retire(id)).to.be.revertedWithCustomError(game, "NotAllowedToRetire");
      await (await game.connect(owner).retire(id)).wait();
      await expect(game.connect(owner).retire(id)).to.be.revertedWithCustomError(game, "VaultClosed");
      await expect(game.connect(raider).raid(id, CLEAN_RUN)).to.be.revertedWithCustomError(game, "VaultClosed");
    });

    it("closes a vault to raids once it expires", async function () {
      const id = await createVault();
      await time.increase(config.vaultLifetime);
      await expect(game.connect(raider).raid(id, CLEAN_RUN)).to.be.revertedWithCustomError(game, "VaultClosed");
      await (await game.connect(stranger).retire(id)).wait();
    });

    it("keeps the layout sealed until retirement", async function () {
      const id = await createVault();
      const vault = await game.getVault(id);
      await expect(fhevm.publicDecrypt([vault.traps])).to.be.rejected;
      await expect(game.verifyReveal(id, "0x", "0x")).to.be.revertedWithCustomError(game, "NotRetired");
    });

    it("publishes the layout and replays every raid on-chain", async function () {
      const id = await createVault();
      await (await game.connect(raider).raid(id, CLEAN_RUN)).wait();
      await (await game.connect(raider).raid(id, TRAPPED_RUN)).wait();
      await (await game.connect(raider).raid(id, column(3))).wait();
      await (await game.connect(owner).retire(id)).wait();

      await revealAndVerify(id);

      const vault = await game.getVault(id);
      expect(vault.status).to.eq(2n);
      expect(vault.clearTraps).to.eq(maskOf(TRAPS));
      expect(vault.clearStashes).to.deep.eq(STASHES.map((t) => maskOf([t])));
    });

    it("agrees with the plaintext replay when a trap is jammed", async function () {
      const id = await createVault();
      for (let i = 0; i < 6; i++) await (await game.connect(raider).raid(id, TRAPPED_RUN)).wait();
      await (await game.connect(owner).retire(id)).wait();
      const { handles, clearValues } = await revealAndVerify(id);

      const first = 1 + STASHES.length;
      for (let r = 0; r < 6; r++) {
        const jam = clearValues[handles[first + r * 4] as `0x${string}`] as bigint;
        const traveled = clearValues[handles[first + r * 4 + 1] as `0x${string}`] as bigint;
        const [expected] = await game.replayRoute(maskOf(TRAPS), jam, TRAPPED_RUN);
        expect(traveled).to.eq(expected);
        const clicks = await decrypt((await game.getRaid(id, r)).clicks, raider);
        expect(clicks).to.eq(maskOf(TRAPS) & jam & traveled);
      }
    });

    it("rejects tampered cleartexts", async function () {
      const id = await createVault();
      await (await game.connect(owner).retire(id)).wait();
      const handles = await game.revealHandles(id);
      const { abiEncodedClearValues, decryptionProof } = await fhevm.publicDecrypt([...handles]);
      const tampered = abiEncodedClearValues.slice(0, -1) + (abiEncodedClearValues.endsWith("0") ? "1" : "0");
      await expect(game.verifyReveal(id, tampered, decryptionProof)).to.be.reverted;
    });

    it("cannot be verified twice", async function () {
      const id = await createVault();
      await (await game.connect(owner).retire(id)).wait();
      await revealAndVerify(id);
      await expect(game.verifyReveal(id, "0x", "0x")).to.be.revertedWithCustomError(game, "VaultClosed");
    });

    it("retires a full vault for anyone", async function () {
      const small = { ...config, maxRaidsPerVault: 1 };
      const factory = (await ethers.getContractFactory("Snare")) as Snare__factory;
      game = (await factory.deploy(small)) as Snare;
      address = await game.getAddress();
      await (await game.connect(owner).claimStarter()).wait();
      await (await game.connect(raider).claimStarter()).wait();
      const id = await createVault();
      await (await game.connect(raider).raid(id, CLEAN_RUN)).wait();
      await expect(game.connect(raider).raid(id, CLEAN_RUN)).to.be.revertedWithCustomError(game, "VaultClosed");
      await (await game.connect(stranger).retire(id)).wait();
    });
  });

  describe("constructor", function () {
    it("refuses a trap budget that could wall off the grid", async function () {
      const factory = (await ethers.getContractFactory("Snare")) as Snare__factory;
      await expect(factory.deploy({ ...config, trapCount: WIDTH })).to.be.revertedWithCustomError(
        game,
        "InvalidConfig",
      );
    });
  });
});
