// Assembles the folder that is uploaded to Vercel: the built site plus the gas drip function.
//   node scripts/package-site.mjs <mode>     (run after `vite build --mode <mode>`)
// The drip's network comes from .env.<mode>, and its per-transaction gas from the measured round in
// ../contracts/reports, so nothing about the chain is written by hand.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (!mode) throw new Error("Usage: node scripts/package-site.mjs <mode>");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const env = loadEnv(mode, root, "VITE_");
const settings = readJson(join(root, "site.config.json"));
const pkg = readJson(join(root, "package.json"));
const dist = join(root, "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error(`No build in dist. Run "vite build --mode ${mode}" first.`);

const deployment = readJson(join(root, "src/generated/deployments.json")).deployments[env.VITE_CHAIN_ID];
if (!deployment) throw new Error(`No Snare deployment for chain ${env.VITE_CHAIN_ID}.`);
const reportPath = join(root, "../contracts/reports", `latency-${deployment.network}.json`);
if (!existsSync(reportPath)) {
  throw new Error(`No measured round at ${reportPath}. Run "npm run measure:${deployment.network}" in contracts.`);
}
// The costliest transaction of the measured round bounds what a guest needs per transaction.
const gasPerTx = Object.values(readJson(reportPath).gasUsed)
  .map(BigInt)
  .reduce((highest, used) => (used > highest ? used : highest), 0n);
if (gasPerTx === 0n) throw new Error(`${reportPath} has no gas figures.`);

const out = join(root, ".site", settings.vercelProject);
mkdirSync(out, { recursive: true });
// Keep .vercel: it links the folder to the hosted project.
for (const entry of readdirSync(out)) if (entry !== ".vercel") rmSync(join(out, entry), { recursive: true });

cpSync(dist, out, { recursive: true });
cpSync(join(root, "api"), join(out, "api"), { recursive: true });
const dripConfig = { ...settings.drip, gasPerTx: gasPerTx.toString(), rpcUrl: env.VITE_RPC_URL, chainId: Number(env.VITE_CHAIN_ID) };
writeFileSync(join(out, "api/_drip-config.js"), `export default ${JSON.stringify(dripConfig, null, 2)};\n`);
writeFileSync(
  join(out, "package.json"),
  JSON.stringify({ name: settings.vercelProject, private: true, type: "module", dependencies: { ethers: pkg.dependencies.ethers } }, null, 2),
);
console.log(`packaged ${out}\n  drip covers ${dripConfig.txs} transactions of up to ${gasPerTx} gas on chain ${dripConfig.chainId}`);
