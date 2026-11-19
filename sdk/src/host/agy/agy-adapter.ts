import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentRunResult } from "../../core/types.js";
import type {
  HarnessAdapter,
  HarnessAdapterContext,
  HarnessAdapterRequest,
  InvocationInputs,
  SessionRef
} from "../../core/harness-runtime/contracts.js";
import { HarnessRuntimeError } from "../../core/harness-runtime/errors.js";
import { OfficialEventBridge } from "../../core/harness-runtime/official-event-bridge.js";
import {
  buildInvocationEnvironment,
  DEFAULT_RAW_LOG_LIMIT_BYTES
} from "../../core/harness-runtime/process-host.js";
import { JsonLineConnection, ResidentTurnActivityClock } from "../../core/harness-runtime/resident-native-driver.js";
import {
  agentEnvironment,
  resolveOrchestrationControlMcpCommand,
  resolveSleepMcpCommand,
  resolveWorkspaceMcpCommand
} from "../../core/harness-runtime/runtime-support.js";
import { selectedSkillInstructions } from "../../core/harness-runtime/selected-skills.js";
import { fixedMcpToken, isFixedMcpServer, resolvedMcpServers } from "../../core/mcp-directory.js";
import {
  PUBLISHED_ARTIFACT_MANIFEST_ENV,
  PUBLISHED_ARTIFACT_MANIFEST_FILENAME
} from "../../core/published-artifact-access.js";
import {
  AdapterBase,
  adapterResult,
  harnessExecutableLaunch,
  settleAdapterCleanup,
  writeAdapterLogs,
  type AdapterMcpRow,
  type AdapterRuntimeOptions
} from "../../core/harness-runtime/adapters/adapter-utils.js";
import { AGY_DESCRIPTOR as descriptor } from "./descriptor.js";
import { agyAcpCodec, agyOfficialEventMapper, validAgySessionId } from "./agy-acp.js";
import { resolveAgyProfileLayout } from "./agy-profile.js";
import { buildAgyResidentLaunch } from "./resident-launch.js";

const SCRUBBED_OPENAI_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT"
] as const;

export class AgyAdapter extends AdapterBase implements HarnessAdapter {
  readonly resident = {
    protocol: "agy-acp-json-rpc",
    recoveryStrategy: "native-session-resume",
    createOfficialEventMapper: agyOfficialEventMapper,
    buildLaunch: buildAgyResidentLaunch
  } as const;

  constructor(options: AdapterRuntimeOptions = {}) {
    super(descriptor, options);
  }

  createSession(
    _request: HarnessAdapterRequest,
    _inputs: InvocationInputs,
    generation: number,
    durable: boolean
  ): SessionRef {
    return this.session(`pending:${randomUUID()}`, generation, durable);
  }

  validateNativeSession(id: string): boolean {
    return validAgySessionId(id);
  }

  sessionToLegacyId(session: SessionRef): string {
    return `agy:${session.nativeId}`;
  }

  sessionFromLegacyId(value: string, generation: number, durable: boolean): SessionRef | undefined {
    const id = value.startsWith("agy:") ? value.slice(4) : "";
    return validAgySessionId(id) ? this.session(id, generation, durable) : undefined;
  }

