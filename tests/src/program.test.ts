import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BN254_FR, TREE_DEPTH } from "@zk-election/constants";
import { IncrementalMerkleTree, commitment, randomCredential, voteNullifier, type Credential } from "@zk-election/merkle";
import { REGISTER_INPUT, VOTE_INPUT, publicSignalsToBytes, toBytes32BE } from "@zk-election/proof-format";
import {
  type Ctx,
  castVote,
  closeElection,
  computeUnits,
  createElection,
  failure,
  fetchElection,
  makeCtx,
  mockPassport,
  openVoting,
  passportNullifierPda,
  proveRegistration,
  proveVote,
  recordMeasurement,
  register,
  shutdownProver,
  voteNullifierPda,
} from "./client.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await makeCtx();
});
afterAll(shutdownProver);

async function setup(n = 1, optionCount = 3) {
  const { electionId, election } = await createElection(ctx, optionCount);
  const creds: Credential[] = Array.from({ length: n }, randomCredential);
  const tree = new IncrementalMerkleTree(TREE_DEPTH);
  for (const c of creds) {
    await register(ctx, election, await proveRegistration(mockPassport(), c, electionId));
    tree.insert(commitment(c, electionId));
  }
  return { electionId, election, creds, tree };
}

describe("register", () => {
  it("checks inputs, verifies the proof, inserts the commitment and blocks a second registration", async () => {
    const { electionId, election } = await createElection(ctx);
    const passport = mockPassport();
    const cred = randomCredential();
    const rp = await proveRegistration(passport, cred, electionId);
    const changed = (index: number, value: string) => {
      const publicSignals = [...rp.publicSignals];
      publicSignals[index] = value;
      return { ...rp, publicSignals };
    };

    expect(await failure(() => register(ctx, election, changed(REGISTER_INPUT.currentDate, "200101")))).toContain("StaleDate");
    expect(await failure(() => register(ctx, election, changed(REGISTER_INPUT.trustedKeyRoot, "5")))).toContain("KeyRootMismatch");
    expect(await failure(() => register(ctx, election, changed(REGISTER_INPUT.electionId, "5")))).toContain("ElectionMismatch");
    expect(await failure(() => register(ctx, election, changed(REGISTER_INPUT.commitment, "5")))).toContain("InvalidProof");
    expect(await failure(() => register(ctx, election, changed(REGISTER_INPUT.passportNullifier, "5")))).toContain("InvalidProof");
    expect((await fetchElection(ctx, election)).nextIndex).toBe(0);

    const other = await createElection(ctx);
    expect(await failure(() => register(ctx, other.election, rp))).toContain("ElectionMismatch");
    const strict = await createElection(ctx, 3, electionId + 1n, 12345n);
    const forStrict = changed(REGISTER_INPUT.electionId, (electionId + 1n).toString());
    expect(await failure(() => register(ctx, strict.election, forStrict))).toContain("KeyRootMismatch");

    const sig = await register(ctx, election, rp);
    const cu = await computeUnits(ctx, sig);
    recordMeasurement("register_cu", cu);
    const tree = new IncrementalMerkleTree(TREE_DEPTH, [commitment(cred, electionId)]);
    const state = await fetchElection(ctx, election);
    expect(state.root).toBe(tree.root);
    expect(state.nextIndex).toBe(1);
    const nullifier = BigInt(rp.publicSignals[REGISTER_INPUT.passportNullifier]!);
    expect(await ctx.connection.getAccountInfo(passportNullifierPda(election, nullifier))).not.toBeNull();

    expect(await failure(() => register(ctx, election, rp))).toContain("already in use");
    const again = await proveRegistration(passport, randomCredential(), electionId);
    expect(await failure(() => register(ctx, election, again))).toContain("already in use");
    expect((await fetchElection(ctx, election)).nextIndex).toBe(1);

    await openVoting(ctx, election);
    const late = await proveRegistration(mockPassport(), randomCredential(), electionId);
    expect(await failure(() => register(ctx, election, late))).toContain("WrongPhase");
  });

  it("rejects an altered proof and an out-of-range public input in the verifier", async () => {
    const { electionId, election } = await createElection(ctx);
    const rp = await proveRegistration(mockPassport(), randomCredential(), electionId);

    const alteredC = JSON.parse(JSON.stringify(rp.proof)) as typeof rp.proof;
    alteredC.pi_c[1] = (BigInt(alteredC.pi_c[1]!) + 1n).toString();
    expect(await failure(() => register(ctx, election, { ...rp, proof: alteredC }))).toContain("InvalidProof");

    const alteredA = JSON.parse(JSON.stringify(rp.proof)) as typeof rp.proof;
    alteredA.pi_a[0] = (BigInt(alteredA.pi_a[0]!) + 1n).toString();
    expect(await failure(() => register(ctx, election, { ...rp, proof: alteredA }))).toContain("InvalidProof");

    const alteredB = JSON.parse(JSON.stringify(rp.proof)) as typeof rp.proof;
    alteredB.pi_b[0]![0] = (BigInt(alteredB.pi_b[0]![0]!) + 1n).toString();
    expect(await failure(() => register(ctx, election, { ...rp, proof: alteredB }))).toContain("InvalidProof");

    const rawInputs = publicSignalsToBytes(rp.publicSignals);
    rawInputs[REGISTER_INPUT.commitment] = toBytes32BE(BigInt(rp.publicSignals[REGISTER_INPUT.commitment]!) + BN254_FR);
    expect(await failure(() => register(ctx, election, { ...rp, rawInputs }))).toContain("InvalidProof");

    expect((await fetchElection(ctx, election)).nextIndex).toBe(0);
    await register(ctx, election, rp);
    expect((await fetchElection(ctx, election)).nextIndex).toBe(1);
  });

  it("accepts a proof dated yesterday (UTC) and rejects one dated two days ago", async () => {
    const { electionId, election } = await createElection(ctx);
    const day = (offset: number) => {
      const d = new Date(Date.now() - offset * 86_400_000);
      return (d.getUTCFullYear() % 100) * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    };
    const old = await proveRegistration(mockPassport(), randomCredential(), electionId, day(2));
    expect(await failure(() => register(ctx, election, old))).toContain("StaleDate");
    await register(ctx, election, await proveRegistration(mockPassport(), randomCredential(), electionId, day(1)));
    expect((await fetchElection(ctx, election)).nextIndex).toBe(1);
  });
});

