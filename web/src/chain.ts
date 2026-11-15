import { Connection, PublicKey } from "@solana/web3.js";

export type Phase = "registration" | "voting" | "closed";

export interface ElectionState {
  phase: Phase;
  optionCount: number;
  root: bigint;
  registered: number;
  tally: number[];
}

const PHASES: Phase[] = ["registration", "voting", "closed"];

export function makeConnection(): Connection {
  const direct = import.meta.env.VITE_RPC_URL as string | undefined;
  if (direct) return new Connection(direct, "confirmed");
  const ws = window.location.protocol === "https:" ? "wss" : "ws";
  return new Connection(`${window.location.origin}/rpc`, {
    commitment: "confirmed",
    wsEndpoint: `${ws}://${window.location.host}/rpc-ws`,
  });
}

export function decodeElection(data: Uint8Array): ElectionState {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let root = 0n;
  for (const b of data.subarray(82, 114)) root = (root << 8n) | BigInt(b);
  const optionCount = data[49]!;
  const tally: number[] = [];
  for (let i = 0; i < optionCount; i++) tally.push(Number(view.getBigUint64(758 + i * 8, true)));
  return {
    phase: PHASES[data[48]!] ?? "closed",
    optionCount,
    root,
    registered: view.getUint32(114, true),
    tally,
  };
}

export async function fetchElection(connection: Connection, election: PublicKey): Promise<ElectionState> {
  const account = await connection.getAccountInfo(election, "confirmed");
  if (!account) throw new Error("The election account was not found on Solana");
  return decodeElection(account.data);
}

function bytes32(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function voteNullifierAddress(programId: PublicKey, election: PublicKey, nullifier: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("vn"), election.toBytes(), bytes32(nullifier)],
    programId,
  )[0];
}

export function explorerUrl(kind: "tx" | "address", id: string, rpcUrl: string): string {
  const cluster = rpcUrl.includes("devnet") ? "devnet" : `custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  return `https://explorer.solana.com/${kind}/${id}?cluster=${cluster}`;
}

export const short = (s: string, n = 6): string => (s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);
