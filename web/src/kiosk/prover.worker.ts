import * as snarkjs from "snarkjs";
import { apiBase } from "../api.ts";

export interface ProveRequest {
  input: Record<string, string | string[]>;
}

export type ProveResponse =
  | { ok: true; proof: unknown; publicSignals: string[] }
  | { ok: false; message: string };

self.onmessage = async (event: MessageEvent<ProveRequest>) => {
  let response: ProveResponse;
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      event.data.input,
      `${apiBase}/artifacts/vote.wasm`,
      `${apiBase}/artifacts/vote.zkey`,
    );
    response = { ok: true, proof, publicSignals };
  } catch {
    response = { ok: false, message: "The proof could not be created" };
  }
  self.postMessage(response);
};
