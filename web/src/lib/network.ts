import { Contract, JsonRpcProvider, type ContractRunner, type InterfaceAbi, type TransactionRequest } from "ethers";
import generated from "../generated/deployments.json";

type Deployment = { network: string; address: string; abi: InterfaceAbi; deployBlock: number };

function required(name: string): string {
  const value = import.meta.env[name] as string | undefined;
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env.local and fill it in.`);
  return value;
}

const chainId = Number(required("VITE_CHAIN_ID"));
const deployments = generated.deployments as Record<string, Deployment>;
const deployment = deployments[String(chainId)];

export const network = {
  chainId,
  rpcUrl: required("VITE_RPC_URL"),
  fheMode: required("VITE_FHE_MODE") as "mock" | "relayer",
  explorerUrl: (import.meta.env.VITE_EXPLORER_URL as string | undefined) || "",
  faucetKey: (import.meta.env.VITE_LOCAL_FAUCET_KEY as string | undefined) || "",
  faucetAmount: (import.meta.env.VITE_LOCAL_FAUCET_AMOUNT as string | undefined) || "",
  deployment,
};

const PIN_WINDOW_MS = 60_000;
const MISSING_BLOCK_RETRY_MS = 1500;
const MISSING_BLOCK_RETRIES = 30;
const MISSING_BLOCK = /header not found|unknown block|block not found|missing trie node|no state available/i;

/**
 * Public RPCs are load-balanced, so a read right after our own transaction can land on a node that has
 * not seen it yet. For a short window after each write, contract reads are pinned to that block and
 * retried until a node that has the block answers. Genuine reverts are never retried.
 */
class ConsistentProvider extends JsonRpcProvider {
  #pin: { block: number; until: number } | null = null;

  pinAfterWrite(block: number) {
    if (!this.#pin || block >= this.#pin.block) this.#pin = { block, until: Date.now() + PIN_WINDOW_MS };
  }

  override async call(tx: TransactionRequest): Promise<string> {
    const pin = this.#pin;
    if (!pin || tx.blockTag != null || Date.now() > pin.until) return super.call(tx);
    for (let attempt = 1; ; attempt++) {
      try {
        return await super.call({ ...tx, blockTag: pin.block });
      } catch (error) {
        const message = String((error as { message?: string })?.message ?? error);
        if (attempt >= MISSING_BLOCK_RETRIES || !MISSING_BLOCK.test(message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, MISSING_BLOCK_RETRY_MS));
      }
    }
  }
}

export const provider = new ConsistentProvider(network.rpcUrl, chainId, { staticNetwork: true });

export function snareAddress(): string {
  if (!deployment) {
    throw new Error(`No Snare deployment for chain ${chainId}. Deploy, then run "npm run sync".`);
  }
  return deployment.address;
}

export function snare(runner: ContractRunner = provider): Contract {
  return new Contract(snareAddress(), generated.abi as InterfaceAbi, runner);
}

export function txLink(hash: string): string | null {
  return network.explorerUrl ? `${network.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null;
}

export function addressLink(address: string): string | null {
  return network.explorerUrl ? `${network.explorerUrl.replace(/\/$/, "")}/address/${address}` : null;
}
