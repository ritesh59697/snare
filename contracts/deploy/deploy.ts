import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/** config/game.<network>.json if present, otherwise config/game.json. */
export function gameConfig(hre: HardhatRuntimeEnvironment) {
  const specific = join(hre.config.paths.root, `config/game.${hre.network.name}.json`);
  const file = existsSync(specific) ? specific : join(hre.config.paths.root, "config/game.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const config = gameConfig(hre);

  const deployed = await hre.deployments.deploy("Snare", {
    from: deployer,
    args: [config],
    log: true,
  });

  console.log(`Snare contract: ${deployed.address}`);
};

export default func;
func.id = "deploy_snare";
func.tags = ["Snare"];
