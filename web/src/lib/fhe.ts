import { type Signer, ZeroHash } from "ethers";
import { network, provider, snareAddress } from "./network";

export type ClearValue = bigint | boolean | `0x${string}`;

/** The subset of the relayer SDK instance Snare uses. The Hardhat mock implements the same calls. */
export type Fhe = {
  createEncryptedInput(contract: string, user: string): {
    add8(value: number | bigint): unknown;
    encrypt(): Promise<{ handles: Uint8Array[]; inputProof: Uint8Array }>;
  };
  generateKeypair(): { publicKey: string; privateKey: string };
  createEIP712(
    publicKey: string,
    contracts: string[],
    start: number,
    days: number,
  ): {
    domain: Record<string, unknown>;
    types: { UserDecryptRequestVerification: readonly { name: string; type: string }[] };
    message: Record<string, unknown>;
  };
  userDecrypt(
    pairs: { handle: string; contractAddress: string }[],
    privateKey: string,
    publicKey: string,
    signature: string,
    contracts: string[],
    user: string,
    start: number,
    days: number,
  ): Promise<Record<string, ClearValue>>;
  publicDecrypt(handles: string[]): Promise<{
    clearValues: Record<string, ClearValue>;
    abiEncodedClearValues: `0x${string}`;
    decryptionProof: `0x${string}`;
  }>;
};

let instance: Promise<Fhe> | null = null;

export function fhe(): Promise<Fhe> {
  instance ??= (network.fheMode === "mock" ? createMock() : createRelayer()).catch((error) => {
    instance = null;
    throw error;
  });
  return instance;
}

async function createMock(): Promise<Fhe> {
  // The mock still uses the SDK's real KMS keypair code for user decryption, so load its WASM.
  const { initSDK } = await import("@zama-fhe/relayer-sdk/web");
  await initSDK();
  const { MockFhevmInstance, contracts } = await import("@fhevm/mock-utils");
  const meta = await provider.send("fhevm_relayer_metadata", []);
  const inputVerifier = await contracts.InputVerifier.create(provider, meta.InputVerifierAddress);
  const kmsVerifier = await contracts.KMSVerifier.create(provider, meta.KMSVerifierAddress);
  const mock = await MockFhevmInstance.create(
    provider,
    provider,
    {
      aclContractAddress: meta.ACLAddress,
      chainId: meta.chainId,
      gatewayChainId: meta.gatewayChainId,
      inputVerifierContractAddress: meta.InputVerifierAddress,
      kmsContractAddress: meta.KMSVerifierAddress,
      verifyingContractAddressDecryption: kmsVerifier.gatewayDecryptionAddress,
      verifyingContractAddressInputVerification: inputVerifier.gatewayInputVerificationAddress,
    },
    {
      inputVerifierProperties: inputVerifier.inputVerifierProperties,
      kmsVerifierProperties: kmsVerifier.kmsVerifierProperties,
    },
  );
  return mock as unknown as Fhe;
}

async function createRelayer(): Promise<Fhe> {
  // Self-hosted copy of the relayer SDK browser bundle (see scripts/sync.mjs). Loading it at
  // runtime keeps the WASM next to the module so its relative URLs resolve.
  const url = `${import.meta.env.BASE_URL}relayer-sdk/relayer-sdk-js.js`;
  const sdk = await import(/* @vite-ignore */ url);
  await sdk.initSDK();
  if (Number(sdk.SepoliaConfig.chainId) !== network.chainId) {
    throw new Error(`Relayer mode supports Sepolia only, but VITE_CHAIN_ID is ${network.chainId}.`);
  }
  return (await sdk.createInstance({ ...sdk.SepoliaConfig, network: network.rpcUrl })) as Fhe;
}

export const isEmpty = (handle: string) => !handle || handle === ZeroHash;

/** Encrypts tile positions (0-63) as euint8 inputs bound to the Snare contract and `user`. */
export async function encryptTiles(user: string, tiles: number[]) {
  const input = (await fhe()).createEncryptedInput(snareAddress(), user);
  for (const tile of tiles) input.add8(tile);
  const { handles, inputProof } = await input.encrypt();
  return { handles, inputProof };
}

type Session = { publicKey: string; privateKey: string; signature: string; start: number; days: number };
const SESSION_DAYS = 1;

/** One EIP-712 signature per player per day, then every user decryption reuses it. */
async function session(signer: Signer): Promise<Session> {
  const user = await signer.getAddress();
  const key = `snare.decrypt.${network.chainId}.${snareAddress()}.${user}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) ?? "null") as Session | null;
    if (cached && cached.start + cached.days * 86400 > now + 60) return cached;
  } catch {
    /* storage unavailable: sign a fresh session */
  }
  const instance = await fhe();
  const { publicKey, privateKey } = instance.generateKeypair();
  const eip712 = instance.createEIP712(publicKey, [snareAddress()], now, SESSION_DAYS);
  const signature = await signer.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: [...eip712.types.UserDecryptRequestVerification] },
    eip712.message,
  );
  const fresh = { publicKey, privateKey, signature, start: now, days: SESSION_DAYS };
  try {
    sessionStorage.setItem(key, JSON.stringify(fresh));
  } catch {
    /* fine: we just sign again next time */
  }
  return fresh;
}

/** Decrypts handles the signer has ACL access to. Empty handles decrypt to undefined. */
export async function userDecrypt(signer: Signer, handles: string[]): Promise<Map<string, ClearValue>> {
  const wanted = [...new Set(handles.filter((h) => !isEmpty(h)))];
  const result = new Map<string, ClearValue>();
  if (wanted.length === 0) return result;
  const s = await session(signer);
  const user = await signer.getAddress();
  const clear = await (await fhe()).userDecrypt(
    wanted.map((handle) => ({ handle, contractAddress: snareAddress() })),
    s.privateKey,
    s.publicKey,
    s.signature.replace(/^0x/, ""),
    [snareAddress()],
    user,
    s.start,
    s.days,
  );
  for (const [handle, value] of Object.entries(clear)) result.set(handle.toLowerCase(), value);
  return result;
}

export const read = (values: Map<string, ClearValue>, handle: string) => values.get(handle.toLowerCase());

export async function publicDecrypt(handles: string[]) {
  return (await fhe()).publicDecrypt(handles);
}
