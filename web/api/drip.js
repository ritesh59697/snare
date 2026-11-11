// Serverless function for the hosted site: sends a guest player enough test ETH to play, so nobody
// needs a faucet. The amount comes from live fees and the gas the game was measured to use
// (see scripts/package-site.mjs). The only secret is DRIP_KEY, a testnet-only wallet.
import { JsonRpcProvider, Wallet, getAddress, isAddress } from "ethers";
import settings from "./_drip-config.js";

const BPS = 10_000n;
const SEND_ATTEMPTS = 2;

// Best effort only: this memory lasts as long as one warm instance. The real bound on abuse is
// maxShareBps, which keeps any single top-up to a small share of what the drip wallet holds.
const recent = new Map();

function recentSends(caller) {
  const cutoff = Date.now() - settings.perCallerWindowSeconds * 1000;
  const times = (recent.get(caller) ?? []).filter((time) => time > cutoff);
  recent.set(caller, times);
  return times;
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST." });
  }
  const key = process.env.DRIP_KEY;
  if (!key) return response.status(503).json({ error: "The gas drip is not set up." });
  const raw = request.body?.address;
  if (typeof raw !== "string" || !isAddress(raw)) {
    return response.status(400).json({ error: "Send a player address." });
  }
  const to = getAddress(raw);

  try {
    const provider = new JsonRpcProvider(settings.rpcUrl, settings.chainId, { staticNetwork: true });
    const drip = new Wallet(key, provider);
    const [fees, balance, reserve] = await Promise.all([
      provider.getFeeData(),
      provider.getBalance(to),
      provider.getBalance(drip.address),
    ]);
    if (fees.maxFeePerGas === null || fees.maxPriorityFeePerGas === null) {
      return response.status(503).json({ error: "This network does not report fees the drip can use." });
    }

    // A wallet must hold gasLimit * maxFeePerGas before each transaction, so that is what gets covered.
    const amount =
      (BigInt(settings.gasPerTx) * fees.maxFeePerGas * BigInt(settings.txs) * BigInt(settings.headroomBps)) / BPS;
    if (balance * 2n >= amount) return response.status(200).json({ funded: false });
    if (amount > (reserve * BigInt(settings.maxShareBps)) / BPS) {
      return response.status(503).json({ error: "Network fees are too high for the gas drip right now." });
    }

    const caller = String(request.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
    const sends = recentSends(caller);
    if (sends.length >= settings.perCallerMax) {
      return response.status(429).json({ error: "Too many top-ups from this connection. Try again later." });
    }

    for (let attempt = 1; ; attempt++) {
      try {
        const tx = await drip.sendTransaction({
          to,
          value: amount,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        sends.push(Date.now());
        return response.status(200).json({ funded: true, hash: tx.hash, amount: amount.toString() });
      } catch (error) {
        // Two top-ups at once can pick the same nonce; the second one is simply sent again.
        if (attempt >= SEND_ATTEMPTS) throw error;
      }
    }
  } catch (error) {
    console.error("drip failed", error);
    return response.status(502).json({ error: "The gas drip could not send right now." });
  }
}
