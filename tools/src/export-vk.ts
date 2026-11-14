import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toBytes32BE } from "@zk-election/proof-format";
import { circuitsBuild, programSrc } from "./paths.ts";

interface VerificationKey {
  nPublic: number;
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
}

const g1 = (p: string[]): number[] => [...toBytes32BE(p[0]!), ...toBytes32BE(p[1]!)];
const g2 = (p: string[][]): number[] => [
  ...toBytes32BE(p[0]![1]!),
  ...toBytes32BE(p[0]![0]!),
  ...toBytes32BE(p[1]![1]!),
  ...toBytes32BE(p[1]![0]!),
];
const arr = (bytes: number[], indent: string): string => {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) lines.push(indent + "    " + bytes.slice(i, i + 16).join(", ") + ",");
  return `[\n${lines.join("\n")}\n${indent}]`;
};

const names = process.argv.slice(2);
const targets =
  names.length > 0
    ? names
    : readdirSync(circuitsBuild).filter((d) => existsSync(join(circuitsBuild, d, "verification_key.json")));

for (const name of targets) {
  const vk = JSON.parse(readFileSync(join(circuitsBuild, name, "verification_key.json"), "utf8")) as VerificationKey;
  const upper = name.toUpperCase();
  const ic = vk.IC.map((p) => "        " + arr(g1(p), "        ") + ",").join("\n");
  const rust = `#![cfg_attr(rustfmt, rustfmt_skip)]

use crate::verifier::VerifyingKey;

pub const ${upper}_NR_INPUTS: usize = ${vk.nPublic};

pub const VK_${upper}: VerifyingKey = VerifyingKey {
    alpha_g1: ${arr(g1(vk.vk_alpha_1), "    ")},
    beta_g2: ${arr(g2(vk.vk_beta_2), "    ")},
    gamma_g2: ${arr(g2(vk.vk_gamma_2), "    ")},
    delta_g2: ${arr(g2(vk.vk_delta_2), "    ")},
    ic: &[
${ic}
    ],
};
`;
  const file = join(programSrc, `vk_${name}.rs`);
  writeFileSync(file, rust);
  console.log(`wrote ${file}`);
}
