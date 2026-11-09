// Copies what the frontend needs from the contracts package and the relayer SDK.
// - Every Snare deployment under contracts/deployments becomes src/generated/deployments.json,
//   keyed by chain id, so addresses and the ABI are never written by hand.
// - The relayer SDK browser bundle (JS + WASM) is self-hosted under public/relayer-sdk.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentsDir = join(root, "../contracts/deployments");
const artifactPath = join(root, "../contracts/artifacts/contracts/Snare.sol/Snare.json");

const deployments = {};
if (existsSync(deploymentsDir)) {
  for (const network of readdirSync(deploymentsDir)) {
    const file = join(deploymentsDir, network, "Snare.json");
    const chainIdFile = join(deploymentsDir, network, ".chainId");
    if (!existsSync(file) || !existsSync(chainIdFile)) continue;
    const chainId = readFileSync(chainIdFile, "utf8").trim();
    const { address, abi, receipt } = JSON.parse(readFileSync(file, "utf8"));
    deployments[chainId] = { network, address, abi, deployBlock: receipt?.blockNumber ?? 0 };
  }
}

// Fall back to the compiled ABI so the app still type-checks before any deployment exists.
const abi = existsSync(artifactPath) ? JSON.parse(readFileSync(artifactPath, "utf8")).abi : [];

mkdirSync(join(root, "src/generated"), { recursive: true });
writeFileSync(join(root, "src/generated/deployments.json"), JSON.stringify({ abi, deployments }, null, 2));
console.log(`synced deployments for chain ids: ${Object.keys(deployments).join(", ") || "none"}`);

const sdkBundle = join(root, "node_modules/@zama-fhe/relayer-sdk/bundle");
const publicSdk = join(root, "public/relayer-sdk");
mkdirSync(publicSdk, { recursive: true });
for (const file of readdirSync(sdkBundle)) copyFileSync(join(sdkBundle, file), join(publicSdk, file));
console.log("copied relayer SDK bundle to public/relayer-sdk");
