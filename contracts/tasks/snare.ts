import { FhevmType } from "@fhevm/hardhat-plugin";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { task } from "hardhat/config";

// Plays one full Snare lifecycle on a live network and times every step, so the game's pacing is
// based on measured numbers rather than guesses:
//   npx hardhat --network sepolia snare:measure
// Account 0 owns a vault, account 1 raids it, then the vault retires and its books are verified.
task("snare:measure", "Plays a full round on the current network and records how long each step takes").setAction(
  async (_args, hre) => {
    const { ethers, fhevm, deployments, network } = hre;
    await fhevm.initializeCLIApi();

    const [owner, raider] = await ethers.getSigners();
    const deployment = await deployments.get("Snare");
    const address = deployment.address;
    const game = await ethers.getContractAt("Snare", address);
    const config = await game.config();
    const timings: Record<string, number> = {};
    const gas: Record<string, string> = {};

    const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      const result = await fn();
      timings[label] = Date.now() - started;
      console.log(`${label}: ${(timings[label] / 1000).toFixed(1)}s`);
      return result;
    };
    const send = async (label: string, fn: () => Promise<{ wait(): Promise<{ gasUsed: bigint } | null> }>) =>
      timed(label, async () => {
        const receipt = await (await fn()).wait();
        gas[label] = receipt!.gasUsed.toString();
        return receipt;
      });

    // The raider needs gas. Top it up from the owner with a margin computed from live gas prices.
    const feeData = await ethers.provider.getFeeData();
    const perGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const raiderBudget = perGas * 20_000_000n;
    if ((await ethers.provider.getBalance(raider.address)) < raiderBudget) {
      await send("fund raider", () => owner.sendTransaction({ to: raider.address, value: raiderBudget }));
    }

    for (const player of [owner, raider]) {
      if (!(await game.hasClaimed(player.address))) {
        await send(`claim starter (${player === owner ? "owner" : "raider"})`, () =>
          game.connect(player).claimStarter(),
        );
      }
    }

    // Traps on the right edge, stashes in column 0: a straight run up column 0 escapes with all of them.
    const width = Number(await game.GRID_WIDTH());
    const traps = Array.from({ length: Number(config.trapCount) }, (_, i) => i * width + (width - 1));
    const stashes = Array.from({ length: Number(config.stashCount) }, (_, i) => (i + 1) * width);
    const input = fhevm.createEncryptedInput(address, owner.address);
    for (const tile of [...traps, ...stashes]) input.add8(tile);
    const encrypted = await timed("encrypt layout (client)", () => input.encrypt());
    await send("create vault", () =>
      game
        .connect(owner)
        .createVault(
          encrypted.handles.slice(0, traps.length),
          encrypted.handles.slice(traps.length),
          encrypted.inputProof,
        ),
    );
    const vaultId = (await game.vaultCount()) - 1n;

    await send("scan", () => game.connect(raider).scan(vaultId, 0, false));
    const [scanned] = await game.getScans(vaultId, raider.address);
    const found = await timed("user decrypt scan", () => fhevm.userDecryptEbool(scanned.found, address, raider));

    const route = Array.from({ length: width }, (_, y) => y * width);
    await send("raid", () => game.connect(raider).raid(vaultId, route));
    const raid = await game.getRaid(vaultId, 0);
    const escaped = await timed("user decrypt raid outcome", () =>
      fhevm.userDecryptEbool(raid.escaped, address, raider),
    );
    const payout = await timed("user decrypt payout", () =>
      fhevm.userDecryptEuint(FhevmType.euint64, raid.payout, address, raider),
    );

    await send("retire", () => game.connect(owner).retire(vaultId));
    const handles = await game.revealHandles(vaultId);
    const revealed = await timed("public decrypt history", () => fhevm.publicDecrypt([...handles]));
    await send("verify reveal (on-chain replay)", () =>
      game.verifyReveal(vaultId, revealed.abiEncodedClearValues, revealed.decryptionProof),
    );

    const report = {
      network: network.name,
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      contract: address,
      vaultId: Number(vaultId),
      measuredAt: new Date().toISOString(),
      results: { scanFoundTrapNearA1: found, raidEscaped: escaped, raidPayout: payout.toString() },
      timingsMs: timings,
      gasUsed: gas,
    };
    const dir = join(hre.config.paths.root, "reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `latency-${network.name}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${file}`);
  },
);
