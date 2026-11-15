import { useCallback, useEffect, useRef, useState } from "react";
import { TREE_DEPTH } from "@zk-election/constants";
import {
  IncrementalMerkleTree,
  commitment,
  decodeCredential,
  voteNullifier,
  type Credential,
} from "@zk-election/merkle";
import {
  ApiError,
  closeVoting,
  getBallot,
  getVoterList,
  hasVoted,
  openVoting,
  postVote,
  resetBallot,
  type Ballot,
  type Race,
} from "../api.ts";
import { short } from "../chain.ts";
import { Scanner } from "./Scanner.tsx";
import type { ProveRequest, ProveResponse } from "./prover.worker.ts";

interface RaceSession {
  race: Race;
  tree: IncrementalMerkleTree;
  voted: boolean;
}

interface Session {
  credential: Credential;
  ballot: Ballot;
  races: RaceSession[];
}

interface RaceResult {
  office: string;
  candidate: string;
  signature?: string;
  message?: string;
}

type Stage =
  | { name: "idle" }
  | { name: "scan" }
  | { name: "check" }
  | { name: "voted" }
  | { name: "verified"; races: number }
  | { name: "ballot"; step: number }
  | { name: "review" }
  | { name: "submit"; step: number; total: number }
  | { name: "done"; results: RaceResult[] }
  | { name: "error"; message: string };

const IDLE_MS = 90_000;
const DONE_MS = 15_000;
const VERIFIED_MS = 2_200;

function prove(input: ProveRequest["input"]): Promise<ProveResponse> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./prover.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<ProveResponse>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = () => {
      worker.terminate();
      resolve({ ok: false, message: "The proof could not be created" });
    };
    worker.postMessage({ input } satisfies ProveRequest);
  });
}

const TOKEN_KEY = "votify-control";

function readToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveToken(token: string): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    return;
  }
}