  async run(context: HarnessAdapterContext): Promise<AgentRunResult> {
    if (!("nativeAgyProfileHome" in context.route)) {
      throw new Error("Antigravity CLI (agy) requires a native Agy login profile route");
    }
    const executable = await this.resolveExecutable();
    if (!executable) {
      throw new HarnessRuntimeError(
        "HARNESS_UNAVAILABLE",
        "Antigravity CLI (agy) executable not found; install agy or configure harnesses.agy",
        { harnessId: "agy" }
      );
    }
    const { request, spec } = context;
    const layout = await resolveAgyProfileLayout(context.route.nativeAgyProfileHome);
    if (path.resolve(layout.launchHome) !== path.resolve(context.route.launchHome) ||
      layout.geminiDir !== context.route.geminiDir ||
      layout.appDataDir !== context.route.appDataDir) {
      throw new HarnessRuntimeError(
        "HARNESS_CONFIGURATION_INVALID",
        "Native Agy profile layout changed before invocation launch",
        { harnessId: "agy" }
      );
    }
    const config = request.project.agents[request.agent];
    if (!config) {
      throw new HarnessRuntimeError(
        "HARNESS_CONTRACT_VIOLATION",
        "Agy invocation is missing its selected Agent configuration",
        { harnessId: "agy" },
        { source: "runtime" }
      );
    }
    const [workspaceMcp, controlMcp] = await Promise.all([
      resolveWorkspaceMcpCommand(),
      request.control ? resolveOrchestrationControlMcpCommand() : Promise.resolve(undefined)
    ]);
    const configuredMcpServers = resolvedMcpServers(config.mcpServers);
    const token = configuredMcpServers.some(isFixedMcpServer) ? fixedMcpToken() : undefined;
    if (configuredMcpServers.some(isFixedMcpServer) && !token) {
      throw new HarnessRuntimeError(
        "HARNESS_CONFIGURATION_INVALID",
        "A selected system MCP requires its server credential",
        { harnessId: "agy" },
        { source: "adapter" }
      );
    }
    const common = agentEnvironment(
      layout.launchHome,
      spec.inputs.runtimePath,
      request.project.id,
      request.invocationId,
      request.agent,
      request.kind,
      request.permission,
      spec.inputs.projectPath,
      spec.inputs.workspacePath,
      this.options,
      [],
      undefined,
      token,
      request.control,
      undefined,
      descriptor.id,
      descriptor.nativeProtocol
    );
    delete common.CODEX_HOME;
    for (const key of SCRUBBED_OPENAI_ENV) delete common[key];
    const environment = buildInvocationEnvironment({ common });
    const mcpRows: AdapterMcpRow[] = [
      await resolveSleepMcpCommand().then((sleep) => ({
        name: "scienceevolve-sleep",
        namespace: "scienceevolve-sleep",
        transport: "stdio" as const,
        command: sleep.command,
        args: sleep.args
      })),
      ...(workspaceMcp ? [{
        name: "scienceevolve-workspace",
        namespace: "scienceevolve-workspace",
        transport: "stdio" as const,
        command: workspaceMcp.command,
        args: workspaceMcp.args,
        env: {
          SCIENCEEVOLVE_PROJECT_ID: request.project.id,
          SCIENCEEVOLVE_INVOCATION_ID: request.invocationId,
          SCIENCEEVOLVE_AGENT_NAME: request.agent,
          SCIENCEEVOLVE_APPEND_ROOT: spec.inputs.workspacePath,
          [PUBLISHED_ARTIFACT_MANIFEST_ENV]: path.join(
            spec.inputs.runtimePath,
            PUBLISHED_ARTIFACT_MANIFEST_FILENAME
          )
        }
      }] : []),
      ...(controlMcp ? [{
        name: "scienceevolve-orchestration-control",
        namespace: "scienceevolve-orchestration-control",
        transport: "stdio" as const,
        command: controlMcp.command,
        args: controlMcp.args,
        env: {
          ...(environment.SCIENCEEVOLVE_CONTROL_CONTEXT
            ? { SCIENCEEVOLVE_CONTROL_CONTEXT: environment.SCIENCEEVOLVE_CONTROL_CONTEXT }
            : {}),
          ...(environment.SCIENCEEVOLVE_CONTROL_CAPABILITY
            ? { SCIENCEEVOLVE_CONTROL_CAPABILITY: environment.SCIENCEEVOLVE_CONTROL_CAPABILITY }
            : {})
        }
      }] : []),
      ...configuredMcpServers.map((server) => ({
        name: server.name,
        namespace: server.name,
        transport: "streamable-http" as const,
        url: server.url!,
        ...(isFixedMcpServer(server) && token ? { headers: { Authorization: `Bearer ${token}` } } : {})
      }))
    ];
    const prompt = context.prepareNativeInput
      ? await context.prepareNativeInput(spec.prompt)
      : spec.prompt;
    const systemPromptAppend = selectedSkillInstructions([
      ...spec.policy.skillPaths,
      ...spec.policy.autoSkillPaths
    ]);
    const codec = agyAcpCodec({
      cwd: spec.inputs.workspacePath,
      model: spec.model,
      mcpRows,
      allowNativeTools: true,
      systemPromptAppend
    });
    const bridge = new OfficialEventBridge({
      descriptor,
      invocationId: spec.invocationId,
      mapEvent: agyOfficialEventMapper(),
      onEvent: context.onEvent,
      onActivity: request.onModelActivity
    });
    const args = [
      "acp",
      "--stdio",
      "--include-default-customizations=false",
      "--gemini-dir", layout.geminiDir,
      "--app-data-dir", layout.appDataDir,
      "--dangerously-skip-permissions"
    ];
    const managed = context.processHost.start({
      ...harnessExecutableLaunch(executable, args),
      cwd: spec.inputs.workspacePath,
      env: environment,
      eventFormat: "json-rpc",
      session: spec.session!,
      adapterEnvironmentKeys: [],
      rawLogLimitBytes: DEFAULT_RAW_LOG_LIMIT_BYTES
    }, {
      onStderr: (chunk) => context.onTrace("stderr", chunk, {
        harness: "agy",
        diagnostic: true,
        diagnosticSource: "cli"
      })
    });
    const clock = new ResidentTurnActivityClock(
      {
        modelTimeoutMs: this.options.residentModelInactivityTimeoutMs,
        toolTimeoutMs: this.options.residentToolInactivityTimeoutMs
      },
      (error) => {
        connection.fail(error);
        managed.terminate();
      }
    );
    const connection = new JsonLineConnection(
      managed.child,
      (frame) => bridge.accept(frame),
      (frame) => {
        const observation = codec.observe(frame);
        if (observation) clock.observe(observation);
      },
      "agy-acp-json-rpc"
    );
    void managed.completed.catch((error) => connection.fail(error));
    let failed = false;
    const timer = setTimeout(() => {
      connection.fail(new Error("Agy ACP initialization timed out"));
      managed.terminate();
    }, 60_000);
    try {
      const session = await codec.initialize(connection, spec.session!);
      await codec.settleIdle?.(connection, session);
      connection.assertQuiescent("Agy initialization");
      clearTimeout(timer);
      await context.onSessionStarted?.(session);
      clock.begin({ harnessId: "agy", invocationId: spec.invocationId });
      const turn = { inputId: spec.invocationId, invocationId: spec.invocationId, prompt, route: context.route };
      const result = await codec.submit(connection, session, turn);
      clock.end();
      await connection.settleCompletionTail(codec.completionTail, session, turn);
      connection.assertQuiescent("Agy completion");
      await bridge.finish();
      await managed.end();
      const closing = setTimeout(() => managed.terminate(), 5_000);
      try {
        const exit = await managed.completed;
        if (exit.code !== 0) {
          throw new HarnessRuntimeError("HARNESS_PROCESS_EXITED", "Agy exited unsuccessfully", {
            harnessId: "agy",
            exitCode: exit.code
          });
        }
      } finally {
        clearTimeout(closing);
      }
      return await adapterResult(request, session, result.handoff);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      clearTimeout(timer);
      clock.end();
      await settleAdapterCleanup({
        harnessId: "agy",
        invocationFailed: failed,
        onTrace: context.onTrace,
        steps: [
          { phase: "process-terminate", cleanup: () => { managed.terminate(); } },
          { phase: "process-wait", cleanup: async () => { await managed.completed; } },
          { phase: "write-adapter-logs", cleanup: async () => writeAdapterLogs(spec.inputs, "agy", "", (await managed.completed).stderr) }
        ]
      });
    }
  }
}
