import { useEffect, useState } from "react";
import { getBallot, getFeed, type Ballot } from "../api.ts";
import type { ElectionState } from "../chain.ts";

export type FeedKind = "registered" | "vote" | "double-vote" | "double-registration" | "rejected" | "other";

export interface FeedItem {
  signature: string;
  time: number | null;
  kind: FeedKind;
  race: number;
  option?: number;
}

export interface Live {
  ballot: Ballot | null;
  states: (ElectionState | null)[];
  feed: FeedItem[];
  error: string;
}

export function useBallot(): Live {
  const [live, setLive] = useState<Live>({ ballot: null, states: [], feed: [], error: "" });

  useEffect(() => {
    let stopped = false;
    let timer = 0;

    const refresh = async () => {
      try {
        const [ballot, items] = await Promise.all([getBallot(), getFeed()]);
        const states: ElectionState[] = ballot.races.map((race) => ({
          phase: ballot.phase,
          optionCount: race.candidates.length,
          root: 0n,
          registered: ballot.registered,
          tally: race.tally,
        }));
        const feed = items
          .filter((item) => ballot.races[item.race] !== undefined && item.kind !== "registered" && item.kind !== "double-registration")
          .map((item): FeedItem => {
              const race = ballot.races[item.race]!;
              const option = item.candidate === undefined ? -1 : race.candidates.indexOf(item.candidate);
              return {
                signature: item.signature,
                time: item.time,
                kind: item.kind,
                race: race.index,
                option: option < 0 ? undefined : option,
              };
            });
        if (!stopped) setLive({ ballot, states, feed, error: "" });
      } catch (e) {
        if (!stopped) setLive((old) => ({ ...old, error: (e as Error).message || "Cannot reach the election server" }));
      }
    };

    const loop = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(() => void loop(), 1000);
    };
    void loop();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  return live;
}