export function Kiosk() {
  const [stage, setStage] = useState<Stage>({ name: "idle" });
  const [choices, setChoices] = useState<(number | null)[]>([]);
  const [open, setOpen] = useState<RaceSession[]>([]);
  const session = useRef<Session | null>(null);
  const [working, setWorking] = useState(false);
  const [menu, setMenu] = useState<{ phase: Ballot["phase"]; locked: boolean } | null>(null);

  const wipe = useCallback(() => {
    const current = session.current;
    if (current) {
      current.credential.secret = 0n;
      current.credential.nullifierKey = 0n;
    }
    session.current = null;
    setChoices([]);
    setOpen([]);
  }, []);

  const toIdle = useCallback(() => {
    wipe();
    setStage({ name: "idle" });
  }, [wipe]);

  const fail = useCallback(
    (message: string) => {
      wipe();
      setStage({ name: "error", message });
    },
    [wipe],
  );

  useEffect(() => {
    if (stage.name === "idle" || stage.name === "submit" || stage.name === "verified") return;
    const wait = stage.name === "done" ? DONE_MS : IDLE_MS;
    let timer = window.setTimeout(toIdle, wait);
    const restart = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(toIdle, wait);
    };
    if (stage.name !== "done") window.addEventListener("pointerdown", restart);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", restart);
    };
  }, [stage, toIdle]);

  useEffect(() => wipe, [wipe]);

  const startBallot = (races: RaceSession[]) => {
    setOpen(races);
    setChoices(races.map(() => null));
    setStage({ name: "ballot", step: 0 });
  };

  useEffect(() => {
    if (stage.name !== "verified") return;
    const timer = window.setTimeout(() => setStage({ name: "ballot", step: 0 }), VERIFIED_MS);
    return () => window.clearTimeout(timer);
  }, [stage]);

  const onCode = useCallback(
    async (text: string) => {
      setStage({ name: "check" });
      try {
        const credential = decodeCredential(text.trim());
        let ballot = await getBallot();
        if (ballot.phase === "registration" && ballot.simulation?.state === "preparing") {
          return fail("Voting opens in a moment. Please try again shortly.");
        }
        if (ballot.phase === "registration" && ballot.demoMode) {
          await openVoting();
          ballot = await getBallot();
        }
        if (ballot.phase !== "voting") {
          return fail(ballot.phase === "registration" ? "Voting has not opened yet." : "Voting has closed.");
        }
        const found = await Promise.all(
          ballot.races.map(async (race): Promise<RaceSession | null> => {
            const electionId = BigInt(race.electionId);
            const { leaves, root } = await getVoterList(race.electionId);
            const tree = new IncrementalMerkleTree(
              TREE_DEPTH,
              leaves.map((leaf) => BigInt("0x" + leaf)),
            );
            if (tree.root !== BigInt("0x" + root)) throw new Error("The voter list does not match Solana. Please ask for help.");
            if (tree.indexOf(commitment(credential, electionId)) < 0) return null;
            const nullifier = voteNullifier(credential.nullifierKey, electionId);
            return { race, tree, voted: await hasVoted(race.electionId, nullifier) };
          }),
        );
        const registered = found.filter((entry): entry is RaceSession => entry !== null);
        if (registered.length === 0) return fail("This voter ID is not registered for this election.");
        session.current = { credential, ballot, races: registered };
        const votable = registered.filter((entry) => !entry.voted);
        if (votable.length === 0) return setStage({ name: "voted" });
        setOpen(votable);
        setChoices(votable.map(() => null));
        setStage({ name: "verified", races: votable.length });
      } catch (e) {
        fail(e instanceof ApiError || (e instanceof Error && e.message.startsWith("The voter list")) ? (e as Error).message : "That is not a valid voter ID.");
      }
    },
    [fail],
  );

  const choose = (step: number, option: number | null) => {
    setChoices((old) => old.map((c, i) => (i === step ? option : c)));
    setStage(step + 1 < open.length ? { name: "ballot", step: step + 1 } : { name: "review" });
  };

  const submit = async () => {
    const current = session.current;
    if (!current) return toIdle();
    const picked = open.map((entry, index) => ({ entry, choice: choices[index] ?? null })).filter((p) => p.choice !== null);
    const results: RaceResult[] = [];
    for (const [i, { entry, choice }] of picked.entries()) {
      setStage({ name: "submit", step: i, total: picked.length });
      const electionId = BigInt(entry.race.electionId);
      const path = entry.tree.proof(entry.tree.indexOf(commitment(current.credential, electionId)));
      const candidate = entry.race.candidates[choice!]!;
      const proof = await prove({
        root: path.root.toString(),
        vote_nullifier: voteNullifier(current.credential.nullifierKey, electionId).toString(),
        vote: String(choice),
        election_id: electionId.toString(),
        secret: current.credential.secret.toString(),
        nullifier_key: current.credential.nullifierKey.toString(),
        path_elements: path.pathElements.map(String),
        path_index: path.pathIndex.map(String),
      });
      if (!proof.ok) {
        results.push({ office: entry.race.office, candidate, message: proof.message });
        continue;
      }
      try {
        const { signature } = await postVote({ proof: proof.proof, publicSignals: proof.publicSignals });
        results.push({ office: entry.race.office, candidate, signature });
      } catch (e) {
        results.push({
          office: entry.race.office,
          candidate,
          message: e instanceof ApiError ? e.message : "The vote could not be sent.",
        });
      }
    }
    wipe();
    setStage({ name: "done", results });
  };

  const ballotTitle = session.current?.ballot.title ?? "";

  const toggleMenu = async () => {
    if (menu) return setMenu(null);
    try {
      const ballot = await getBallot();
      setMenu({ phase: ballot.phase, locked: ballot.adminLocked });
    } catch {
      window.alert("Cannot reach the election server.");
    }
  };

  const control = async (action: "open" | "end" | "restart") => {
    const locked = menu?.locked ?? false;
    setMenu(null);
    if (working) return;
    if (action === "end" && !window.confirm("End voting? No more votes will be accepted.")) return;
    if (action === "restart" && !window.confirm("Restart the election? This clears every voter and vote.")) return;
    let token = "";
    if (action !== "open" && locked) {
      token = readToken() || (window.prompt("Control password") ?? "").trim();
      if (!token) return;
    }
    setWorking(true);
    try {
      if (action === "open") await openVoting();
      if (action === "end") await closeVoting(token);
      if (action === "restart") await resetBallot(token);
      if (token) saveToken(token);
      toIdle();
    } catch (e) {
      if (e instanceof ApiError && e.code === "Forbidden") saveToken("");
      window.alert(e instanceof ApiError ? e.message : "That did not work. Please try again.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="kiosk">
      <div className="controls">
        {menu && (
          <div className="controls-menu" role="menu">
            {menu.phase === "registration" && (
              <button role="menuitem" onClick={() => void control("open")}>
                Open voting
              </button>
            )}
            {menu.phase === "voting" && (
              <button role="menuitem" onClick={() => void control("end")}>
                End voting
              </button>
            )}
            <button role="menuitem" onClick={() => void control("restart")}>
              Restart election
            </button>
          </div>
        )}
        <button
          className="controls-toggle"
          onClick={() => void toggleMenu()}
          disabled={working}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
        >
          {working ? "Working…" : "Controls"}
        </button>
      </div>
      {stage.name === "idle" && (
        <button className="welcome" onClick={() => setStage({ name: "scan" })}>
          <span className="welcome-mark" aria-hidden="true">
            <svg viewBox="0 0 96 96">
              <rect width="96" height="96" rx="21" fill="var(--accent)" />
              <path d="M25.5 50.3l15.7 15.7 30-34.1" fill="none" stroke="#fff" strokeWidth="10.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="welcome-title">Welcome</span>
          <span className="welcome-sub">Touch anywhere to begin voting</span>
        </button>
      )}

      {stage.name === "scan" && <Scanner onCode={onCode} onCancel={toIdle} />}

      {stage.name === "check" && (
        <section className="kiosk-panel">
          <h1>Checking your voter ID…</h1>
          <div className="spinner" aria-hidden="true" />
        </section>
      )}

      {stage.name === "verified" && (
        <section className="kiosk-panel" role="status">
          <svg className="verified-mark" viewBox="0 0 140 140" aria-hidden="true">
            <circle className="verified-fill" cx="70" cy="70" r="62" />
            <circle className="verified-ring" cx="70" cy="70" r="62" />
            <path className="verified-check" d="M42 72l19 19 38-42" />
          </svg>
          <h1>Voter ID verified</h1>
          <p className="muted">
            You can vote in {stage.races} {stage.races === 1 ? "race" : "races"}.
          </p>
        </section>
      )}

      {stage.name === "voted" && (
        <section className="kiosk-panel">
          <p className="notice danger" role="alert">
            <span aria-hidden="true">✕</span> This voter ID has already voted
          </p>
          <button className="button primary" onClick={toIdle}>
            Done
          </button>
          {session.current?.ballot.demoMode && (
            <button className="button" onClick={() => startBallot(session.current?.races ?? [])}>
              Demo: try to vote again anyway
            </button>
          )}
        </section>
      )}

      {stage.name === "ballot" && open[stage.step] && (
        <section className="kiosk-panel">
          <p className="kicker">
            {ballotTitle} · Race {stage.step + 1} of {open.length}
          </p>
          <h1>{open[stage.step]!.race.office}</h1>
          <p className="muted">{open[stage.step]!.race.district}</p>
          <div className="ballot">
            {open[stage.step]!.race.candidates.map((name, index) => (
              <button key={name} className="ballot-row" onClick={() => choose(stage.step, index)}>
                <span className={`avatar candidate-${index % 3}`}>{name[0]}</span>
                {name}
              </button>
            ))}
          </div>
          <button className="button" onClick={() => choose(stage.step, null)}>
            Skip this race
          </button>
          {stage.step > 0 ? (
            <button className="button" onClick={() => setStage({ name: "ballot", step: stage.step - 1 })}>
              Back
            </button>
          ) : (
            <button className="button" onClick={toIdle}>
              Cancel
            </button>
          )}
        </section>
      )}

      {stage.name === "review" && (
        <section className="kiosk-panel">
          <p className="kicker">{ballotTitle}</p>
          <h1>Review your ballot</h1>
          <ul className="review">
            {open.map((entry, index) => (
              <li key={entry.race.electionId}>
                <button className="review-row" onClick={() => setStage({ name: "ballot", step: index })}>
                  <span className="review-office">
                    {entry.race.office}
                    <span className="muted"> · {entry.race.district}</span>
                  </span>
                  <span className={choices[index] === null ? "muted" : "review-choice"}>
                    {choices[index] === null ? "No selection" : entry.race.candidates[choices[index]!]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button className="button primary" disabled={choices.every((c) => c === null)} onClick={submit}>
            Cast my ballot
          </button>
          <button className="button" onClick={() => setStage({ name: "ballot", step: open.length - 1 })}>
            Go back
          </button>
        </section>
      )}

      {stage.name === "submit" && (
        <section className="kiosk-panel">
          <h1>
            Casting vote {stage.step + 1} of {stage.total}…
          </h1>
          <div className="spinner" aria-hidden="true" />
          <p className="muted">Each vote is proved in this browser and checked on Solana. Please wait.</p>
        </section>
      )}

      {stage.name === "done" && (
        <section className="kiosk-panel">
          <p className="notice success" role="status">
            <span aria-hidden="true">✓</span> Your ballot was submitted
          </p>
          <ul className="review">
            {stage.results.map((result) => (
              <li key={result.office} className="review-row static">
                <span className="review-office">{result.office}</span>
                {result.signature ? (
                  <span className="review-choice">
                    ✓ {result.candidate} <span className="mono muted">{short(result.signature, 4)}</span>
                  </span>
                ) : (
                  <span className="review-error">✕ {result.message}</span>
                )}
              </li>
            ))}
          </ul>
          <button className="button primary" onClick={toIdle}>
            Done
          </button>
        </section>
      )}

      {stage.name === "error" && (
        <section className="kiosk-panel">
          <p className="notice danger" role="alert">
            <span aria-hidden="true">✕</span> {stage.message}
          </p>
          <button className="button primary" onClick={toIdle}>
            Start over
          </button>
        </section>
      )}
    </main>
  );
}
