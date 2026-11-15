export interface Race {
  index: number;
  office: string;
  district: string;
  electionId: string;
  election: string;
  candidates: string[];
  tally: number[];
}

export interface Ballot {
  title: string;
  area: string;
  note: string;
  programId: string;
  phase: "registration" | "voting" | "closed";
  registered: number;
  rpcUrl: string;
  keyTree: "demo" | "strict";
  demoMode: boolean;
  adminLocked: boolean;
  simulation?: { state: "off" | "preparing" | "ready" | "running" | "done"; voters: number; total: number };
  races: Race[];
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly signature?: string,
  ) {
    super(message);
  }
}

export const apiBase: string = (import.meta.env.VITE_API_URL ?? "/api").replace(/\/$/, "");

async function call<T>(path: string, body?: unknown, adminToken?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? undefined
          : { "content-type": "application/json", ...(adminToken ? { "x-admin-token": adminToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Offline", "Cannot reach the election server");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; signature?: string };
  if (!res.ok) throw new ApiError(data.error ?? "Failed", data.message ?? "The request failed", data.signature);
  return data as T;
}

export const getBallot = () => call<Ballot>("/ballot");
export const getVoterList = (electionId: string) =>
  call<{ leaves: string[]; root: string }>(`/leaves?election=${encodeURIComponent(electionId)}`);
export const hasVoted = (electionId: string, nullifier: bigint) =>
  call<{ voted: boolean }>(
    `/voted?election=${encodeURIComponent(electionId)}&nullifier=${nullifier.toString()}`,
  ).then((r) => r.voted);
export interface RaceTransaction {
  signature: string;
  time: number | null;
  kind: "registered" | "vote" | "double-vote" | "double-registration" | "rejected";
  candidate?: string;
}
export const getFeed = () =>
  call<{ transactions: (RaceTransaction & { race: number })[] }>("/feed").then((r) => r.transactions);
export const getTransactions = (electionId: string) =>
  call<{ transactions: RaceTransaction[] }>(`/transactions?election=${encodeURIComponent(electionId)}`).then(
    (r) => r.transactions,
  );
export const postVote = (body: { proof: unknown; publicSignals: string[] }) =>
  call<{ signature: string }>("/vote", body);
export const openVoting = () => call<{ signatures: string[] }>("/demo/open-voting", {});
export const simulateVoters = () => call<unknown>("/demo/simulate", {});
export const closeVoting = (adminToken: string) =>
  call<{ signatures: string[] }>("/demo/close-voting", {}, adminToken);
export const resetBallot = (adminToken: string) => call<Ballot>("/demo/reset", {}, adminToken);
