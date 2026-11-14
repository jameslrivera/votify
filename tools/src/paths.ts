import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const circuitsBuild = join(repoRoot, "circuits", "build");
export const programSrc = join(repoRoot, "programs", "zk_election", "src");
export const vectorsDir = join(repoRoot, "test-vectors");