describe("cast_vote", () => {
  it("verifies a vote, increments the tally and blocks a second vote", async () => {
    const { electionId, election, creds, tree } = await setup(2);
    await openVoting(ctx, election);

    const vp = await proveVote(creds[0]!, tree, electionId, 1);
    expect(vp.publicSignals).toEqual([
      tree.root.toString(),
      voteNullifier(creds[0]!.nullifierKey, electionId).toString(),
      "1",
      electionId.toString(),
    ]);

    const sig = await castVote(ctx, election, vp);
    const cu = await computeUnits(ctx, sig);
    recordMeasurement("cast_vote_cu", cu);
    expect(cu).toBeLessThan(200_000);
    expect((await fetchElection(ctx, election)).tally).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);

    expect(await failure(() => castVote(ctx, election, vp))).toContain("already in use");
    const again = await proveVote(creds[0]!, tree, electionId, 2);
    expect(await failure(() => castVote(ctx, election, again))).toContain("already in use");
    expect((await fetchElection(ctx, election)).tally).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);

    await castVote(ctx, election, await proveVote(creds[1]!, tree, electionId, 1));
    expect((await fetchElection(ctx, election)).tally).toEqual([0, 2, 0, 0, 0, 0, 0, 0]);

    const nullifier = voteNullifier(creds[0]!.nullifierKey, electionId);
    expect(await ctx.connection.getAccountInfo(voteNullifierPda(election, nullifier))).not.toBeNull();
  });

  it("rejects a proof whose vote was changed after proving", async () => {
    const { electionId, election, creds, tree } = await setup(1);
    await openVoting(ctx, election);
    const vp = await proveVote(creds[0]!, tree, electionId, 0);
    const tampered = { ...vp, publicSignals: [...vp.publicSignals] };
    tampered.publicSignals[VOTE_INPUT.vote] = "1";
    expect(await failure(() => castVote(ctx, election, tampered))).toContain("InvalidProof");
    expect((await fetchElection(ctx, election)).tally[1]).toBe(0);
  });

  it("rejects a proof against the wrong root", async () => {
    const { electionId, election, creds, tree } = await setup(1);
    await openVoting(ctx, election);
    const other = new IncrementalMerkleTree(TREE_DEPTH, tree.leaves);
    other.insert(12345n);
    const vp = await proveVote(creds[0]!, other, electionId, 0);
    expect(await failure(() => castVote(ctx, election, vp))).toContain("RootMismatch");

    const forged = { ...vp, publicSignals: [...vp.publicSignals] };
    forged.publicSignals[VOTE_INPUT.root] = tree.root.toString();
    expect(await failure(() => castVote(ctx, election, forged))).toContain("InvalidProof");
  });

  it("rejects a proof replayed in another election", async () => {
    const a = await setup(1);
    const cred = a.creds[0]!;
    const b = await createElection(ctx);
    const treeB = new IncrementalMerkleTree(TREE_DEPTH, [commitment(cred, b.electionId)]);
    await register(ctx, b.election, await proveRegistration(mockPassport(), cred, b.electionId));
    await openVoting(ctx, a.election);
    await openVoting(ctx, b.election);

    const forA = await proveVote(cred, a.tree, a.electionId, 0);
    expect(await failure(() => castVote(ctx, b.election, forA))).toContain("ElectionMismatch");

    const forged = { ...forA, publicSignals: [...forA.publicSignals] };
    forged.publicSignals[VOTE_INPUT.electionId] = b.electionId.toString();
    forged.publicSignals[VOTE_INPUT.root] = treeB.root.toString();
    expect(await failure(() => castVote(ctx, b.election, forged))).toContain("InvalidProof");

    await castVote(ctx, a.election, forA);
    expect((await fetchElection(ctx, a.election)).tally[0]).toBe(1);
    expect((await fetchElection(ctx, b.election)).tally[0]).toBe(0);
  });

  it("rejects an option outside the ballot", async () => {
    const { electionId, election, creds, tree } = await setup(1, 2);
    await openVoting(ctx, election);
    const vp = await proveVote(creds[0]!, tree, electionId, 2);
    expect(await failure(() => castVote(ctx, election, vp))).toContain("InvalidOption");
    const huge = await proveVote(creds[0]!, tree, electionId, 256);
    expect(await failure(() => castVote(ctx, election, huge))).toContain("InvalidOption");
  });
});

