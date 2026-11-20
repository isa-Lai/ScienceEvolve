import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMainApplicationRuntime, migrateMainRuntimeData, MAIN_RUNTIME_MARKER, MAIN_RUNTIME_SOURCE_COMMIT, MAIN_RUNTIME_REVISION, type MainApplicationRuntime } from "../src/main-runtime.js";
import { trackMainResidents, trackResidentOpens } from "../src/main-resident-tracker.js";
import type { CollaborationResidentLauncher, CollaborationResidentOpenInput } from "../src/core/collaboration-runtime.js";
import { ProductionCollaborationExecutionInputBuilder } from "../src/core/collaboration-runtime.js";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "../src/core/types.js";
import { harnessCatalogRegistry, toPublicHarnessDescriptor } from "../src/core/harness-runtime/registry.js";

const roots: string[] = [];
const runtimes: MainApplicationRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  vi.restoreAllMocks();
  // Every deletion target was allocated by this test using mkdtemp.
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-main-sdk-host-"));
  roots.push(root);
  return root;
}
async function host(root: string) {
  const runtime = await createMainApplicationRuntime({ dataDir: root });
  runtimes.push(runtime);
  return runtime;
}

describe("standalone main runtime host (local, no model/GitHub acceptance)", () => {
  it("migrates an existing paused project from Codex to Agy, archives its old Session, and leaves source untouched", async () => {
    const root = await directory(), source = path.join(root, "source"), destination = path.join(root, "destination");
    const profile = path.join(root, "home", ".gemini", "antigravity-cli");
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, "antigravity-oauth-token"), "fixture-token");
    await fs.writeFile(path.join(profile, "settings.json"), '{"selectedAuthType":"oauth-personal"}');
    let started!: () => void;
    const agentStarted = new Promise<void>(resolve => { started = resolve; });
    const observedHarnesses: string[] = [];
    const runner: AgentRunner = {
      harnessCatalog: async () => harnessCatalogRegistry.list().map((descriptor) => toPublicHarnessDescriptor(descriptor, { available: true })),
      run: async (request) => {
        observedHarnesses.push(request.project.agents[request.agent]!.harness ?? "codex");
        started();
        await new Promise<void>(resolve => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("paused migration fixture");
      }
    };
    const sourceRuntime = await createMainApplicationRuntime({ dataDir: source, skillRoots: [], internal: {
      runner, residentLauncher: { open: async () => { throw new Error("Git-off fixture must not launch a resident"); } }
    } });
    runtimes.push(sourceRuntime);
    const gateway = await sourceRuntime.gatewayStore.create({ name: "fixture", url: "https://93.184.216.34/v1",
      apiKey: "fixture-not-a-live-secret", models: ["fixture-model"], defaultModel: "fixture-model", protocol: "responses" });
    const project = await sourceRuntime.orchestrator.createProject({ title: "Harness migration", requirement: "Continue with a fresh harness session.",
      git: { enabled: false }, agents: { main: { model: "fixture-model", gatewayId: gateway.id, harness: "codex", skills: [], autoSkills: [] } },
      orchestration: { agents: [{ name: "main", template: "main" }], input: { source: "input", target: "main" }, routes: { main: [] },
        decisionPlans: { main: "Continue" }, termination: { agent: "main", condition: "Done", decisionBy: "main", automatic: false },
        resultFormat: { presets: [], custom: "" } } });
    await agentStarted;
    await sourceRuntime.orchestrator.pause(project.id);
    await vi.waitFor(async () => expect((await sourceRuntime.orchestrator.getProject(project.id)).status).toBe("paused"));
    const sourceState = await sourceRuntime.storage.loadState(project.id);
    const oldSession = { schemaVersion: 1 as const, harnessId: "codex", adapterVersion: "codex-fixture-v1", generation: 0,
      nativeId: "codex-old-session", durable: true, createdAt: new Date().toISOString() };
    sourceState!.agentSessions = { main: oldSession };
    sourceState!.agentSessionIds = { main: "codex-old-session" };
    await sourceRuntime.storage.saveState(sourceState!);
    await sourceRuntime.close();
    const sourceMarkerPath = path.join(source, MAIN_RUNTIME_MARKER);
    await fs.writeFile(sourceMarkerPath, JSON.stringify({ schemaVersion: 1, engine: "main-runtime",
      sourceCommit: "61d257921a5c98903d305941e450b27e6a757af1",
      runtimeRevision: "61d257921a5c98903d305941e450b27e6a757af1+5b16d1f83fc9c54a" }) + "\n");
    const sourceStateBefore = await fs.readFile(path.join(source, "projects", project.id, "state.json"));
    const result = await migrateMainRuntimeData({ sourceDataDir: source, destinationDataDir: destination, model: "gemini-fixture",
      harness: "agy", nativeProfileId: "login", runtime: { nativeAgyProfiles: { login: profile }, skillRoots: [], internal: {
        runner, residentLauncher: { open: async () => { throw new Error("Deferred migration must not launch a resident"); } }
      } } });
    expect(result).toMatchObject({ projects: 1, agents: 1, model: "gemini-fixture", harness: "agy" });
    expect(await fs.readFile(path.join(source, "projects", project.id, "state.json"))).toEqual(sourceStateBefore);
    const migrated = await createMainApplicationRuntime({ dataDir: destination, nativeAgyProfiles: { login: profile }, skillRoots: [], internal: {
      runner, residentLauncher: { open: async () => { throw new Error("Paused migration fixture must not launch a resident"); } }
    } });
    runtimes.push(migrated);
    const state = await migrated.storage.loadState(project.id);
    expect(state?.agents.main).toMatchObject({ harness: "agy", nativeAgyProfileId: "login", model: "gemini-fixture" });
    expect(state?.agents.main).not.toHaveProperty("gatewayId");
    expect(state?.agentSessions?.main).toBeUndefined();
    expect(state?.agentSessionIds?.main).toBeUndefined();
    expect(state?.archivedAgentSessions).toContainEqual(expect.objectContaining({ agentId: "main", harnessId: "codex",
      sessions: { main: { session: oldSession, legacyId: "codex-old-session" } } }));
    expect((await migrated.orchestrator.getProject(project.id)).status).toBe("paused");
    await migrated.orchestrator.resume(project.id);
    await vi.waitFor(() => expect(observedHarnesses.at(-1)).toBe("agy"));
    await migrated.orchestrator.pause(project.id);
    await vi.waitFor(async () => expect((await migrated.orchestrator.getProject(project.id)).status).toBe("paused"));
  });

  it("migrates a current Agy project back to Codex with a fresh native session", async () => {
    const root = await directory(), source = path.join(root, "agy-source"), destination = path.join(root, "codex-destination");
    const agyProfile = path.join(root, "home", ".gemini", "antigravity-cli"), codexProfile = path.join(root, "codex-profile");
    await fs.mkdir(agyProfile, { recursive: true }); await fs.mkdir(codexProfile, { recursive: true });
    await fs.writeFile(path.join(agyProfile, "antigravity-oauth-token"), "fixture-token");
    await fs.writeFile(path.join(agyProfile, "settings.json"), '{"selectedAuthType":"oauth-personal"}');
    await fs.writeFile(path.join(codexProfile, "config.toml"), 'model_provider="fixture"\n');
    let started!: () => void;
    const agentStarted = new Promise<void>(resolve => { started = resolve; });
    const observedHarnesses: string[] = [];
    const runner: AgentRunner = {
      harnessCatalog: async () => harnessCatalogRegistry.list().map((descriptor) => toPublicHarnessDescriptor(descriptor, { available: true })),
      run: async (request) => {
        observedHarnesses.push(request.project.agents[request.agent]!.harness ?? "codex");
        started();
        await new Promise<void>(resolve => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("paused migration fixture");
      }
    };
    const sourceRuntime = await createMainApplicationRuntime({ dataDir: source, nativeAgyProfiles: { login: agyProfile }, skillRoots: [], internal: {
      runner, residentLauncher: { open: async () => { throw new Error("Git-off fixture must not launch a resident"); } }
    } });
    runtimes.push(sourceRuntime);
    const project = await sourceRuntime.orchestrator.createProject({ title: "Reverse harness migration", requirement: "Continue on Codex.",
      git: { enabled: false }, agents: { main: { model: "gemini-fixture", harness: "agy", nativeAgyProfileId: "login", skills: [], autoSkills: [] } },
      orchestration: { agents: [{ name: "main", template: "main" }], input: { source: "input", target: "main" }, routes: { main: [] },
        decisionPlans: { main: "Continue" }, termination: { agent: "main", condition: "Done", decisionBy: "main", automatic: false },
        resultFormat: { presets: [], custom: "" } } });
    await agentStarted;
    await sourceRuntime.orchestrator.pause(project.id);
    await vi.waitFor(async () => expect((await sourceRuntime.orchestrator.getProject(project.id)).status).toBe("paused"));
    const state = await sourceRuntime.storage.loadState(project.id);
    const oldSession = { schemaVersion: 1 as const, harnessId: "agy", adapterVersion: "agy-fixture-v1", generation: 2,
      nativeId: "agy-old-session", durable: true, createdAt: new Date().toISOString() };
    state!.agentSessions = { main: oldSession }; state!.agentSessionIds = { main: "agy-old-session" };
    await sourceRuntime.storage.saveState(state!); await sourceRuntime.close();
    const result = await migrateMainRuntimeData({ sourceDataDir: source, destinationDataDir: destination, model: "codex-fixture",
      harness: "codex", nativeProfileId: "login", runtime: { nativeCodexProfiles: { login: codexProfile }, skillRoots: [], internal: {
        runner, residentLauncher: { open: async () => { throw new Error("Deferred migration must not launch a resident"); } }
      } } });
    expect(result).toMatchObject({ projects: 1, agents: 1, model: "codex-fixture", harness: "codex" });
    const migrated = await createMainApplicationRuntime({ dataDir: destination, nativeCodexProfiles: { login: codexProfile }, skillRoots: [], internal: {
      runner, residentLauncher: { open: async () => { throw new Error("Paused migration fixture must not launch a resident"); } }
    } });
    runtimes.push(migrated);
    const migratedState = await migrated.storage.loadState(project.id);
    expect(migratedState?.agents.main).toMatchObject({ harness: "codex", nativeCodexProfileId: "login", model: "codex-fixture" });
    expect(migratedState?.agents.main).not.toHaveProperty("nativeAgyProfileId");
    expect(migratedState?.agentSessions?.main).toBeUndefined();
    expect(migratedState?.archivedAgentSessions).toContainEqual(expect.objectContaining({ agentId: "main", harnessId: "agy",
      sessions: { main: { session: oldSession, legacyId: "agy-old-session" } } }));
    expect((await migrated.orchestrator.getProject(project.id)).status).toBe("paused");
    await migrated.orchestrator.resume(project.id);
    await vi.waitFor(() => expect(observedHarnesses.at(-1)).toBe("codex"));
    await migrated.orchestrator.pause(project.id);
    await vi.waitFor(async () => expect((await migrated.orchestrator.getProject(project.id)).status).toBe("paused"));
  });

  it("verifies the pinned main closure without a main checkout", () => {
    const script = fileURLToPath(new URL("../scripts/sync-main-runtime.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [script, "--check"], { cwd: os.tmpdir(), encoding: "utf8" });
    expect(output).toContain(MAIN_RUNTIME_SOURCE_COMMIT);
  });

  it("uses actual SQLite, releases its writer lease and can reopen", async () => {
    const root = await directory();
    const first = await host(root);
    expect(first.sourceCommit).toBe(MAIN_RUNTIME_SOURCE_COMMIT);
    expect(first.runtimeRevision).toBe(MAIN_RUNTIME_REVISION);
    expect(JSON.parse(await fs.readFile(path.join(root, MAIN_RUNTIME_MARKER), "utf8"))).toMatchObject({ engine: "main-runtime", schemaVersion: 1 });
    const dbPath = path.join(root, "collaboration-state.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      expect(tables.length).toBeGreaterThan(10);
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    } finally { db.close(); }
    await Promise.all([first.close(), first.close()]);
    await expect(fs.access(path.join(root, ".scienceevolve-runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    const second = await host(root);
    expect(await second.orchestrator.listProjects()).toEqual([]);
  });

  it("does not open the same directory twice and releases its lock on close", async () => {
    const root = await directory();
    const runtime = await host(root);
    await expect(createMainApplicationRuntime({ dataDir: root })).rejects.toThrow(/in use/);
    await runtime.close();
    await expect(fs.access(path.join(root, ".scienceevolve-runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects legacy/source directories without touching their contents", async () => {
    const root = await directory();
    await fs.mkdir(path.join(root, "projects"));
    const evidence = path.join(root, "projects", "existing.json");
    await fs.writeFile(evidence, "user data must stay unchanged");
    await expect(createMainApplicationRuntime({ dataDir: root })).rejects.toThrow(/empty dedicated/);
    expect(await fs.readFile(evidence, "utf8")).toBe("user data must stay unchanged");
    await expect(fs.access(path.join(root, MAIN_RUNTIME_MARKER))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(root, ".scienceevolve-runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on another pinned data revision and releases a failed initialization lock", async () => {
    const root = await directory();
    await fs.writeFile(path.join(root, MAIN_RUNTIME_MARKER), JSON.stringify({ engine: "main-runtime", schemaVersion: 1, sourceCommit: "another-revision" }));
    await expect(createMainApplicationRuntime({ dataDir: root })).rejects.toThrow(/explicit migration/);
    await expect(fs.access(path.join(root, ".scienceevolve-runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not silently reopen pre-fix data with only an upstream commit marker", async () => {
    const root = await directory();
    const marker = JSON.stringify({ engine: "main-runtime", schemaVersion: 1, sourceCommit: MAIN_RUNTIME_SOURCE_COMMIT });
    await fs.writeFile(path.join(root, MAIN_RUNTIME_MARKER), marker);
    await expect(createMainApplicationRuntime({ dataDir: root })).rejects.toThrow(/explicit migration/);
    expect(await fs.readFile(path.join(root, MAIN_RUNTIME_MARKER), "utf8")).toBe(marker);
    await expect(fs.access(path.join(root, ".scienceevolve-runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts a Git-off project through the unmodified main Orchestrator (simulated model result)", async () => {
    const root = await directory();
    const run = vi.fn(async (request: AgentRunRequest): Promise<AgentRunResult> => ({
      handoff: "fixture evidence", controlActions: [{
        projectId: request.project.id, agent: request.agent, invocationId: request.invocationId,
        callId: `${request.invocationId}-complete`, stateVersion: request.control!.stateVersion,
        capabilityHash: request.control!.capabilityHash, receivedAt: new Date().toISOString(),
        action: { tool: "complete_project", rationale: "fixture acceptance satisfied" }
      }]
    }));
    const runner: AgentRunner = {
      harnessCatalog: async () => harnessCatalogRegistry.list().map((descriptor) => toPublicHarnessDescriptor(descriptor, { available: true })),
      run
    };
    const runtime = await createMainApplicationRuntime({ dataDir: root, skillRoots: [], internal: {
      runner, residentLauncher: { open: async () => { throw new Error("Git-off project must not launch a resident"); } }
    } });
    runtimes.push(runtime);
    // A declared fixture gateway, not a forged passing probe; the runner is
    // simulated and no HTTP inference request is performed in this test.
    const gateway = await runtime.gatewayStore.create({ name: "fixture", url: "https://93.184.216.34/v1",
      apiKey: "fixture-not-a-live-secret", models: ["fixture-model"], defaultModel: "fixture-model", protocol: "responses" });
    const project = await runtime.orchestrator.createProject({
      title: "SDK main core fixture", requirement: "Complete local deterministic acceptance, not a real model test.",
      git: { enabled: false }, agents: { main: { model: "fixture-model", gatewayId: gateway.id, skills: [], autoSkills: [] } },
      orchestration: {
        agents: [{ name: "main", template: "main" }], input: { source: "input", target: "main" },
        routes: { main: [] }, decisionPlans: { main: "Complete the bounded task" },
        termination: { agent: "main", condition: "Fixture done", decisionBy: "main", automatic: false },
        resultFormat: { presets: [], custom: "" }
      }
    });
    const deadline = Date.now() + 5_000;
    let state = await runtime.orchestrator.getProject(project.id);
    while (!["completed", "paused", "cancelled"].includes(state.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = await runtime.orchestrator.getProject(project.id);
    }
    expect(state.status, state.lastError).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
    const storedState = await runtime.storage.loadState(project.id);
    const documents = runtime.collaborationRuntime.projectStateDocuments();
    expect(await documents.domain(project.id)).toMatchObject({ protocol: "project-state-v1", scheduler: "serial" });
    expect((await documents.read(project.id, "project.checkpoint"))!.value).toMatchObject({ id: project.id, status: "completed" });
    expect((await documents.read(project.id, "sii.ledger"))!.value).toEqual({ version: 1, experiments: [], waits: [] });
    const exportedState = path.join(runtime.storage.projectDir(project.id), "state.json");
    expect(JSON.parse(await fs.readFile(exportedState, "utf8"))).toMatchObject({
      formalState: { protocol: "project-state-v1", source: "sqlite" }, view: { status: "completed" }
    });
    // The exported file is a view, not a second scheduler authority. A stale
    // or edited view must not manufacture a paused/completed runtime fact.
    await fs.writeFile(exportedState, JSON.stringify({ id: project.id, status: "paused" }));
    expect((await runtime.storage.loadState(project.id)).status).toBe("completed");
    await runtime.storage.saveState(storedState!);
    const sourceBindings = JSON.parse(await fs.readFile(path.join(root, "source-workspaces", "bindings.json"), "utf8"));
    expect(sourceBindings.projects[project.id]).toBe(null); // raw host API retains explicit no-source semantics
    const builder = new ProductionCollaborationExecutionInputBuilder(runtime.storage, runtime.skills);
    const request = await builder.build({
      state: storedState!, agentId: "main", assignment: "fixture schema lookup",
      executionContext: { role: "leader", nodeRunId: "node-fixture", routeScopeId: "route-fixture", coordinatorEpoch: 1 },
      invocationId: "invocation-fixture", inboxPath: path.join(root, "fixture-inbox"),
      projectPath: runtime.storage.projectDir(project.id), worktreePath: path.join(root, "fixture-worktree"),
      runtimePath: path.join(root, "fixture-runtime")
    });
    expect(path.basename(request.schemaPath)).toBe("main-decision.json");
    await expect(fs.access(request.schemaPath)).resolves.toBeUndefined();
  });

  it("does not request Git credentials or modify profile configuration on initialization", async () => {
    const root = await directory();
    const credentialResolver = vi.fn(async () => ({ token: "fixture-not-a-live-secret", requestedScopes: ["repo"] }));
    const runtime = await createMainApplicationRuntime({ dataDir: root, git: { credentialResolver } });
    runtimes.push(runtime);
    expect(credentialResolver).not.toHaveBeenCalled();
    expect((await fs.readdir(root)).sort()).not.toContain("auth.json");
    expect((await fs.readdir(root)).sort()).not.toContain("config.toml");
  });

  it("requires absolute paths", async () => {
    await expect(createMainApplicationRuntime({ dataDir: "relative-dir" })).rejects.toThrow(/absolute/);
  });
});

describe("SDK resident Stop guard", () => {
  it("tracks route residents opened through an internal launcher closure and preserves native handle extensions", async () => {
    let permitStop = false;
    const adapter = { async open() { return {
      initialLease: { session: { nativeId: "route-only" } },
      async probe() { return this.initialLease; },
      async close() { if (!permitStop) throw new Error("route native still alive"); }
    }; } };
    const native = trackResidentOpens(adapter);
    const launcher = { open: async () => { throw new Error("ordinary open was not called"); },
      async decideRoute() {
        const route = await native.launcher.open();
        expect((await route.probe()).session.nativeId).toBe("route-only");
        await route.close();
      }
    };
    await expect(launcher.decideRoute()).rejects.toThrow(/route native still alive/);
    await expect(native.stopRemaining()).rejects.toThrow(/Stop was not confirmed/);
    permitStop = true;
    await native.stopRemaining();
  });
  it("retains failed stops, preserves method receivers and allows a later proven stop", async () => {
    let permitStop = false;
    const close = vi.fn(async () => { if (!permitStop) throw new Error("native still alive"); });
    const target = {
      proof: "bound receiver",
      async open() { return { close, submit: async () => ({ handoff: "fixture" }), pause: async () => {}, resume: async () => {} }; },
      stopForRecovery() { expect(this.proof).toBe("bound receiver"); return Promise.resolve({ stopped: true, evidence: {} }); }
    };
    const tracking = trackMainResidents(target as CollaborationResidentLauncher);
    const handle = await tracking.launcher.open({} as CollaborationResidentOpenInput);
    await expect(handle.close()).rejects.toThrow(/native still alive/);
    await expect(tracking.stopRemaining()).rejects.toThrow(/Stop was not confirmed/);
    await tracking.launcher.stopForRecovery!({} as never);
    permitStop = true;
    await tracking.stopRemaining();
    const count = close.mock.calls.length;
    await tracking.stopRemaining();
    expect(close).toHaveBeenCalledTimes(count);
  });
});
