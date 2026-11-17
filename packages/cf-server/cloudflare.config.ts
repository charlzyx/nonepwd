import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
  worker: {
    name: "nonepwd-cf-server",
    compatibilityDate: "2025-10-01",
    entrypoint: "dist/index.js",
    workersDev: true,
    domains: ["vault.yourdomain.com"],
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/install.sh", "/downloads/*"],
    },
    // Optional Cron trigger if the Cloudflare account has free Cron slots available.
    // Even without a Cron trigger, `waitUntil(maybeAutoSnapshot)` snapshots D1->R2 every 6h on activity.
    // triggers: [{ type: "scheduled", schedule: "0 */6 * * *" }],
    exports: {
      VaultWsHub: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      FORWARD_TO_EMAIL: bindings.text(""),
      DB: bindings.d1({
        name: "nonepwd-db",
        id: "00000000-0000-0000-0000-000000000000",
      }),
      BUCKET: bindings.r2({
        name: "nonepwd-vault-blobs",
      }),
      WS_HUB: bindings.durableObject({
        worker: "nonepwd-cf-server",
        exportName: "VaultWsHub",
      }),
      ASSETS: bindings.assets(),
    },
  },
});