describe("phases and authority", () => {
  it("only accepts votes while voting is open", async () => {
    const { electionId, election, creds, tree } = await setup(1);
    const vp = await proveVote(creds[0]!, tree, electionId, 0);
    expect(await failure(() => castVote(ctx, election, vp))).toContain("WrongPhase");

    await openVoting(ctx, election);
    expect((await fetchElection(ctx, election)).phase).toBe("voting");
    expect(await failure(() => openVoting(ctx, election))).toContain("WrongPhase");

    await closeElection(ctx, election);
    expect((await fetchElection(ctx, election)).phase).toBe("closed");
    expect(await failure(() => castVote(ctx, election, vp))).toContain("WrongPhase");
    expect(await failure(() => closeElection(ctx, election))).toContain("WrongPhase");
  });

  it("cannot close before voting opens", async () => {
    const { election } = await createElection(ctx);
    expect(await failure(() => closeElection(ctx, election))).toContain("WrongPhase");
  });

  it("rejects phase changes from anyone but the authority", async () => {
    const { election } = await createElection(ctx);
    const stranger = await makeCtx();
    expect(await failure(() => openVoting(stranger, election))).toContain("NotAuthority");
  });

  it("rejects an election with fewer than 2 or more than 8 options", async () => {
    expect(await failure(() => createElection(ctx, 1))).toContain("InvalidOption");
    expect(await failure(() => createElection(ctx, 9))).toContain("InvalidOption");
  });
});
