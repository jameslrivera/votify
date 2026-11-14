import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_TREE_DEPTH } from "@zk-election/constants";
import { buildKeyTree, keyLeaf, loadMockKey } from "@zk-election/passport";
import { toBytes32BE } from "@zk-election/proof-format";
import { repoRoot, vectorsDir } from "./paths.ts";

interface KeyEntry {
  name: string;
  modulusHex: string;
  note?: string;
}

const hex = (x: bigint) => Buffer.from(toBytes32BE(x)).toString("hex");
const strictPath = join(repoRoot, "tools", "key-tree", "strict.json");
const strict: KeyEntry[] = existsSync(strictPath) ? JSON.parse(readFileSync(strictPath, "utf8")).keys : [];
const mock = loadMockKey(readFileSync(join(repoRoot, "tools", "mock-keys", "mock-dsc.pem"), "utf8"));

const configs: Record<string, KeyEntry[]> = {
  strict,
  demo: [...strict, { name: "MOCK DSC (public test key)", modulusHex: mock.modulus.toString(16) }],
};

for (const [config, keys] of Object.entries(configs)) {
  const moduli = keys.map((k) => BigInt("0x" + k.modulusHex));
  const tree = buildKeyTree(moduli);
  const out = {
    config,
    note:
      config === "demo"
        ? "Includes the MOCK DSC key. Anyone with the mock private key can register fake voters."
        : "Real DSC keys only. Their chain to the US CSCA certificate has NOT been checked.",
    depth: KEY_TREE_DEPTH,
    keys: keys.map((k, i) => ({ name: k.name, leaf: hex(keyLeaf(moduli[i]!)) })),
    root: hex(tree.root),
  };
  writeFileSync(join(vectorsDir, `key-tree.${config}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(`key-tree.${config}.json: ${keys.length} key(s), root ${out.root}`);
}
