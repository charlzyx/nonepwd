import fs from "node:fs";
import path from "node:path";
import { bindings, defineConfig, exports } from "cf/config";

function loadEnvLocal(): Record<string, string> {
  const result: Record<string, string> = {};
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return result;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

const localEnv = loadEnvLocal();
const customDomain = (process.env.NONEPWD_CF_DOMAIN ?? localEnv.NONEPWD_CF_DOMAIN ?? "").trim();
const d1DatabaseId = (process.env.NONEPWD_CF_D1_ID ?? localEnv.NONEPWD_CF_D1_ID ?? "").trim();

export default defineConfig({
  worker: {
    name: "nonepwd-cf-server",
    compatibilityDate: "2025-10-01",
    entrypoint: "dist/index.js",
    workersDev: customDomain.length === 0,
    ...(customDomain ? { domains: [customDomain] } : {}),
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/agent/*", "/install.sh", "/downloads/*", "/llms.txt", "/SKILL.md", "/skill.md"],
    },
    // No Cron Triggers. Workers Free on this account already has 5.
    // IMAP sync is the VaultWsHub alarm named "imap", about once a minute.
    exports: {
      VaultWsHub: exports.durableObject({ storage: "sqlite" }),
      AgentRelayHub: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      FORWARD_TO_EMAIL: bindings.text(""),
      DB: bindings.d1(d1DatabaseId ? { name: "nonepwd-db", id: d1DatabaseId } : { name: "nonepwd-db" }),
      BUCKET: bindings.r2({
        name: "nonepwd-vault-blobs",
      }),
      WS_HUB: bindings.durableObject({
        worker: "nonepwd-cf-server",
        exportName: "VaultWsHub",
      }),
      AGENT_RELAY: bindings.durableObject({
        worker: "nonepwd-cf-server",
        exportName: "AgentRelayHub",
      }),
      ASSETS: bindings.assets(),
    },
  },
});
