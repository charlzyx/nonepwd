import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "nonepwd",
    compatibilityDate: "2025-10-01",
    entrypoint: "src/index.ts",
    workersDev: true,
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/install.sh"],
    },
    env: {
      ASSETS: bindings.assets(),
    },
  },
});
