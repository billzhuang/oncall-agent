import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_SECRETS, testConfig } from "./test/config.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false, // never reach Cloudflare from tests
      miniflare: {
        // Overrides wrangler.jsonc vars. workerd cannot run jurisdictions, so DO_JURISDICTION is blank here.
        bindings: { DO_JURISDICTION: "", ONCALL_CONFIG: testConfig(), ...TEST_SECRETS },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
