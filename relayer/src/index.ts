import { Chain } from "./chain.ts";
import { rmSync } from "node:fs";
import { freshMarker, loadConfig } from "./config.ts";
import { Seeder } from "./seed.ts";
import { createRelayer } from "./server.ts";

process.on("unhandledRejection", (reason) => {
  console.error("relayer: unhandled rejection:", reason instanceof Error ? reason.message : "unknown");
});
process.on("uncaughtException", (error) => {
  console.error("relayer: uncaught exception:", error.message);
});

const config = loadConfig();
const chain = new Chain(config);
await chain.fundPayerIfLocal();
const seeder = new Seeder(config, chain);
if (config.demoMode) {
  if (config.freshBallot) {
    await seeder.newBallot();
    rmSync(freshMarker(), { force: true });
  } else {
    await chain.ensureBallot();
    seeder.resume();
  }
}
const server = createRelayer(config, chain, seeder);
server.listen(config.port, "0.0.0.0", () => {
  console.log(`relayer listening on port ${config.port} (${config.demoMode ? "demo" : "standard"} mode, ${config.keyTreeConfig} keys)`);
});
