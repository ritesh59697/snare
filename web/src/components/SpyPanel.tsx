import { Wallet } from "ethers";
import { Eye, ScanEye } from "lucide-react";
import { useState } from "react";
import { userDecrypt } from "../lib/fhe";
import { decodeError, Status, type Raid, type Vault } from "../lib/game";
import { tileName } from "../lib/grid";
import { addressLink } from "../lib/network";
import { Button, shortHandle } from "./ui";

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

  const latest = raids.slice(-4).reverse();

  return (
    <section className="spy" aria-labelledby="spy-title">
      <h3 id="spy-title">
        <ScanEye size={16} aria-hidden /> What the chain shows everyone
      </h3>
      <dl>
        <div className="spy-row">
          <dt>owner</dt>
          <dd className="plain">
            {vault.isHouse ? "nobody (house vault)" : link ? <a href={link}>{vault.owner}</a> : vault.owner}
          </dd>
        </div>
        <div className="spy-row">
          <dt>traps · euint64</dt>
          <dd>{vault.traps}</dd>
        </div>
        {vault.remaining.map((handle, i) => (
          <div className="spy-row" key={handle + i}>
            <dt>stash {i + 1} · euint64</dt>
            <dd>{shortHandle(handle)}</dd>
          </div>
        ))}
        {latest.map((raid) => (
          <div className="spy-row" key={raid.index}>
            <dt>raid {raid.index + 1}</dt>
            <dd>
              <span className="plain">route {raid.route.map(tileName).join(" ")}</span>
              <br />
              escaped · ebool {shortHandle(raid.escaped)}
              <br />
              payout · euint64 {shortHandle(raid.payout)}
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
        <p className="hint" style={{ color: "#7fb5bb" }}>
          Routes are public. Traps, stashes, outcomes and gold stay ciphertext until the vault retires.
        </p>
      )}
    </section>
  );
}
