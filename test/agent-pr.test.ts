import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertPayload, cleanUp, installFakes, sendWebhook, settle, uniqueMonitorId, type Fakes } from "./harness";
import { TEST_SECRETS } from "./config";
import { toolCall, type Script, type Transcript } from "./fakes/model";

let fakes: Fakes;
/** Report-only off globally: the setting under which Agent PRs are opened. */
const PRS_ON = { reportOnly: { global: false, teams: {} } };

beforeEach(() => {
  fakes = installFakes({ config: PRS_ON });
});
afterEach(async () => {
  // The harness only ever writes `oncall-agent/*` branches, whatever a test did.
  for (const write of fakes.github.refWrites) expect(write.ref).toMatch(/^refs\/heads\/oncall-agent\//);
  await cleanUp();
});

const DEPLOYED = "4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const CHECKOUT = [
  "export function checkout(customer) {",
  "  const total = cart.total;",
  "  return customer.id + total; // customer may be null",
  "}",
  "",
].join("\n");
const FIXED = CHECKOUT.replace("return customer.id + total;", "return (customer?.id ?? 0) + total;");
const FILES = { "src/checkout.ts": CHECKOUT, "src/cart.ts": "export const cart = { total: 0 };\n", "README.md": "# checkout\n" };

/**
 * A service whose spans carry git tags for `acme/<service>` at DEPLOYED: the repo on the fake GitHub (DEPLOYED and
 * `main` one commit later) and the same commit as a workspace fixture.
 */
function deployedService(opts: { main?: Record<string, string> } = {}) {
  const service = `svc-${uniqueMonitorId()}`;
  const repo = `acme/${service}`;
  fakes.datadog.gitTags(TEST_SECRETS.GAP_DATADOG_TOKEN, service, { repositoryUrl: `https://github.com/${repo}.git`, commitSha: DEPLOYED });
  fakes.github.repo(repo, { sha: DEPLOYED, files: FILES }, opts.main);
  fakes.workspace.repo(repo, DEPLOYED, FILES);
  return { service, repo };
}

function alertFor(service: string, opts: { team?: string; monitorId?: string } = {}) {
  return alertPayload({
    monitorId: opts.monitorId,
    group: `service:${service},env:prod`,
    tags: ["oncall-agent:enabled", `team:${opts.team ?? "sre"}`, `service:${service}`],
  });
}

interface Fix {
  edits?: Array<[string, Record<string, unknown>]>;
  fixProposed?: boolean;
  whatFired?: string;
  evidence?: string[];
  suspectedCause?: string;
}

/** The agent edits the workspace, one tool call per turn, then submits its report (stateless: counts tool results). */
function fixScript(fix: Fix = {}): Script {
  const edits = fix.edits ?? [
    ["edit", { path: "src/checkout.ts", edits: [{ oldText: "return customer.id + total;", newText: "return (customer?.id ?? 0) + total;" }] }],
  ];
  return (t: Transcript) => {
    const done = t.messages.filter((m) => m.role === "toolResult").length;
    if (done < edits.length) return toolCall(edits[done]![0], edits[done]![1]);
    return toolCall("submit_report", {
      whatFired: fix.whatFired ?? "Error rate on checkout above 5%",
      evidence: fix.evidence ?? ["Datadog logs: TypeError: Cannot read properties of null (reading 'id')"],
      suspectedCause: fix.suspectedCause ?? "src/checkout.ts:3 dereferences a null customer",
      fixProposed: fix.fixProposed ?? true,
    });
  };
}

const reports = () => fakes.teams.posts.filter((p) => p.text.startsWith("Investigation report:"));
const writeTokens = () => fakes.github.tokens.filter((t) => t.permissions.contents === "write" || t.permissions.pull_requests);

describe("Agent PR", () => {
  it("opens one draft PR from main on an oncall-agent/ branch with the agent's edits; the report links it", async () => {
    const { service, repo } = deployedService();
    fakes.model.script(fixScript());
    const alert = alertFor(service);

    await sendWebhook(alert);

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    const pulls = fakes.github.pulls(repo);
    expect(pulls).toHaveLength(1);
    const [pr] = pulls;
    expect(pr).toMatchObject({ base: "main", draft: true, state: "open" });
    expect(pr!.head).toMatch(/^oncall-agent\//);

    // The branch is main plus the agent's edit, in one commit on top of main.
    const mainFiles = fakes.github.files(repo, "main")!;
    expect(fakes.github.files(repo, pr!.head)).toEqual({ ...mainFiles, "src/checkout.ts": FIXED });
    expect(fakes.github.commit(repo, pr!.head)!.parents).toEqual([fakes.github.commit(repo, "main")!.sha]);

    expect(pr!.body).toContain(alert.link);
    expect(pr!.body).toContain("sre");
    expect(pr!.body).toContain("Error rate on checkout above 5%");
    expect(pr!.body).not.toMatch(/drift/i);

    expect(reports()[0]!.text).toContain(`https://github.com/${repo}/pull/${pr!.number}`);
    expect(fakes.github.authErrors).toEqual([]);
  });
});
