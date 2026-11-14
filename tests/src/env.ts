import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RPC_PORT = 18899;
export const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
export const voteWasm = join(repoRoot, "circuits", "build", "vote", "vote.wasm");
export const voteZkey = join(repoRoot, "circuits", "build", "vote", "vote.zkey");
export const measurementsFile = join(repoRoot, "tests", ".measurements.json");
export const registerWasm = join(repoRoot, "circuits", "build", "register", "register.wasm");
export const registerZkey = join(repoRoot, "circuits", "build", "register", "register.zkey");
export const mockKeyPem = join(repoRoot, "tools", "mock-keys", "mock-dsc.pem");
export const untrustedKeyPem = join(repoRoot, "tools", "mock-keys", "untrusted-dsc.pem");
