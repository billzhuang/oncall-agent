import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_SECRETS, testConfig } from "./test/config.ts";

// A throwaway GitHub App key pair per run: the Worker signs App JWTs with the private key (PKCS#8, as stored in
// production), and the fake GitHub verifies them with the public key.
const githubApp = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false, // never reach Cloudflare from tests
      miniflare: {
        // Overrides wrangler.jsonc vars. workerd cannot run jurisdictions, so DO_JURISDICTION is blank here.
        bindings: {
          DO_JURISDICTION: "",
          ONCALL_CONFIG: testConfig(),
          ...TEST_SECRETS,
          GITHUB_APP_PRIVATE_KEY: githubApp.privateKey,
          TEST_GITHUB_APP_PUBLIC_KEY: githubApp.publicKey,
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
