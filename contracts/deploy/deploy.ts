import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const config = JSON.parse(readFileSync(join(hre.config.paths.root, "config/game.json"), "utf8"));

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
