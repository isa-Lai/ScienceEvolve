import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGY_DESCRIPTOR } from "../src/host/agy/descriptor.js";
import { AgyAdapter } from "../src/host/agy/agy-adapter.js";
import { agyMcpServers, agyOfficialEventMapper, validAgySessionId } from "../src/host/agy/agy-acp.js";
import { resolveAgyProfileLayout } from "../src/host/agy/agy-profile.js";
import { buildAgyResidentLaunch } from "../src/host/agy/resident-launch.js";
import { OfficialEventBridge } from "../src/core/harness-runtime/official-event-bridge.js";
import { NATIVE_PROCESS_SUPPORT_ENV } from "../src/core/harness-runtime/native-processes.js";
import { createMainResearchSdk } from "../src/main-client.js";
import { validateMainWorkflowConfig } from "../src/main-config.js";
import type { InvocationSpec } from "../src/core/harness-runtime/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 })));
});

async function mkDir(prefix = "scienceevolve-agy-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe("Antigravity CLI (agy) profile layout & ACP protocol", () => {
  it("resolves nested .gemini/antigravity-cli, flat dirs, and home roots without reading tokens", async () => {
    const root = await mkDir();
    const nested = path.join(root, "user1", ".gemini", "antigravity-cli");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "antigravity-oauth-token"), "opaque-token");

    expect(await resolveAgyProfileLayout(nested)).toEqual({
      profileHome: await fs.realpath(nested),
      launchHome: await fs.realpath(path.join(root, "user1")),
      geminiDir: ".gemini",
      appDataDir: "antigravity-cli"
    });
    expect(await resolveAgyProfileLayout(path.join(root, "user1"))).toEqual({
      profileHome: await fs.realpath(path.join(root, "user1")),
      launchHome: await fs.realpath(path.join(root, "user1")),
      geminiDir: ".gemini",
      appDataDir: "antigravity-cli"
    });

    const flat = path.join(root, "flat-profile");
    await fs.mkdir(flat, { recursive: true });
    await fs.writeFile(path.join(flat, "settings.json"), "{}");
    expect(await resolveAgyProfileLayout(flat)).toEqual({
      profileHome: await fs.realpath(flat),
      launchHome: await fs.realpath(root),
      geminiDir: ".",
      appDataDir: "flat-profile"
    });

    const symlinkProfile = path.join(root, "symlink-profile");
    await fs.mkdir(symlinkProfile, { recursive: true });
    await fs.symlink(path.join(nested, "antigravity-oauth-token"), path.join(symlinkProfile, "antigravity-oauth-token"));
    await expect(resolveAgyProfileLayout(symlinkProfile)).rejects.toThrow(/regular non-symlink/);

    const emptyProfile = path.join(root, "empty");
    await fs.mkdir(emptyProfile, { recursive: true });
    await expect(resolveAgyProfileLayout(emptyProfile)).rejects.toThrow(/requires a regular/);
  });

  it("maps stdio/http MCP servers and ACP updates cleanly through OfficialEventBridge", async () => {
    expect(validAgySessionId("sess-123_abc:1")).toBe(true);
    expect(validAgySessionId("pending:abc")).toBe(false);

    const servers = agyMcpServers([
      {
        name: "workspace",
        namespace: "workspace",
        transport: "stdio",
        command: "node",
        args: ["mcp.mjs"],
        env: { FOO: "bar" }
      },
      {
        name: "remote",
        namespace: "remote",
        transport: "http",
        url: "http://127.0.0.1:8080/mcp",
        headers: { Authorization: "Bearer tok" }
      }
    ]);
    expect(servers[0]).toEqual({
      name: "workspace",
      command: "node",
      args: ["mcp.mjs"],
      env: [
        { name: "FOO", value: "bar" },
        { name: NATIVE_PROCESS_SUPPORT_ENV, value: "1" }
      ]
    });
    expect(servers[1]).toEqual({
      type: "http",
      name: "remote",
      url: "http://127.0.0.1:8080/mcp",
      headers: [{ name: "Authorization", value: "Bearer tok" }]
    });

    const emitted: unknown[] = [];
    const bridge = new OfficialEventBridge({
      descriptor: AGY_DESCRIPTOR,
      invocationId: "inv-agy-test",
      mapEvent: agyOfficialEventMapper(),
      onEvent: (event) => { emitted.push(event); }
    });
    await bridge.accept({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret" } } }
    });
    await bridge.accept({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "tc-1", name: "run_command", status: "in_progress", rawInput: { command: "ls" } } }
    });
    await bridge.accept({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "ok" } }
    });
    await bridge.accept({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello " } } }
    });
    await bridge.accept({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "world!" } } }
    });
    await bridge.accept({
      jsonrpc: "2.0",
      id: 4,
      result: { stopReason: "end_turn", model: "gemini-2.5-pro", usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, totalTokens: 15 } }
    });
    await bridge.finish();

    expect(emitted.some((e: any) => e.kind === "activity")).toBe(true);
    expect(emitted.some((e: any) => e.kind === "tool.started" && e.tool?.toolType === "shell")).toBe(true);
    expect(emitted.some((e: any) => e.kind === "tool.completed" && e.tool?.outputPreview === "ok")).toBe(true);
    expect(emitted.some((e: any) => e.kind === "assistant.message" && e.message === "Hello world!")).toBe(true);
    expect(emitted.some((e: any) => e.kind === "usage" && e.usage?.totalTokens === 15)).toBe(true);
    expect(JSON.stringify(emitted)).not.toContain("secret");
  });

  it("executes ordinary and resident ACP turns through SDK + ProcessHost with isolated HOME and scrubbed env", { timeout: 15_000 }, async () => {
    const root = await mkDir();
    const profileDir = path.join(root, "auth-home", ".gemini", "antigravity-cli");
    const dataDir = path.join(root, "data");
    const workspaceDir = path.join(root, "workspace");
    await Promise.all([
      fs.mkdir(profileDir, { recursive: true }),
      fs.mkdir(dataDir, { recursive: true }),
      fs.mkdir(workspaceDir, { recursive: true })
    ]);
    await fs.writeFile(path.join(profileDir, "antigravity-oauth-token"), "fixture-oauth");

    const recordFile = path.join(root, "fake-agy-calls.jsonl");
    const fakeAgy = path.join(root, "fake-agy.mjs");
    await fs.writeFile(fakeAgy, `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";
fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  home: process.env.HOME,
  openaiKey: process.env.OPENAI_API_KEY ?? null,
  codexHome: process.env.CODEX_HOME ?? null
}) + "\\n");
let savedMcpServers = [];
async function completeViaControlMcp(mcpServers) {
  const ctrl = mcpServers.find((s) => s.name === "scienceevolve-orchestration-control");
  if (!ctrl) throw new Error("Missing scienceevolve-orchestration-control MCP");
  const child = spawn(ctrl.command, ctrl.args, {
    env: { ...process.env, ...Object.fromEntries((ctrl.env || []).map((e) => [e.name, e.value])) },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const rpc = (msg) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rl.off("line", onLine);
      child.off("exit", onExit);
      reject(new Error("control-mcp timeout on " + msg.method + "; stderr=" + stderr));
    }, 3000);
    const onLine = (line) => {
      if (!line.trim()) return;
      const frame = JSON.parse(line);
      if (frame.id === msg.id) {
        clearTimeout(timer);
        rl.off("line", onLine);
        child.off("exit", onExit);
        frame.error ? reject(new Error(frame.error.message)) : resolve(frame.result);
      }
    };
    const onExit = (code) => {
      clearTimeout(timer);
      rl.off("line", onLine);
      reject(new Error("control-mcp exited " + code + ": " + stderr));
    };
    rl.on("line", onLine);
    child.once("exit", onExit);
    child.stdin.write(JSON.stringify(msg) + "\\n");
  });
  try {
    await rpc({ jsonrpc: "2.0", id: "init-1", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-agy", version: "1" } } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
    const callRes = await rpc({ jsonrpc: "2.0", id: "call-complete-1", method: "tools/call", params: { name: "complete_project", arguments: { callId: "call-complete-1", rationale: "Fake ACP completed" } } });
    if (callRes?.isError) throw new Error("MCP complete_project failed: " + JSON.stringify(callRes));
  } finally {
    child.kill();
  }
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("close", () => process.exit(0));
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let turnKind = "";
rl.on("line", async (line) => {
  try {
    if (!line.trim()) return;
    const req = JSON.parse(line);
    if (req.method === "initialize") {
      return send({ jsonrpc: "2.0", id: req.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
        agentInfo: { name: "Antigravity ACP Server" }
      } });
    }
    if (req.method === "session/new") {
      turnKind = "new";
      savedMcpServers = req.params.mcpServers || [];
      fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ newSession: req.params }) + "\\n");
      return send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "agy-sess-001" } });
    }
    if (req.method === "session/resume") {
      turnKind = "resume";
      savedMcpServers = req.params.mcpServers || [];
      fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ resumeSession: req.params }) + "\\n");
      return send({ jsonrpc: "2.0", id: req.id, result: { sessionId: req.params.sessionId } });
    }
    if (req.method === "session/set_model") {
      return send({ jsonrpc: "2.0", id: req.id, result: {} });
    }
    if (req.method === "session/prompt") {
      if (turnKind === "resume") {
        await completeViaControlMcp(savedMcpServers);
      }
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: req.params.sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: turnKind === "resume" ? "Fake ACP completed" : "Fake ACP turn 1" } } } });
      return send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn", model: "gemini-2.5-pro", usage: { inputTokens: 12, outputTokens: 4, cachedReadTokens: 0, totalTokens: 16 } } });
    }
    if (req.method === "session/close") {
      send({ jsonrpc: "2.0", id: req.id, result: {} });
      process.exit(0);
    }
  } catch (err) {
    fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ rpcError: String(err) }) + "\\n");
    process.stderr.write("FAKE_AGY_ERR: " + String(err) + "\\n");
    process.exit(1);
  }
});
`, { mode: 0o755 });

    process.env.OPENAI_API_KEY = "should-be-scrubbed";
    process.env.OPENAI_BASE_URL = "http://should-not-leak";
    const layout = await resolveAgyProfileLayout(profileDir);

    // Verify resident launch plan & session/resume codec path.
    const route = {
      authorityId: "auth-agy-1",
      harnessId: "agy" as const,
      purpose: "workflow" as const,
      model: "gemini-2.5-pro",
      nativeAgyProfileHome: layout.profileHome,
      launchHome: layout.launchHome,
      geminiDir: layout.geminiDir,
      appDataDir: layout.appDataDir,
      close: async () => {}
    };
    const spec: InvocationSpec = {
      invocationId: "inv-1",
      harnessId: "agy",
      model: "gemini-2.5-pro",
      prompt: "Analyze workspace",
      session: { harnessId: "agy", nativeId: "pending:00000000-0000-4000-8000-000000000001", generation: 1, durable: false },
      inputs: {
        runtimePath: root,
        projectPath: root,
        workspacePath: workspaceDir,
        environment: {}
      },
      policy: {
        skillPaths: [],
        autoSkillPaths: [],
        mcpServers: [],
        webSearch: false,
        permission: "standard",
        sandboxMode: "workspace-write"
      },
      timeouts: { startupMs: 10_000, turnMs: 10_000, quietTimeoutMs: 10_000 }
    };
    const residentAdapter = new AgyAdapter({ harnesses: { agy: fakeAgy } });
    const residentDef = await buildAgyResidentLaunch({
      adapter: residentAdapter,
      executable: fakeAgy,
      spec,
      launchRoute: route as any,
      filesystemAuthority: { writableRoots: [workspaceDir], rawTools: "allowed" } as any,
      processBinding: { commonEnvironment: { HOME: layout.launchHome } } as any,
      mcpRows: []
    } as any);
    expect(residentDef.plan.args).toEqual([
      "acp",
      "--stdio",
      "--include-default-customizations=false",
      "--gemini-dir", ".gemini",
      "--app-data-dir", "antigravity-cli",
      "--dangerously-skip-permissions"
    ]);
    expect(residentDef.plan.env.HOME).toBe(layout.launchHome);
    expect(residentDef.codec.protocol).toBe("agy-acp-json-rpc");
    expect(typeof residentDef.codec.initialize).toBe("function");

    // Verify real SDK + AgyAdapter + CommonProcessHost integration
    const sdk = await createMainResearchSdk({
      dataDir,
      nativeAgyProfiles: { login: profileDir },
      harnesses: { agy: fakeAgy },
      skillRoots: []
    });
    try {
      const wf = validateMainWorkflowConfig({
        git: { enabled: false },
        agents: { main: { model: "gemini-2.5-pro", harness: "agy", skills: [], autoSkills: [] } },
        orchestration: {
          schemaVersion: 2,
          collaborations: [],
          agents: [{ name: "main", template: "main" }],
          input: { source: "input", target: "main" },
          routes: { main: [] },
          decisionPlans: {},
          termination: { agent: "main", condition: "Done", decisionBy: "main", automatic: false },
          resultFormat: { presets: [], custom: "" }
        }
      });

      await expect(sdk.start({
        workflow: wf,
        requirement: "Say ok",
        gatewayBindings: { defaultGatewayId: "gwy_bad" }
      })).rejects.toThrow(/Native agy profile binding required/);

      const run = await sdk.start({
        title: "Agy ACP integration",
        requirement: "Analyze workspace",
        workflow: wf,
        gatewayBindings: { defaultNativeAgyProfileId: "login" },
        workspace: workspaceDir
      });
      const snapshot = await run.wait();
      expect(snapshot.status, `lastError=${snapshot.lastError}`).toBe("completed");
    } finally {
      await sdk.close();
    }

    const calls = (await fs.readFile(recordFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls[0]).toMatchObject({
      argv: [
        "acp",
        "--stdio",
        "--include-default-customizations=false",
        "--gemini-dir", ".gemini",
        "--app-data-dir", "antigravity-cli",
        "--dangerously-skip-permissions"
      ],
      home: layout.launchHome,
      openaiKey: null,
      codexHome: null
    });
    expect(calls.find((c) => c.newSession)?.newSession.cwd).toBe(await fs.realpath(workspaceDir));
    expect(calls.find((c) => c.resumeSession)?.resumeSession.sessionId).toBe("agy-sess-001");
  });
});
