import { Contract, JsonRpcProvider, type ContractRunner, type InterfaceAbi } from "ethers";
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

export const provider = new JsonRpcProvider(network.rpcUrl, chainId, { staticNetwork: true });

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
