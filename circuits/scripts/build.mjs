import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as snarkjs from "snarkjs";

const here = dirname(fileURLToPath(import.meta.url));
const circuitsDir = join(here, "..");
const buildDir = join(circuitsDir, "build");
const constants = JSON.parse(readFileSync(join(circuitsDir, "..", "constants.json"), "utf8"));
const require = createRequire(import.meta.url);
const circomlibRoot = join(dirname(require.resolve("circomlib/package.json")), "..");

const CIRCUITS = {
  vote: {
    include: "vote.circom",
    main: `component main {public [root, vote_nullifier, vote, election_id]} = Vote(${constants.TREE_DEPTH});`,
    opt: "--O2",
  },
  register: {
    include: "register.circom",
    main:
      `component main {public [passport_nullifier, commitment, election_id, current_date, trusted_key_root]} = ` +
      `Register(${constants.KEY_TREE_DEPTH}, ${constants.MAX_ECONTENT_PADDED / 64}, ${constants.MAX_SIGNED_ATTRS_PADDED / 64}, ` +
      `${constants.RSA_LIMB_BITS}, ${constants.RSA_LIMBS});`,
    opt: "--O1",
  },
};

const only = process.argv.slice(2);
const names = Object.keys(CIRCUITS).filter((n) => only.length === 0 || only.includes(n));

async function ensurePtau(power) {
  const dir = join(buildDir, "ptau");
  mkdirSync(dir, { recursive: true });
  const final = join(dir, `pot${power}_final.ptau`);
  if (existsSync(final)) return final;
  console.log(`  generating local powers of tau (2^${power})`);
  const p0 = join(dir, `pot${power}_0.ptau`);
  const p1 = join(dir, `pot${power}_1.ptau`);
  await snarkjs.powersOfTau.newAccumulator(await snarkjs.curves.getCurveFromName("bn128"), power, p0);
  await snarkjs.powersOfTau.contribute(p0, p1, "local demo", randomBytes(32).toString("hex"));
  await snarkjs.powersOfTau.preparePhase2(p1, final);
  return final;
}

for (const name of names) {
  const spec = CIRCUITS[name];
  const out = join(buildDir, name);
  mkdirSync(out, { recursive: true });
  console.log(`[${name}] compiling`);
  const mainFile = join(out, `${name}_main.circom`);
  writeFileSync(
    mainFile,
    `pragma circom 2.1.6;\ninclude "${spec.include}";\n${spec.main}\n`,
  );
  execFileSync(
    "circom",
    [mainFile, "--r1cs", "--wasm", "--sym", spec.opt, "-o", out, "-l", circuitsDir, "-l", circomlibRoot],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const r1cs = join(out, `${name}_main.r1cs`);
  copyFileSync(join(out, `${name}_main_js`, `${name}_main.wasm`), join(out, `${name}.wasm`));

  const info = await snarkjs.r1cs.info(r1cs);
  const power = Math.max(8, Math.ceil(Math.log2(info.nConstraints + info.nPubInputs + info.nOutputs + 1)));
  const ptau = await ensurePtau(power);

  console.log(`[${name}] groth16 setup (${info.nConstraints} constraints)`);
  const z0 = join(out, `${name}_0.zkey`);
  const zkey = join(out, `${name}.zkey`);
  await snarkjs.zKey.newZKey(r1cs, ptau, z0);
  await snarkjs.zKey.contribute(z0, zkey, "local demo", randomBytes(32).toString("hex"));
  const vk = await snarkjs.zKey.exportVerificationKey(zkey);
  writeFileSync(join(out, "verification_key.json"), JSON.stringify(vk, null, 2));

  const stats = {
    constraints: info.nConstraints,
    publicInputs: info.nPubInputs,
    privateInputs: info.nPrvInputs,
    ptauPower: power,
    zkeyBytes: statSync(zkey).size,
    wasmBytes: statSync(join(out, `${name}.wasm`)).size,
  };
  writeFileSync(join(out, "stats.json"), JSON.stringify(stats, null, 2));
  console.log(`[${name}]`, stats);
}
process.exit(0);
