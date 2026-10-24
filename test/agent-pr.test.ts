import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alertPayload,
  cleanUp,
  installFakes,
  investigationOf,
  sendWebhook,
  settle,
  uniqueMonitorId,
  type Fakes,
} from "./harness";
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
  const edits = fix.edits ?? fixScript.defaultEdits;
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

/** The default fix: guard the null customer in src/checkout.ts. */
fixScript.defaultEdits = [
  ["edit", { path: "src/checkout.ts", edits: [{ oldText: "return customer.id + total;", newText: "return (customer?.id ?? 0) + total;" }] }],
] as Array<[string, Record<string, unknown>]>;

const reports = () => fakes.teams.posts.filter((p) => p.text.startsWith("Investigation report:"));
/** Teams text with escapes and dot defanging read past. */
const shown = (text: string) => text.replace(/\\(.)/g, "$1").replace(/\[\.\]/g, ".");
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

  it("pushes with a token scoped to the one repo, contents:write and pull_requests:write only, shown to no one", async () => {
    const { service, repo } = deployedService();
    fakes.model.script(fixScript());
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");

    await sendWebhook(alertFor(service));

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    expect(fakes.github.pulls(repo)).toHaveLength(1);
    expect(writeTokens()).toHaveLength(1);
    const [issued] = writeTokens();
    expect(issued!.repositories).toEqual([service]);
    expect(issued!.permissions).toEqual({ contents: "write", pull_requests: "write" });
    expect(fakes.github.authErrors).toEqual([]);
    expect(fakes.github.jwtErrors).toEqual([]);

    const leaks = [
      JSON.stringify(fakes.teams.posts),
      JSON.stringify(fakes.model.requests),
      JSON.stringify(fakes.datadog.calls),
      JSON.stringify(fakes.github.calls.map((c) => c.body)),
      JSON.stringify(fakes.github.pulls(repo)),
      JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]),
      fakes.workspace.text(),
    ];
    for (const token of fakes.github.tokens.map((t) => t.token)) for (const place of leaks) expect(place).not.toContain(token);
  });

  it("opens no branch and no PR when the agent declares no fix, even with edits", async () => {
    const { service, repo } = deployedService();
    fakes.model.script(fixScript({ fixProposed: false }));

    await sendWebhook(alertFor(service));

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    await settle();
    expect(fakes.github.pulls(repo)).toEqual([]);
    expect(fakes.github.refWrites).toEqual([]);
    expect(writeTokens()).toEqual([]);
    expect(reports()[0]!.text).not.toContain("Agent PR");
  });

  it.each([
    ["globally", { global: true, teams: {} }],
    ["for the Owning team", { global: false, teams: { sre: true } }],
  ])("posts the report but opens no branch and no PR under Report-only mode %s", async (_, reportOnly) => {
    fakes = installFakes({ config: { reportOnly } });
    const { service, repo } = deployedService();
    fakes.model.script(fixScript());

    await sendWebhook(alertFor(service));

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    await settle();
    expect(fakes.github.pulls(repo)).toEqual([]);
    expect(fakes.github.refWrites).toEqual([]);
    expect(writeTokens()).toEqual([]);
    expect(reports()[0]!.text).toContain("Report-only mode");
  });

  it("warns of drift when a file the agent changed also changed on main since the deployed commit", async () => {
    const onMain = CHECKOUT.replace("const total = cart.total;", "const total = cart.total ?? 0;");
    const { service, repo } = deployedService({ main: { ...FILES, "src/checkout.ts": onMain, "README.md": "# checkout v2\n" } });
    fakes.model.script(fixScript());

    await sendWebhook(alertFor(service));

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    const [pr] = fakes.github.pulls(repo);
    expect(pr!.body).toMatch(/drift/i);
    expect(pr!.body).toContain("src/checkout.ts");
    expect(pr!.body).not.toContain("README.md"); // changed on main, but not by the agent
    expect(reports()[0]!.text).toContain("changed on main since the deployed commit");
  });

  it("gives no drift warning when main changed only files the agent did not touch", async () => {
    const { service, repo } = deployedService({ main: { ...FILES, "src/cart.ts": "export const cart = { total: 1 };\n" } });
    fakes.model.script(fixScript());

    await sendWebhook(alertFor(service));

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    const [pr] = fakes.github.pulls(repo);
    expect(pr!.body).not.toMatch(/drift/i);
    expect(fakes.github.files(repo, pr!.head)).toEqual({ ...FILES, "src/cart.ts": "export const cart = { total: 1 };\n", "src/checkout.ts": FIXED });
  });

  it("updates the open Agent PR from the same branch on a second Alert episode of the monitor group, no new PR", async () => {
    const { service, repo } = deployedService();
    const first = fixScript();
    const second = fixScript({
      edits: [["write", { path: "src/guard.ts", content: "export const guard = (c) => c ?? { id: 0 };\n" }]],
      suspectedCause: "second episode: the guard is missing",
    });
    fakes.model.script((t) => (t.alert.includes("second episode") ? second(t) : first(t)));
    const monitorId = uniqueMonitorId();
    const opened = alertFor(service, { monitorId });

    await sendWebhook(opened);
    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    const [pr] = fakes.github.pulls(repo);
    const firstHead = fakes.github.commit(repo, pr!.head)!.sha;

    fakes.github.advanceMain(repo, { ...FILES, "README.md": "# checkout, moved on\n" });
    await sendWebhook({ ...opened, alertId: `${opened.alertId}-r`, transition: "Recovered" });
    await sendWebhook({ ...opened, alertId: `${opened.alertId}-2`, title: "[Triggered] second episode of checkout errors" });

    await vi.waitFor(() => expect(reports()).toHaveLength(2));
    await settle();
    const pulls = fakes.github.pulls(repo);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.number).toBe(pr!.number);
    expect(pulls[0]!.body).toContain("second episode: the guard is missing");
    expect(fakes.github.branches(repo).filter((b) => b.startsWith("oncall-agent/"))).toEqual([pr!.head]);
    const head = fakes.github.commit(repo, pr!.head)!;
    expect(head.sha).not.toBe(firstHead);
    expect(head.parents).toEqual([fakes.github.commit(repo, "main")!.sha]);
    expect(fakes.github.files(repo, pr!.head)).toEqual({
      ...FILES,
      "README.md": "# checkout, moved on\n",
      "src/guard.ts": "export const guard = (c) => c ?? { id: 0 };\n",
    });
    expect(reports()[1]!.text).toContain(`https://github.com/${repo}/pull/${pr!.number}`);
    expect(reports()[1]!.text).toContain("updated");
  });

  it.each([
    ["the branch was created", "POST", /\/git\/refs$/],
    ["the PR was opened", "POST", /\/pulls$/],
  ])("never duplicates the branch or the PR when evicted right after %s", async (_, method, path) => {
    const { service, repo } = deployedService();
    fakes.model.script(fixScript());
    const loss = fakes.github.loseAnswer(method, path);
    const failed = vi.spyOn(console, "error");
    const alert = alertFor(service);

    await sendWebhook(alert);
    // GitHub carried it out but its answer never arrived; the finalize job saw the failure and will retry.
    await vi.waitFor(() => expect(loss.lost()).toBe(true));
    await vi.waitFor(() => expect(failed.mock.calls.some(([line]) => String(line).includes("job finalize failed"))).toBe(true));
    await abortAllDurableObjects(); // evicted before the retry
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(investigationOf(alert));
        expect(reports()).toHaveLength(1);
      },
      { timeout: 15_000, interval: 200 },
    );
    await settle();

    expect(fakes.github.pulls(repo)).toHaveLength(1);
    const [pr] = fakes.github.pulls(repo);
    expect(fakes.github.branches(repo).filter((b) => b.startsWith("oncall-agent/"))).toEqual([pr!.head]);
    expect(fakes.github.calls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toHaveLength(1);
    expect(fakes.github.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/refs"))).toHaveLength(1);
    expect(fakes.github.files(repo, pr!.head)!["src/checkout.ts"]).toBe(FIXED);
    expect(reports()[0]!.text).toContain(`https://github.com/${repo}/pull/${pr!.number}`);
    expect(reports()[0]!.text).toContain("opened draft Agent PR");
  });

  it.each([
    ["a CI workflow", [["write", { path: ".github/workflows/x.yml", content: "on: push\njobs: {}\n" }]]],
    ["package.json", [["write", { path: "package.json", content: '{"scripts":{"postinstall":"curl evil"}}' }]]],
    ["a nested build script", [["write", { path: "services/api/Scripts/deploy.sh", content: "#!/bin/sh\n" }]]],
  ] as Array<[string, Fix["edits"]]>)(
    "opens no branch and no PR when the fix touches %s; the report lists the protected paths",
    async (_, extra) => {
      const { service, repo } = deployedService();
      fakes.model.script(fixScript({ edits: [...fixScript.defaultEdits, ...extra!] }));

      await sendWebhook(alertFor(service));

      await vi.waitFor(() => expect(reports()).toHaveLength(1));
      await settle();
      expect(fakes.github.pulls(repo)).toEqual([]);
      expect(fakes.github.refWrites).toEqual([]);
      expect(writeTokens()).toEqual([]);
      const report = shown(reports()[0]!.text);
      expect(report).toContain("protected paths");
      expect(report).toContain(String(extra![0]![1].path));
      expect(report).not.toContain("src/checkout.ts,"); // lists only the protected ones
    },
  );

  it("opens Agent PRs for a team whose Report-only switch is off while it stays on globally", async () => {
    fakes = installFakes({ config: { reportOnly: { global: true, teams: { payments: false } } } });
    const pilot = deployedService();
    const other = deployedService();
    fakes.model.script(fixScript());

    await sendWebhook(alertFor(pilot.service, { team: "payments" }));
    await sendWebhook(alertFor(other.service, { team: "sre" }));

    await vi.waitFor(() => expect(reports()).toHaveLength(2));
    await settle();
    expect(fakes.github.pulls(pilot.repo)).toHaveLength(1);
    expect(fakes.github.pulls(other.repo)).toEqual([]);
  });
});
