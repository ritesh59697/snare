import { FhevmType } from "@fhevm/hardhat-plugin";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContractTransactionResponse, TransactionReceipt, TransactionResponse } from "ethers";
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
    // Public RPCs are load-balanced, so a read right after a receipt can hit a node a block behind, and
    // Zama's relayer can take a moment to see a new ACL grant. Reads are pinned to the receipt's block and
    // retried until a node that has it answers; decryptions are retried until the relayer catches up.
    const RETRY_MS = 2000;
    const RETRIES = 45;
    const retry = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await fn();
        } catch (error) {
          if (attempt >= RETRIES) throw error;
          if (attempt === 1) console.log(`  waiting for ${what} to catch up...`);
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      }
    };
    const send = async (label: string, fn: () => Promise<ContractTransactionResponse | TransactionResponse>) =>
      timed(label, async () => {
        const receipt = (await (await fn()).wait())!;
        gas[label] = receipt.gasUsed.toString();
        return receipt;
      });
    const eventArg = (receipt: TransactionReceipt, event: string, arg: string): bigint => {
      for (const log of receipt.logs) {
        const parsed = game.interface.parseLog(log);
        if (parsed?.name === event) return parsed.args[arg] as bigint;
      }
      throw new Error(`${event} not found in receipt`);
    };

    // Hardhat's own fee logic adds a fixed 1 gwei tip, far above what Sepolia needs. Every transaction
    // here uses the tip and base fee the network itself reports, with the max fee doubled for headroom.
    const feeData = await ethers.provider.getFeeData();
    if (feeData.maxFeePerGas === null || feeData.maxPriorityFeePerGas === null) {
      throw new Error("This network does not report EIP-1559 fees.");
    }
    const fees = { maxFeePerGas: feeData.maxFeePerGas * 2n, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas };
    const ownerStart = await ethers.provider.getBalance(owner.address);

    // A sender must hold gasLimit * maxFeePerGas up front. The block gas limit bounds any gasLimit, so this
    // covers each of the raider's transactions (claim, scan, raid) whatever they end up costing.
    const blockGasLimit = (await ethers.provider.getBlock("latest"))!.gasLimit;
    const raiderTxs = 3n;
    const raiderBudget = blockGasLimit * fees.maxFeePerGas * raiderTxs;
    if ((await ethers.provider.getBalance(raider.address)) < raiderBudget) {
      await send("fund raider", () => owner.sendTransaction({ to: raider.address, value: raiderBudget, ...fees }));
    }

    for (const player of [owner, raider]) {
      if (!(await game.hasClaimed(player.address))) {
        await send(`claim starter (${player === owner ? "owner" : "raider"})`, () =>
          game.connect(player).claimStarter(fees),
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
    const created = await send("create vault", () =>
      game
        .connect(owner)
        .createVault(
          encrypted.handles.slice(0, traps.length),
          encrypted.handles.slice(traps.length),
          encrypted.inputProof,
          fees,
        ),
    );
    const vaultId = eventArg(created, "VaultCreated", "vaultId");

    const scanned = await send("scan", () => game.connect(raider).scan(vaultId, 0, false, fees));
    const scanIndex = eventArg(scanned, "Scanned", "scanIndex");
    const scan = await retry("the RPC", async () => {
      const list = await game.getScans(vaultId, raider.address, { blockTag: scanned.blockNumber });
      if (list.length <= Number(scanIndex)) throw new Error("scan not visible yet");
      return list[Number(scanIndex)];
    });
    const found = await timed("user decrypt scan", () =>
      retry("the relayer", () => fhevm.userDecryptEbool(scan.found, address, raider)),
    );

    const route = Array.from({ length: width }, (_, y) => y * width);
    const raided = await send("raid", () => game.connect(raider).raid(vaultId, route, fees));
    const raidIndex = eventArg(raided, "Raided", "raidIndex");
    const raid = await retry("the RPC", () => game.getRaid(vaultId, raidIndex, { blockTag: raided.blockNumber }));
    const escaped = await timed("user decrypt raid outcome", () =>
      retry("the relayer", () => fhevm.userDecryptEbool(raid.escaped, address, raider)),
    );
    const payout = await timed("user decrypt payout", () =>
      retry("the relayer", () => fhevm.userDecryptEuint(FhevmType.euint64, raid.payout, address, raider)),
    );

    const retired = await send("retire", () => game.connect(owner).retire(vaultId, fees));
    const handles = await retry("the RPC", () => game.revealHandles(vaultId, { blockTag: retired.blockNumber }));
    const revealed = await timed("public decrypt history", () =>
      retry("the relayer", () => fhevm.publicDecrypt([...handles])),
    );
    await send("verify reveal (on-chain replay)", () =>
      game.verifyReveal(vaultId, revealed.abiEncodedClearValues, revealed.decryptionProof, fees),
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
      fees: { maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() },
      ownerSpentWei: (ownerStart - (await ethers.provider.getBalance(owner.address))).toString(),
    };
    const dir = join(hre.config.paths.root, "reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `latency-${network.name}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${file}`);
  },
);

/** Live EIP-1559 fees from the network, max fee doubled for headroom (Hardhat's default tip is 1 gwei). */
async function liveFees(hre: { ethers: typeof import("hardhat").ethers }) {
  const feeData = await hre.ethers.provider.getFeeData();
  if (feeData.maxFeePerGas === null || feeData.maxPriorityFeePerGas === null) {
    throw new Error("This network does not report EIP-1559 fees.");
  }
  return { maxFeePerGas: feeData.maxFeePerGas * 2n, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas };
}

// Tops up a player (for example a browser guest) with enough gas for a number of transactions, sized
// from the live block gas limit and fees:  npx hardhat --network sepolia snare:fund --to 0x... --txs 40
task("snare:fund", "Sends a player enough ETH for a number of Snare transactions at current fees")
  .addParam("to", "Address to fund")
  .addOptionalParam("txs", "How many transactions to cover", "40")
  .setAction(async ({ to, txs }: { to: string; txs: string }, hre) => {
    const { ethers } = hre;
    const [funder] = await ethers.getSigners();
    const fees = await liveFees(hre);
    const blockGasLimit = (await ethers.provider.getBlock("latest"))!.gasLimit;
    const value = blockGasLimit * fees.maxFeePerGas * BigInt(txs);
    const receipt = await (await funder.sendTransaction({ to, value, ...fees })).wait();
    console.log(`sent ${ethers.formatEther(value)} ETH to ${to} (tx ${receipt!.hash})`);
  });

// Retires a vault as its owner (account 0):  npx hardhat --network sepolia snare:retire --vault 0
task("snare:retire", "Retires a vault owned by account 0")
  .addParam("vault", "Vault id")
  .setAction(async ({ vault }: { vault: string }, hre) => {
    const { ethers, deployments } = hre;
    const game = await ethers.getContractAt("Snare", (await deployments.get("Snare")).address);
    const receipt = await (await game.retire(BigInt(vault), await liveFees(hre))).wait();
    console.log(`retired vault ${vault} (tx ${receipt!.hash})`);
  });
