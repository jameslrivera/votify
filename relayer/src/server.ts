import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Chain, RelayError, type ProofBody } from "./chain.ts";
import type { RelayerConfig } from "./config.ts";
import { parseDemoCredential, prepareMockRegistrations, proveMockRegistrations } from "./demo-prover.ts";
import { Seeder } from "./seed.ts";

const ARTIFACTS: Record<string, string> = {
  "vote.wasm": "vote/vote.wasm",
  "vote.zkey": "vote/vote.zkey",
  "register.wasm": "register/register.wasm",
  "register.zkey": "register/register.zkey",
};
const MAX_BODY = 64 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new RelayError("BadRequest", "Request is too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RelayError("BadRequest", "Request is not valid JSON");
  }
}

function proofBody(value: unknown): ProofBody {
  const body = value as Partial<ProofBody> | null;
  if (
    !body ||
    typeof body.proof !== "object" ||
    !Array.isArray(body.publicSignals) ||
    !body.publicSignals.every((s) => typeof s === "string" && /^\d{1,78}$/.test(s))
  ) {
    throw new RelayError("BadRequest", "Expected { proof, publicSignals }");
  }
  return body as ProofBody;
}

function electionParam(value: string | null): bigint {
  if (!value || !/^\d{1,20}$/.test(value)) throw new RelayError("BadRequest", "Expected ?election=<id>");
  return BigInt(value);
}

function requireAdmin(config: RelayerConfig, req: IncomingMessage): void {
  if (!config.adminToken) return;
  const given = Buffer.from(String(req.headers["x-admin-token"] ?? ""));
  const expected = Buffer.from(config.adminToken);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new RelayError("Forbidden", "The control password is wrong");
  }
}

export function createRelayer(
  config: RelayerConfig,
  chain: Chain = new Chain(config),
  seeder: Seeder = new Seeder(config, chain),
): Server {
  return createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, x-admin-token");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("cache-control", "no-store");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://relayer");
    const path = url.pathname;
    const route = `${req.method} ${path}`;
    try {
      if (route === "GET /ballot") {
        return json(res, 200, {
          ...(await chain.info()),
          adminLocked: config.adminToken !== "",
          simulation: seeder.info(),
        });
      }
      if (route === "GET /leaves") {
        const electionId = electionParam(url.searchParams.get("election"));
        const [leaves, root] = await Promise.all([chain.fetchLeaves(electionId), chain.electionRoot(electionId)]);
        return json(res, 200, { leaves, root });
      }
      if (route === "GET /feed") {
        return json(res, 200, { transactions: await chain.feed() });
      }
      if (route === "GET /voted") {
        const electionId = electionParam(url.searchParams.get("election"));
        const nullifier = url.searchParams.get("nullifier");
        if (!nullifier || !/^\d{1,78}$/.test(nullifier)) throw new RelayError("BadRequest", "Expected &nullifier=<number>");
        return json(res, 200, { voted: await chain.hasVoted(electionId, BigInt(nullifier)) });
      }
      if (route === "GET /transactions") {
        return json(res, 200, {
          transactions: await chain.transactions(electionParam(url.searchParams.get("election"))),
        });
      }
      if (route === "POST /register") {
        return json(res, 200, { signature: await chain.register(proofBody(await readJson(req))) });
      }
      if (route === "POST /vote") {
        return json(res, 200, { signature: await chain.vote(proofBody(await readJson(req))) });
      }
      if (req.method === "GET" && path.startsWith("/artifacts/")) {
        const file = ARTIFACTS[path.slice("/artifacts/".length)];
        const full = file ? join(config.artifactsDir, file) : undefined;
        if (!full || !existsSync(full)) return json(res, 404, { error: "NotFound", message: "No such artifact" });
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": statSync(full).size,
          "cache-control": "public, max-age=3600",
        });
        createReadStream(full).pipe(res);
        return;
      }
      if (config.demoMode && route === "POST /demo/register-mock") {
        const credential = parseDemoCredential(await readJson(req));
        const info = await chain.info();
        if (info.phase !== "registration") throw new RelayError("WrongPhase", "Registration is closed");
        const proofs = await proveMockRegistrations(
          config,
          credential,
          info.races.map((race) => BigInt(race.electionId)),
        );
        const registrations = await Promise.all(
          proofs.map(async (proof, index) => ({
            race: index,
            office: info.races[index]!.office,
            signature: await chain.register(proof),
          })),
        );
        return json(res, 200, { registrations });
      }
      if (config.demoMode && route === "POST /demo/prepare") {
        const credential = parseDemoCredential(await readJson(req));
        const info = await chain.info();
        if (info.phase !== "registration") throw new RelayError("WrongPhase", "Registration is closed");
        prepareMockRegistrations(
          config,
          credential,
          info.races.map((race) => BigInt(race.electionId)),
        );
        return json(res, 202, { preparing: true });
      }
      if (config.demoMode && route === "POST /demo/open-voting") {
        return json(res, 200, { signatures: await chain.openVoting() });
      }
      if (config.demoMode && route === "POST /demo/simulate") {
        seeder.simulate();
        return json(res, 200, { simulation: seeder.info() });
      }
      if (config.demoMode && route === "POST /demo/close-voting") {
        requireAdmin(config, req);
        return json(res, 200, { signatures: await chain.closeVoting() });
      }
      if (config.demoMode && route === "POST /demo/reset") {
        requireAdmin(config, req);
        await seeder.newBallot();
        return json(res, 200, {
          ...(await chain.info()),
          adminLocked: config.adminToken !== "",
          simulation: seeder.info(),
        });
      }
      json(res, 404, { error: "NotFound", message: "No such endpoint" });
    } catch (e) {
      if (e instanceof RelayError) {
        const status = e.code === "BadRequest" ? 400 : e.code === "Forbidden" ? 403 : e.code === "NoElection" ? 503 : 409;
        return json(res, status, { error: e.code, message: e.message, signature: e.signature });
      }
      console.error(`relayer: ${route} failed: ${e instanceof Error ? e.message : "unknown error"}`);
      json(res, 500, { error: "Internal", message: "The relayer could not complete the request" });
    }
  });
}
