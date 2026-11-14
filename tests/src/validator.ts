import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_PORT, RPC_URL, repoRoot } from "./env.ts";

export default async function setup(): Promise<() => Promise<void>> {
  const so = join(repoRoot, "target", "deploy", "zk_election.so");
  const idlPath = join(repoRoot, "target", "idl", "zk_election.json");
  if (!existsSync(so) || !existsSync(idlPath)) {
    throw new Error("Program not built. Run `pnpm program:build` first.");
  }
  const programId = (JSON.parse(readFileSync(idlPath, "utf8")) as { address: string }).address;
  const ledger = mkdtempSync(join(tmpdir(), "zk-election-ledger-"));
  const child: ChildProcess = spawn(
    "solana-test-validator",
    [
      "--reset",
      "--quiet",
      "--ledger", ledger,
      "--bind-address", "127.0.0.1",
      "--rpc-port", String(RPC_PORT),
      "--faucet-port", String(RPC_PORT + 1000),
      "--gossip-port", String(RPC_PORT + 100),
      "--dynamic-port-range", `${RPC_PORT + 101}-${RPC_PORT + 130}`,
      "--bpf-program", programId, so,
    ],
    { stdio: "ignore" },
  );
  let exited = false;
  child.on("exit", () => (exited = true));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited) throw new Error("solana-test-validator exited early. Is the port in use?");
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("Timed out waiting for the local validator");
    }
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      });
      const body = (await res.json()) as { result?: string };
      if (body.result === "ok") break;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return async () => {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (!exited) child.kill("SIGKILL");
    rmSync(ledger, { recursive: true, force: true });
  };
}
