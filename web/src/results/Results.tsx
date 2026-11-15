import { useEffect, useState } from "react";
import { simulateVoters, type Race } from "../api.ts";
import { explorerUrl, short } from "../chain.ts";
import { useBallot, type FeedItem } from "./useBallot.ts";

const PHASE_LABEL = { registration: "Registration open", voting: "Voting open", closed: "Closed" } as const;

const timeOf = (t: number | null) =>
  t === null ? "" : new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const percent = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

function RaceCard({ race, tally }: { race: Race; tally: number[] }) {
  const total = tally.reduce((a, b) => a + b, 0);
  const ranked = tally.map((votes, index) => ({ votes, index })).sort((a, b) => b.votes - a.votes);
  const leader = ranked[0];
  const runnerUp = ranked[1];
  const tied = total > 0 && leader !== undefined && runnerUp !== undefined && leader.votes === runnerUp.votes;
  const margin = leader && runnerUp ? leader.votes - runnerUp.votes : 0;

  return (
    <article className="race-card">
      <header className="race-head">
        <div>
          <h2>{race.office}</h2>
          <p className="muted">{race.district}</p>
        </div>
        <span className="race-total">
          {total} {total === 1 ? "vote" : "votes"}
        </span>
      </header>
      <p className="race-lead">
        {total === 0 || !leader
          ? "No votes yet"
          : tied
            ? `${race.candidates[leader.index]} and ${race.candidates[runnerUp!.index]} are tied`
            : `${race.candidates[leader.index]} leads by ${margin} ${margin === 1 ? "vote" : "votes"}`}
      </p>
      <ul className="candidates">
        {race.candidates.map((name, index) => {
          const votes = tally[index] ?? 0;
          const leading = total > 0 && !tied && leader?.index === index;
          return (
            <li key={name} className="candidate-row">
              <span className={`avatar candidate-${index % 3}`}>{name[0]}</span>
              <span className="candidate-main">
                <span className="candidate-name">{name}</span>
                <span className="bar" aria-hidden="true">
                  <span className={`bar-fill candidate-${index % 3}`} style={{ width: `${percent(votes, total)}%` }} />
                </span>
              </span>
              <span className="candidate-votes">
                {votes} {votes === 1 ? "vote" : "votes"}
              </span>
              <span className={`share ${leading ? "share-leader" : ""}`}>{percent(votes, total)}%</span>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function feedText(item: FeedItem, race: Race | undefined): string {
  const office = race?.office ?? "Race";
  switch (item.kind) {
    case "registered":
      return `Voter registered · ${office}`;
    case "vote":
      return `${office} · vote for ${race?.candidates[item.option ?? -1] ?? "a candidate"}`;
    case "double-vote":
      return `Double vote rejected · ${office}`;
    case "double-registration":
      return `Double registration rejected · ${office}`;
    default:
      return `Transaction rejected · ${office}`;
  }
}

export function Results() {
  const { ballot, states, feed, error } = useBallot();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const races = ballot?.races ?? [];
  const phase = states[0]?.phase;
  const registered = states[0]?.registered ?? 0;
  const raceTotals = states.map((state) => (state?.tally ?? []).reduce((a, b) => a + b, 0));
  const ballotsCast = raceTotals.length === 0 ? 0 : Math.max(...raceTotals);
  const turnout = percent(ballotsCast, registered);
  const simulation = ballot?.simulation;
  const simulationState = simulation?.state;
  useEffect(() => {
    if (simulationState === "preparing") setStarting(false);
  }, [simulationState]);
  const showSimulate = !!simulation && simulation.state !== "off" && simulation.state !== "done" && phase !== "closed";
  const simulateLabel =
    simulation?.state === "running" || starting
      ? `Simulation running · ${simulation?.voters ?? 0} voters`
      : simulation?.state === "ready"
        ? `Simulate ${simulation.voters} voters`
        : `Preparing voters (${simulation?.voters ?? 0} of ${simulation?.total ?? 0})`;
  const startSimulation = async () => {
    setStarting(true);
    try {
      await simulateVoters();
    } catch {
      setStarting(false);
    }
  };
  const rejected = feed.filter((f) => f.kind === "double-vote" || f.kind === "double-registration").length;

  return (
    <main className="results">
      <header className="topbar">
        <strong className="brand">Votify</strong>
        <span className="pill">{phase ? PHASE_LABEL[phase] : "Connecting"}</span>
        <span className="pill">{ballot ? ballot.rpcUrl.includes("devnet") ? "Solana devnet" : "Local network" : "Network"}</span>
        <span className={`pill ${error ? "pill-danger" : "pill-live"}`}>{error ? "Offline" : "Live"}</span>
        {showSimulate && (
          <button
            className="button primary simulate"
            disabled={starting || simulation?.state !== "ready"}
            onClick={() => void startSimulation()}
          >
            {simulateLabel}
          </button>
        )}
        <button className="link" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? "Light" : "Dark"} theme
        </button>
      </header>

      <div className="columns">
        <section>
          <h1>{ballot?.title ?? "Results"}</h1>
          {ballot && (
            <>
              <p className="muted ballot-area">{ballot.area}</p>
            </>
          )}
          <div className="races">
            {races.map((race, index) => (
              <RaceCard key={race.electionId} race={race} tally={states[index]?.tally ?? race.candidates.map(() => 0)} />
            ))}
          </div>
          {ballot && <p className="muted demo-footer">{ballot.note}</p>}
        </section>

        <aside>
          <section className="panel">
            <h2>Turnout</h2>
            <p className="panel-number">{turnout}%</p>
            <div className="bar-track" role="progressbar" aria-valuenow={turnout} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${Math.min(turnout, 100)}%` }} />
            </div>
            <dl className="stats">
              <div>
                <dt>Registered voters</dt>
                <dd>{registered}</dd>
              </div>
              <div>
                <dt>Ballots cast</dt>
                <dd>{ballotsCast}</dd>
              </div>
              <div>
                <dt>Double votes rejected</dt>
                <dd>{rejected}</dd>
              </div>
            </dl>
            {ballot && (
              <>
                <a className="button" href={explorerUrl("address", ballot.programId, ballot.rpcUrl)} target="_blank" rel="noreferrer">
                  Verify on Solana Explorer
                </a>
                <p className="mono muted">Program {short(ballot.programId, 8)}</p>
              </>
            )}
          </section>

          <section className="panel">
            <h2>Transactions</h2>
            {feed.length === 0 && <p className="muted">Nothing yet.</p>}
            <ul className="feed">
              {feed.slice(0, 40).map((item) => {
                const bad = item.kind !== "registered" && item.kind !== "vote";
                return (
                  <li key={item.signature}>
                    <a
                      href={ballot ? explorerUrl("tx", item.signature, ballot.rpcUrl) : "#"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span
                        className={`dot ${
                          bad ? "dot-danger" : item.kind === "vote" ? `candidate-${(item.option ?? 0) % 3}` : "dot-neutral"
                        }`}
                        aria-hidden="true"
                      />
                      <span className="feed-main">
                        <span className={bad ? "feed-text feed-danger" : "feed-text"}>
                          {bad && <span aria-hidden="true">✕ </span>}
                          {feedText(item, races[item.race])}
                        </span>
                        <span className="mono muted">
                          {short(item.signature, 4)} · {timeOf(item.time)}
                        </span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>
      </div>
    </main>
  );
}
