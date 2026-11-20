import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CollaborationStateDatabase } from "../src/core/collaboration-state/store.js";
import { cloneAgentOrchestrationTemplate } from "../src/core/agent-orchestration.js";
import { mergeAgentConfigs } from "../src/core/validation.js";

const roots: string[] = [];
const stores: CollaborationStateDatabase[] = [];
afterEach(async () => {
  stores.splice(0).forEach(store => store.close());
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("explicit native Harness migration state", () => {
  it("retires old binding guards at migration while retaining history and guarding new bindings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "main-harness-migration-state-")); roots.push(root);
    const database = CollaborationStateDatabase.open({ databasePath: path.join(root, "state.sqlite"), serviceId: "migration-test",
      instanceId: "writer", hostId: "fixture", topology: "single-host", leaseDurationMs: 30_000 });
    stores.push(database);
    const graph = cloneAgentOrchestrationTemplate(); graph.schemaVersion = 3;
    database.createProject({ projectId: "project", workflowRevision: 1, workflowSnapshot: graph,
      git: { enabled: true, status: "ready" }, workerCapacity: 2 });
    database.initializeScopedConfiguration("project", { agents: mergeAgentConfigs(undefined, graph), skillDefinitions: {}, mcpDefinitions: {} });
    const session = (harnessId: "codex" | "agy", nativeId: string) => ({ schemaVersion: 1 as const, harnessId,
      adapterVersion: "fixture", generation: 0, nativeId, durable: true, createdAt: "2026-11-20T00:00:00.000Z" });
    const binding = (invocationId: string, harnessId: "codex" | "agy", nativeId: string) => ({ projectId: "project", agentId: "main",
      invocationId, runtimePath: path.join(root, "runtime", invocationId), worktreePath: path.join(root, "worktree"),
      executionContext: { role: "leader" as const, nodeRunId: `node-${invocationId}`, routeScopeId: `scope-${invocationId}`, coordinatorEpoch: 1 },
      session: session(harnessId, nativeId) });

    database.recordAgentNativeSessionBinding(binding("before-switch", "codex", "codex-session"));
    const before = database.workflowAdjustmentCurrent("project");
    expect(() => database.assertRetainedWorkflowSessionHarnesses("project", before.snapshot.agents)).not.toThrow();
    database.setResumeAgentModels("project", "agy-model", "runtime-harness-migration:codex-to-agy", before.version.hash,
      { harness: "agy", nativeProfileId: "login" });
    const after = database.workflowAdjustmentCurrent("project");
    expect(after.snapshot.agents.main).toMatchObject({ model: "agy-model", harness: "agy", nativeAgyProfileId: "login" });
    expect(() => database.assertRetainedWorkflowSessionHarnesses("project", after.snapshot.agents)).not.toThrow();
    expect(database.latestAgentNativeSessionBinding("project", "main")?.session).toEqual(session("codex", "codex-session"));

    database.recordAgentNativeSessionBinding(binding("after-switch", "agy", "agy-session"));
    const codexProposal = structuredClone(after.snapshot.agents);
    codexProposal.main!.harness = "codex";
    delete codexProposal.main!.nativeAgyProfileId;
    codexProposal.main!.nativeCodexProfileId = "login";
    expect(() => database.assertRetainedWorkflowSessionHarnesses("project", codexProposal)).toThrow(/agy/);
    expect(() => database.assertRetainedWorkflowSessionHarnesses("project", after.snapshot.agents)).not.toThrow();
  });
});
