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
  waitFor,
} from "./harness";
import { GITHUB_APP_ID, TEST_SECRETS } from "./config";
import { toolCall, type Script, type Transcript } from "./fakes/model";

let fakes: Fakes;
/** Report-only off globally and team sre allowed Agent PRs: the setting under which they are opened. */
const PRS_ON = { reportOnly: false, agentPrTeams: ["sre"] };

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
function deployedService(opts: { main?: Record<string, string>; service?: string } = {}) {
  const service = opts.service ?? `svc-${uniqueMonitorId()}`;
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
/**
 * Markdown with its code removed, as CommonMark parses it: fenced blocks (closed only by a fence of the same
 * character at least as long) and code spans (a backtick run closed by the next run of exactly the same length).
 * GitHub makes no links, mentions, references or HTML inside code.
 */
function outsideCode(markdown: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    if (fence === undefined) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) fence = open[1];
      else kept.push(line);
    } else if (new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}\\s*$`).test(line)) {
      fence = undefined;
    }
  }
  expect(fence, "a fenced block never closed").toBeUndefined();
  let text = kept.join("\n");
  let out = "";
  for (let i = 0; i < text.length; ) {
    const run = text.slice(i).match(/^`+/)?.[0];
    if (!run) {
      out += text[i++];
      continue;
    }
    let close = -1;
    for (const m of text.slice(i + run.length).matchAll(/`+/g)) {
      if (m[0].length === run.length) {
        close = i + run.length + m.index!;
        break;
      }
    }
    if (close < 0) {
      out += run;
      i += run.length;
    } else {
      i = close + run.length;
    }
  }
  text = out;
  return text;
}

/** Teams text with escapes and dot defanging read past. */
const shown = (text: string) => text.replace(/\\(.)/g, "$1").replace(/\[\.\]/g, ".");
const writeTokens = () => fakes.github.tokens.filter((t) => t.permissions.contents === "write" || t.permissions.pull_requests === "write");

describe("Agent PR", () => {
  it("opens one draft PR from main on an oncall-agent/ branch with the agent's edits; the report links it", async () => {
    const { service, repo } = deployedService();
    fakes.model.script(fixScript());
    const alert = alertFor(service);

    await sendWebhook(alert);

    await waitFor(() => expect(reports()).toHaveLength(1));
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

    await waitFor(() => expect(reports()).toHaveLength(1));
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

    await waitFor(() => expect(reports()).toHaveLength(1));
    await settle();
    expect(fakes.github.pulls(repo)).toEqual([]);
    expect(fakes.github.refWrites).toEqual([]);
    expect(writeTokens()).toEqual([]);
    expect(reports()[0]!.text).not.toContain("Agent PR");
  });

  it.each([
    ["is on globally, even for a team allowed Agent PRs", { reportOnly: true, agentPrTeams: ["sre"] }, ["team:sre"]],
    ["is off globally but the Owning team is not allowed Agent PRs", { reportOnly: false, agentPrTeams: ["payments"] }, ["team:sre"]],
    ["is off globally but the monitor names no Owning team", { reportOnly: false, agentPrTeams: ["sre"] }, []],
  ])("posts the report but opens no branch and no PR when Report-only mode %s", async (_, config, teamTags) => {
    fakes = installFakes({ config });
    const { service, repo } = deployedService();
    fakes.model.script(fixScript());

    await sendWebhook({ ...alertFor(service), tags: ["oncall-agent:enabled", `service:${service}`, ...teamTags] });

    await waitFor(() => expect(reports()).toHaveLength(1));
    await settle();
    expect(fakes.github.pulls(repo)).toEqual([]);
    expect(fakes.github.refWrites).toEqual([]);
    expect(writeTokens()).toEqual([]);
    expect(reports()[0]!.text).toContain("Report-only mode");
  });

  it("opens no PR when a file the agent changed also changed on main since the deployed commit; the report lists it", async () => {
    const onMain = CHECKOUT.replace("const total = cart.total;", "const total = cart.total ?? 0;");
    const { service, repo } = deployedService({ main: { ...FILES, "src/checkout.ts": onMain, "README.md": "# checkout v2\n" } });
    fakes.model.script(fixScript());

    await sendWebhook(alertFor(service));

    await waitFor(() => expect(reports()).toHaveLength(1));
    await settle();
    // The edit was made on the deployed version: pushed onto main it would silently undo main's change.
    expect(fakes.github.pulls(repo)).toEqual([]);
    expect(fakes.github.refWrites).toEqual([]);
    expect(fakes.github.calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/access_tokens"))).toEqual([]); // nothing written
    const report = shown(reports()[0]!.text);
    expect(report).toContain("changed on main since the deployed commit");
    expect(report).toContain("src/checkout.ts");
    expect(report).not.toContain("README.md"); // changed on main, but not by the agent
  });

  it("opens the PR when main changed only files the agent did not touch", async () => {
    const { service, repo } = deployedService({ main: { ...FILES, "src/cart.ts": "export const cart = { total: 1 };\n" } });
    fakes.model.script(fixScript());

    await sendWebhook(alertFor(service));

    await waitFor(() => expect(reports()).toHaveLength(1));
    const [pr] = fakes.github.pulls(repo);
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
    await waitFor(() => expect(reports()).toHaveLength(1));
    const [pr] = fakes.github.pulls(repo);
    const firstHead = fakes.github.commit(repo, pr!.head)!.sha;

    fakes.github.advanceMain(repo, { ...FILES, "README.md": "# checkout, moved on\n" });
    await sendWebhook({ ...opened, alertId: `${opened.alertId}-r`, transition: "Recovered" });
    await sendWebhook({ ...opened, alertId: `${opened.alertId}-2`, title: "[Triggered] second episode of checkout errors" });

    await waitFor(() => expect(reports()).toHaveLength(2));
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

  it("never pushes over commits a Code owner added to the Agent PR branch: it comments on the PR instead", async () => {
    const { service, repo } = deployedService();
    const second = fixScript({ edits: [["write", { path: "src/guard.ts", content: "export const guard = 1;\n" }]] });
    fakes.model.script((t) => (t.alert.includes("second episode") ? second(t) : fixScript()(t)));
    const opened = alertFor(service);
    await sendWebhook(opened);
    await waitFor(() => expect(reports()).toHaveLength(1));
    const [pr] = fakes.github.pulls(repo);
    const humanHead = fakes.github.pushHumanCommit(repo, pr!.head, { "src/checkout.ts": `${FIXED}// reviewed\n` });
    const writesBefore = fakes.github.refWrites.length;

    await sendWebhook({ ...opened, alertId: `${opened.alertId}-r`, transition: "Recovered" });
    await sendWebhook({ ...opened, alertId: `${opened.alertId}-2`, title: "[Triggered] second episode of checkout errors" });

    await waitFor(() => expect(reports()).toHaveLength(2));
    await settle();
    expect(fakes.github.refWrites).toHaveLength(writesBefore);
    expect(fakes.github.commit(repo, pr!.head)!.sha).toBe(humanHead);
    expect(fakes.github.pulls(repo)).toHaveLength(1);
    const { comments } = fakes.github.pulls(repo)[0]!;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("new Alert episode");
    expect(comments[0]).toContain("not pushed");
    const report = shown(reports()[1]!.text);
    expect(report).toContain("commits not made by the oncall agent");
    expect(report).toContain(`https://github.com/${repo}/pull/${pr!.number}`);
  });

  /** Episode 1 opens the Agent PR; returns what a test needs to drive episode 2 of the same monitor group. */
  async function openedAgentPr() {
    const { service, repo } = deployedService();
    const second = fixScript({ edits: [["write", { path: "src/guard.ts", content: "export const guard = 1;\n" }]] });
    fakes.model.script((t) => (t.alert.includes("second episode") ? second(t) : fixScript()(t)));
    const opened = alertFor(service);
    await sendWebhook(opened);
    await waitFor(() => expect(reports()).toHaveLength(1));
    const [pr] = fakes.github.pulls(repo);
    const secondEpisode = async () => {
      await sendWebhook({ ...opened, alertId: `${opened.alertId}-r`, transition: "Recovered" });
      await sendWebhook({ ...opened, alertId: `${opened.alertId}-2`, title: "[Triggered] second episode of checkout errors" });
    };
    return { repo, pr: pr!, alert: opened, secondEpisode };
  }

  /** The second episode left the branch at the Code owner's commit, commented once, and the report says why. */
  function expectLeftAlone(repo: string, pr: { head: string; number: number }, humanHead: string, writesBefore: number) {
    expect(fakes.github.refWrites).toHaveLength(writesBefore);
    expect(fakes.github.commit(repo, pr.head)!.sha).toBe(humanHead);
    const { comments } = fakes.github.pulls(repo)[0]!;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("not pushed");
    const report = shown(reports()[1]!.text);
    expect(report).toContain("commits not made by the oncall agent");
    expect(report).toContain(`https://github.com/${repo}/pull/${pr.number}`);
  }

  it("checks the branch again before pushing on a replay: a Code owner's commit pushed meanwhile is never forced over", async () => {
    const { repo, pr, alert, secondEpisode } = await openedAgentPr();
    const writesBefore = fakes.github.refWrites.length;
    // Episode 2 records its commit, then loses GitHub's answer to the branch check right before the push.
    const loss = fakes.github.loseAnswer("GET", /\/git\/ref\/heads\/oncall-agent\//);

    await secondEpisode();
    await waitFor(() => expect(loss.lost()).toBe(true));
    const humanHead = fakes.github.pushHumanCommit(repo, pr.head, { "src/checkout.ts": `${FIXED}// reviewed\n` });
    await abortAllDurableObjects(); // and evicted: the retry is a replay
    await waitFor(
      async () => {
        await runDurableObjectAlarm(investigationOf(alert));
        expect(reports()).toHaveLength(2);
      },
      { interval: 200 },
    );
    await settle();

    expectLeftAlone(repo, pr, humanHead, writesBefore);
  });

  it("never forces over a Code owner's commit that lands between the branch check and the push (compare-and-swap)", async () => {
    const { repo, pr, secondEpisode } = await openedAgentPr();
    const writesBefore = fakes.github.refWrites.length;
    let humanHead = "";
    fakes.github.beforeNextRefUpdate(repo, () => {
      humanHead = fakes.github.pushHumanCommit(repo, pr.head, { "src/checkout.ts": `${FIXED}// reviewed\n` });
    });

    await secondEpisode();

    await waitFor(() => expect(reports()).toHaveLength(2));
    await settle();
    expectLeftAlone(repo, pr, humanHead, writesBefore);
  });

  it("finds drift even when GitHub's compare leaves the drifted file out (it lists at most 300 files)", async () => {
    const onMain = CHECKOUT.replace("const total = cart.total;", "const total = cart.total ?? 0;");
    const { service, repo } = deployedService({ main: { ...FILES, "src/checkout.ts": onMain } });
    fakes.github.truncateCompare(repo);
    fakes.model.script(fixScript());

    await sendWebhook(alertFor(service));

    await waitFor(() => expect(reports()).toHaveLength(1));
    await settle();
    expect(fakes.github.pulls(repo)).toEqual([]);
    expect(fakes.github.refWrites).toEqual([]);
    expect(shown(reports()[0]!.text)).toMatch(/changed on main since the deployed commit.*: src\/checkout\.ts\./);
  });

  it("treats a file it cannot compare between the deployed commit and main as drifted: no PR", async () => {
    const { service, repo } = deployedService();
    fakes.github.contentsDown(repo);
    fakes.model.script(fixScript());

    await sendWebhook(alertFor(service));

    await waitFor(() => expect(reports()).toHaveLength(1));
    await settle();
    expect(fakes.github.pulls(repo)).toEqual([]);
    expect(fakes.github.refWrites).toEqual([]);
    expect(shown(reports()[0]!.text)).toContain("src/checkout.ts");
  });

  it("links the open Agent PR of the monitor group from a later Alert episode without a fix, until it is closed", async () => {
    const { service, repo } = deployedService();
    fakes.model.script((t) => (t.alert.includes("later episode") ? fixScript({ fixProposed: false, edits: [] })(t) : fixScript()(t)));
    const opened = alertFor(service);
    const episode = (n: number) => ({ ...opened, alertId: `${opened.alertId}-${n}`, title: "[Triggered] later episode" });
    const recovered = (n: number) => ({ ...opened, alertId: `${opened.alertId}-r${n}`, transition: "Recovered" });
    await sendWebhook(opened);
    await waitFor(() => expect(reports()).toHaveLength(1));
    const [pr] = fakes.github.pulls(repo);

    await sendWebhook(recovered(1));
    await sendWebhook(episode(2));
    await waitFor(() => expect(reports()).toHaveLength(2));
    expect(reports()[1]!.text).toContain(`https://github.com/${repo}/pull/${pr!.number}`);
    expect(shown(reports()[1]!.text)).toContain("earlier Alert episode");

    fakes.github.closePull(repo, pr!.number);
    await settle();
    await sendWebhook(recovered(2));
    await sendWebhook(episode(3));
    await waitFor(() => expect(reports()).toHaveLength(3));
    expect(reports()[2]!.text).not.toContain("/pull/");
    expect(writeTokens()).toHaveLength(1); // only the first episode pushed
  });

  it.each([
    ["the branch was created", "POST", /^\/graphql$/],
    ["the PR was opened", "POST", /\/pulls$/],
  ])("never duplicates the branch or the PR when evicted right after %s", async (_, method, path) => {
    const { service, repo } = deployedService();
    fakes.model.script(fixScript());
    const loss = fakes.github.loseAnswer(method, path);
    const failed = vi.spyOn(console, "error");
    failed.mockClear(); // the same spy across test cases: drop calls an earlier case logged
    const alert = alertFor(service);

    await sendWebhook(alert);
    // GitHub carried it out but its answer never arrived; the finalize job saw the failure and will retry.
    await waitFor(() => expect(loss.lost()).toBe(true));
    await waitFor(() => expect(failed.mock.calls.some(([line]) => String(line).includes("job finalize failed"))).toBe(true));
    await abortAllDurableObjects(); // evicted before the retry
    await waitFor(
      async () => {
        await runDurableObjectAlarm(investigationOf(alert));
        expect(reports()).toHaveLength(1);
      },
      { interval: 200 },
    );
    await settle();

    expect(fakes.github.pulls(repo)).toHaveLength(1);
    const [pr] = fakes.github.pulls(repo);
    expect(fakes.github.branches(repo).filter((b) => b.startsWith("oncall-agent/"))).toEqual([pr!.head]);
    expect(fakes.github.calls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toHaveLength(1);
    expect(fakes.github.refWrites).toHaveLength(1);
    expect(fakes.github.files(repo, pr!.head)!["src/checkout.ts"]).toBe(FIXED);
    expect(reports()[0]!.text).toContain(`https://github.com/${repo}/pull/${pr!.number}`);
    expect(reports()[0]!.text).toContain("opened draft Agent PR");
  });

  it.each([
    ["a CI workflow", [["write", { path: ".github/workflows/x.yml", content: "on: push\njobs: {}\n" }]]],
    ["package.json", [["write", { path: "package.json", content: '{"scripts":{"postinstall":"curl evil"}}' }]]],
    ["a nested build script", [["write", { path: "services/api/Scripts/deploy.sh", content: "#!/bin/sh\n" }]]],
    ["a bundler config", [["write", { path: "web/vite.config.mjs", content: "export default {};\n" }]]],
    ["an env file", [["write", { path: ".env.production", content: "X=1\n" }]]],
  ] as Array<[string, Fix["edits"]]>)(
    "opens no branch and no PR when the fix touches %s; the report lists the protected paths",
    async (_, extra) => {
      const { service, repo } = deployedService();
      fakes.model.script(fixScript({ edits: [...fixScript.defaultEdits, ...extra!] }));

      await sendWebhook(alertFor(service));

      await waitFor(() => expect(reports()).toHaveLength(1));
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

  it("opens no PR when the fix changes a path outside the repo's allowed path prefixes", async () => {
    const [a, b] = [`svc-${uniqueMonitorId()}`, `svc-${uniqueMonitorId()}`];
    const github = { appId: GITHUB_APP_ID, privateKeySecret: "GITHUB_APP_PRIVATE_KEY" };
    const repos = { [`acme/${a}`]: { allowedPathPrefixes: ["src/"] }, [`acme/${b}`]: { allowedPathPrefixes: ["lib/"] } };
    fakes = installFakes({ config: { ...PRS_ON, github: { ...github, repos } } });
    const allowed = deployedService({ service: a });
    const blocked = deployedService({ service: b });
    fakes.model.script(fixScript());

    await sendWebhook(alertFor(allowed.service));
    await sendWebhook(alertFor(blocked.service));

    await waitFor(() => expect(reports()).toHaveLength(2));
    await settle();
    expect(fakes.github.pulls(allowed.repo)).toHaveLength(1);
    expect(fakes.github.pulls(blocked.repo)).toEqual([]);
    const report = shown(reports().find((r) => !r.text.includes("pull/"))!.text);
    expect(report).toContain("allowed");
    expect(report).toContain("src/checkout.ts");
  });

  it("renders the model's text in the PR as plain text: no links, @mentions, #references or HTML", async () => {
    const { service, repo } = deployedService();
    const hostile = [
      "ping @octocat and @acme/security-team, see #42 and acme/other#7",
      "[click here](https://evil.example/x) <img src=x onerror=alert(1)> https://evil.example www.evil.example",
      "```\n@octocat outside the fence? #43\n```",
      "````` five backticks ` and `` two",
    ];
    fakes.model.script(
      fixScript({
        edits: [...fixScript.defaultEdits, ["write", { path: "docs/@octocat-#44 <b>.md", content: "x\n" }]],
        whatFired: hostile[0],
        evidence: hostile.slice(1),
        suspectedCause: "@octocat broke it in #45, details at https://evil.example/y",
      }),
    );
    const alert = alertFor(service);

    await sendWebhook(alert);

    await waitFor(() => expect(reports()).toHaveLength(1));
    const [pr] = fakes.github.pulls(repo);
    // Everything the model wrote is there, as code.
    for (const text of ["ping @octocat", "<img src=x onerror=alert(1)>", "five backticks", "@octocat broke it in #45", "docs/@octocat-#44 <b>.md"]) {
      expect(pr!.body).toContain(text);
    }
    // Outside code (what GitHub renders as markdown) only the harness's own text and monitor link remain.
    const rendered = outsideCode(pr!.body).replace(`[Open monitor](<${alert.link}>)`, "");
    expect(rendered).not.toMatch(/@[A-Za-z0-9]/);
    expect(rendered).not.toMatch(/#\d/);
    expect(rendered).not.toMatch(/https?:|www\.|<|\]\(/i);
    expect(rendered).not.toContain("octocat");
    expect(pr!.title).not.toMatch(/[@#<]|https?:/);
  });

  it("still posts the report, saying the Agent PR could not be opened, when GitHub refuses", async () => {
    const service = `svc-${uniqueMonitorId()}`;
    const repo = `acme/${service}`;
    fakes.datadog.gitTags(TEST_SECRETS.GAP_DATADOG_TOKEN, service, { repositoryUrl: `https://github.com/${repo}`, commitSha: DEPLOYED });
    fakes.workspace.repo(repo, DEPLOYED, FILES); // checked out, but GitHub knows no such repo for the REST calls
    fakes.model.script(fixScript());

    await sendWebhook(alertFor(service));

    await waitFor(() => expect(reports()).toHaveLength(1));
    expect(reports()[0]!.text).toContain("could not be opened");
    expect(reports()[0]!.text).toContain("404");
    for (const { token } of fakes.github.tokens) expect(reports()[0]!.text).not.toContain(token);
  });

  it("opens Agent PRs only for the Owning teams allowed them once Report-only mode is off globally", async () => {
    fakes = installFakes({ config: { reportOnly: false, agentPrTeams: ["payments"] } });
    const pilot = deployedService();
    const other = deployedService();
    fakes.model.script(fixScript());

    await sendWebhook(alertFor(pilot.service, { team: "payments" }));
    await sendWebhook(alertFor(other.service, { team: "sre" }));

    await waitFor(() => expect(reports()).toHaveLength(2));
    await settle();
    expect(fakes.github.pulls(pilot.repo)).toHaveLength(1);
    expect(fakes.github.pulls(other.repo)).toEqual([]);
  });
});
