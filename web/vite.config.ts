import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const certDir = join(import.meta.dirname, "..", "certs");
const key = join(certDir, "lan-key.pem");
const cert = join(certDir, "lan.pem");
const relayer = process.env.RELAYER_URL ?? "http://127.0.0.1:8787";
const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const rpcWs = process.env.RPC_WS_URL ?? "ws://127.0.0.1:8900";

export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
  worker: { format: "es" },
  server: {
    host: "0.0.0.0",
    port: 5173,
    https: existsSync(key) && existsSync(cert) ? { key: readFileSync(key), cert: readFileSync(cert) } : undefined,
    proxy: {
      "/api": { target: relayer, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
      "/rpc-ws": { target: rpcWs, ws: true, changeOrigin: true, rewrite: () => "/" },
      "/rpc": { target: rpc, changeOrigin: true, rewrite: () => "/" },
    },
  },
});
