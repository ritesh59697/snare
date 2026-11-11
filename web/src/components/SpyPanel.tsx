import { Wallet } from "ethers";
import { Eye, Lock, ScanEye } from "lucide-react";
import { useState } from "react";
import { userDecrypt } from "../lib/fhe";
import { decodeError, Status, type Raid, type Vault } from "../lib/game";
import { tileName } from "../lib/grid";
import { addressLink } from "../lib/network";
import { Button, shortAddress, shortHandle } from "./ui";

/** How many of the newest raids the panel lists. */
const LATEST_RAIDS = 2;

/** A sealed value as the chain stores it: a ciphertext handle. The lock marks everything encrypted. */
function Sealed({ kind, handle }: { kind: string; handle: string }) {
  return (
    <span className="sealed">
      <Lock size={12} strokeWidth={1.5} aria-hidden />
      <span title={handle}>{shortHandle(handle)}</span>
      <span className="kind">{kind}</span>
    </span>
  );
}

/** What anyone reading the chain sees for this vault: routes in the clear, everything else ciphertext. */
export function SpyPanel({ vault, raids }: { vault: Vault; raids: Raid[] }) {
  const [verdict, setVerdict] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);
  const link = addressLink(vault.owner);

  async function tryAsStranger() {
    setTrying(true);
    setVerdict(null);
    try {
      const stranger = Wallet.createRandom();
      await userDecrypt(stranger, [vault.traps]);
      setVerdict("Decrypted. This vault's layout is public now.");
    } catch (error) {
      setVerdict(`Refused: ${decodeError(error)}`);
    } finally {
      setTrying(false);
    }
  }

  const latest = raids.slice(-LATEST_RAIDS).reverse();

  return (
    <section className="panel spy" aria-labelledby="spy-title">
      <h3 id="spy-title">
        <ScanEye size={16} strokeWidth={1.5} aria-hidden /> What the chain shows everyone
      </h3>
      <dl>
        <div className="spy-row">
          <dt>Owner</dt>
          <dd>
            {vault.isHouse ? (
              "nobody (house vault)"
            ) : link ? (
              <a href={link} title={vault.owner}>
                {shortAddress(vault.owner)}
              </a>
            ) : (
              shortAddress(vault.owner)
            )}
          </dd>
        </div>
        <div className="spy-row">
          <dt>Traps</dt>
          <dd>
            <Sealed kind="euint64" handle={vault.traps} />
          </dd>
        </div>
        {vault.remaining.map((handle, i) => (
          <div className="spy-row" key={handle + i}>
            <dt>Stash {i + 1}</dt>
            <dd>
              <Sealed kind="euint64" handle={handle} />
            </dd>
          </div>
        ))}
        {latest.map((raid) => (
          <div className="spy-row" key={raid.index}>
            <dt>Raid {raid.index + 1}</dt>
            <dd>
              <span>{raid.route.map(tileName).join(" ")}</span>
              <Sealed kind="escaped · ebool" handle={raid.escaped} />
              <Sealed kind="payout · euint64" handle={raid.payout} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="controls">
        <Button tone="cipher" size="sm" icon={<Eye size={14} aria-hidden />} busy={trying} onClick={tryAsStranger}>
          Try to decrypt the traps as a stranger
        </Button>
      </div>
      {verdict && (
        <p className="spy-verdict" role="status">
          {verdict}
        </p>
      )}
      {vault.status !== Status.Verified && (
        <p className="hint">
          Routes are public. Traps, stashes, outcomes and gold stay ciphertext until the vault retires.
        </p>
      )}
    </section>
  );
}
