import QRCode from "qrcode";
import { encodeCredential, randomCredential } from "@zk-election/merkle";

const relayer = process.env.RELAYER_URL ?? "http://127.0.0.1:8787";
const hex = (x: bigint) => x.toString(16).padStart(62, "0");
const credential = randomCredential();

console.log("Registering a MOCK voter in every race. This takes about 20 seconds…");
const res = await fetch(`${relayer}/demo/register-mock`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ secretHex: hex(credential.secret), nullifierKeyHex: hex(credential.nullifierKey) }),
});
const body = (await res.json()) as { registrations?: { office: string; signature: string }[]; message?: string };
if (!res.ok || !body.registrations) {
  console.error(`Registration failed: ${body.message ?? res.status}`);
  process.exit(1);
}
for (const entry of body.registrations) console.log(`  ${entry.office}: ${entry.signature}`);
console.log("Voting code for this MOCK voter:");
console.log(await QRCode.toString(encodeCredential(credential), { type: "terminal", small: true }));
const pngIndex = process.argv.indexOf("--png");
if (pngIndex > 0 && process.argv[pngIndex + 1]) {
  await QRCode.toFile(process.argv[pngIndex + 1]!, encodeCredential(credential), { width: 480, margin: 2 });
  console.log(`Saved the voting code image to ${process.argv[pngIndex + 1]}`);
}
process.exit(0);
