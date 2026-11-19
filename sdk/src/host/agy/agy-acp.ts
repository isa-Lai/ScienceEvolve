import type { HarnessEventKind, ResidentKnownUsage } from "../../core/harness-runtime/contracts.js";
import type { ResidentProtocolObservation, SessionRef } from "../../core/harness-runtime/contracts.js";
import type { ResidentProtocolCodec, ResidentProtocolConnection } from "../../core/harness-runtime/resident-native-driver.js";
import { HarnessRuntimeError, SessionResumeError } from "../../core/harness-runtime/errors.js";
import { boundedPreview, safeEventText, type HarnessEventDraft, type OfficialEventMapper } from "../../core/harness-runtime/official-event-bridge.js";
import type { AdapterMcpRow } from "../../core/harness-runtime/adapters/adapter-utils.js";
import { NATIVE_PROCESS_SUPPORT_ENV } from "../../core/harness-runtime/native-processes.js";

type Frame = Readonly<Record<string, unknown>>;

const metadataUpdates = new Set([
  "available_commands_update",
  "usage_update",
  "session_info_update",
  "current_mode_update",
  "config_option_update"
]);

const FILE_TOOL_NAMES = new Set([
  "read_file", "write_file", "edit_file", "view_file", "write_to_file",
  "replace_file_content", "multi_replace_file_content", "list_dir",
  "grep_search", "find_by_name"
]);

const WEB_TOOL_NAMES = new Set(["search_web", "read_url_content"]);

export const agyRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function failure(message: string): HarnessRuntimeError {
  return new HarnessRuntimeError(
    "HARNESS_CONTRACT_VIOLATION",
    `Agy ACP: ${message}`,
    { harnessId: "agy" },
    { source: "adapter" }
  );
}

async function initializationDeadline<T>(start: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      start(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(failure("initialization timed out (60000ms)")), 60_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function validAgySessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value) && !value.startsWith("pending:");
}

export function agyMcpServers(rows: readonly AdapterMcpRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => {
    if (row.transport === "stdio") {
      return {
        name: row.name,
        command: row.command,
        args: [...row.args],
        env: Object.entries({ ...row.env, [NATIVE_PROCESS_SUPPORT_ENV]: "1" })
          .map(([name, value]) => ({ name, value }))
      };
    }
    return {
      type: "http",
      name: row.name,
      url: row.url,
      headers: Object.entries(row.headers ?? {}).map(([name, value]) => ({ name, value }))
    };
  });
}

function updateFor(frame: Frame, expectedSession?: string): Record<string, unknown> | undefined {
  if (frame.method !== "session/update") return undefined;
  const params = agyRecord(frame.params);
  const sessionId = str(params?.sessionId);
  if (expectedSession && sessionId && sessionId !== expectedSession) return undefined;
  return agyRecord(params?.update);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = agyRecord(value);
  if (record?.type === "text" && typeof record.text === "string") return record.text;
  if (Array.isArray(value)) return value.map(contentText).join("");
  return "";
}

function toolContentText(value: unknown): string {
  if (!Array.isArray(value)) return contentText(value);
  return value.map((item) => {
    const record = agyRecord(item);
    return record?.type === "content" ? contentText(record.content) : contentText(item);
  }).filter(Boolean).join("\n");
}

function acpUsage(value: unknown): ResidentKnownUsage | undefined {
  const record = agyRecord(value);
  if (!record) return undefined;
  const inputTokens = num(record.inputTokens) ?? num(record.input_tokens);
  const outputTokens = num(record.outputTokens) ?? num(record.output_tokens);
  const cachedInputTokens = num(record.cachedReadTokens) ?? num(record.cached_read_tokens) ?? 0;
  const totalTokens = num(record.totalTokens) ?? num(record.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  const resolvedInput = inputTokens ?? 0;
  const resolvedOutput = outputTokens ?? 0;
  return {
    inputTokens: resolvedInput,
    outputTokens: resolvedOutput,
    cachedInputTokens,
    totalTokens: totalTokens ?? resolvedInput + resolvedOutput
  };
}

function classifyToolType(name: string): "shell" | "mcp" | "file" | "web" | "other" {
  if (name.startsWith("mcp_")) return "mcp";
  if (name === "run_command") return "shell";
  if (FILE_TOOL_NAMES.has(name)) return "file";
  if (WEB_TOOL_NAMES.has(name)) return "web";
  return "other";
}

function isTerminalFailureStatus(status: unknown): boolean {
  return status === "failed" || status === "error" || status === "cancelled";
}

function toolNameFromUpdate(update: Record<string, unknown>, existingName?: string): string {
  const direct = str(update.name);
  if (direct) return direct;
  const title = str(update.title);
  if (title) return title.split(": ")[0]!;
  return existingName ?? "tool";
}

export function agyOfficialEventMapper(): OfficialEventMapper {
  const messages = new Map<string, string>();
  const tools = new Map<string, { name: string; input?: unknown }>();
  const terminal = new Set<string>();
  return (frame): HarnessEventDraft[] => {
    const update = updateFor(frame);
    if (update) {
      const type = str(update.sessionUpdate) ?? "unknown";
      if (metadataUpdates.has(type)) return [];
      if (type === "agent_thought_chunk") {
        return [{ kind: "activity", sourceType: type }];
      }
      if (type === "agent_message_chunk") {
        const text = contentText(update.content);
        if (!text) return [];
        const key = str(update.messageId) ?? "reply";
        messages.set(key, (messages.get(key) ?? "") + text);
        return [{ kind: "assistant.delta", sourceType: type, itemId: key, message: safeEventText(text) }];
      }
      if (type === "tool_call" || type === "tool_call_update") {
        const callId = str(update.toolCallId);
        if (!callId) throw failure("tool event missing toolCallId");
        if (terminal.has(callId)) throw failure("tool event after terminal result");
        const existing = tools.get(callId);
        if (type === "tool_call") {
          if (existing) throw failure("duplicate tool start");
          const name = toolNameFromUpdate(update);
          const input = update.rawInput ?? update.args;
          tools.set(callId, { name, ...(input !== undefined ? { input } : {}) });
        } else if (!existing) {
          const name = toolNameFromUpdate(update);
          const input = update.rawInput ?? update.args;
          tools.set(callId, { name, ...(input !== undefined ? { input } : {}) });
        }
        const tool = tools.get(callId)!;
        const status: "started" | "updated" | "completed" | "failed" = isTerminalFailureStatus(update.status)
          ? "failed"
          : update.status === "completed"
            ? "completed"
            : type === "tool_call"
              ? "started"
              : "updated";
        const raw = update.rawOutput;
        const display = toolContentText(update.content);
        const preview = raw !== undefined && raw !== null
          ? boundedPreview(raw)
          : display
            ? boundedPreview(display)
            : undefined;
        if (status === "completed" || status === "failed") {
          tools.delete(callId);
          terminal.add(callId);
        }
        return [{
          kind: `tool.${status}` as HarnessEventKind,
          sourceType: type,
          message: tool.name,
          tool: {
            callId,
            name: tool.name,
            status,
            toolType: classifyToolType(tool.name),
            ...(tool.input !== undefined ? { input: tool.input } : {}),
            ...(preview ? { outputPreview: preview.text, truncated: preview.truncated || raw === undefined || raw === null } : {}),
            ...(status === "failed" ? { isError: true } : {})
          }
        }];
      }
      return [];
    }
    const result = agyRecord(frame.result);
    if (result?.stopReason !== undefined) {
      if (tools.size) throw failure("prompt ended with unfinished tool calls");
      const events: HarnessEventDraft[] = [];
      for (const [itemId, message] of messages) {
        if (message) events.push({ kind: "assistant.message", sourceType: "session/prompt", itemId, message });
      }
      messages.clear();
      terminal.clear();
      const usage = acpUsage(result.usage);
      if (usage) {
        events.push({
          kind: "usage",
          sourceType: "session/prompt",
          usage: {
            protocol: "responses",
            model: str(result.model) ?? "agy",
            inputTokens: usage.inputTokens ?? 0,
            cachedInputTokens: usage.cachedInputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
          }
        });
      }
      return events;
    }
    return [];
  };
}

export interface AgyAcpOptions {
  cwd: string;
  model: string;
  mcpRows: readonly AdapterMcpRow[];
  allowNativeTools: boolean;
  systemPromptAppend?: string;
}

/** Native ACP codec shared by ordinary and resident Antigravity CLI invocations. */
export function agyAcpCodec(options: AgyAcpOptions): ResidentProtocolCodec {
  let activeSession: string | undefined;
  let completed = false;
  async function rpc(connection: ResidentProtocolConnection, method: string, params: Record<string, unknown>) {
    const id = connection.requestId();
    await connection.send({ jsonrpc: "2.0", id, method, params });
    for (;;) {
      const frame = await connection.next(() => true, `Agy ${method}`);
      if (frame.id === id && frame.method === undefined) {
        const result = agyRecord(frame.result);
        if (frame.error != null || !result) {
          const errorRecord = agyRecord(frame.error);
          const errorMsg = str(errorRecord?.message);
          throw failure(errorMsg ? `${method} failed: ${errorMsg}` : `${method} failed`);
        }
        return result;
      }
      const update = updateFor(frame, activeSession);
      if (!update || frame.id !== undefined) throw failure(`unexpected frame during ${method}`);
      if (!metadataUpdates.has(String(update.sessionUpdate))) {
        throw failure(`business event during ${method}`);
      }
    }
  }
  return {
    protocol: "agy-acp-json-rpc",
    allocatesNativeSessionId: true,
    recoveryStrategy: "native-session-resume",
    observe(frame): ResidentProtocolObservation | undefined {
      const update = updateFor(frame, activeSession);
      if (update) {
        const type = update.sessionUpdate;
        if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
          return { activities: [{ kind: "model", phase: "delta" }] };
        }
        if (type === "tool_call" || type === "tool_call_update") {
          const callId = str(update.toolCallId);
          if (!callId) return undefined;
          const phase = isTerminalFailureStatus(update.status)
            ? "failed"
            : update.status === "completed"
              ? "completed"
              : type === "tool_call"
                ? "started"
                : "updated";
          const name = str(update.name) ?? str(update.title);
          return {
            activities: [{ kind: "tool", phase, callId, ...(name ? { name } : {}) }]
          };
        }
        return undefined;
      }
      const result = agyRecord(frame.result);
      const usage = result?.stopReason !== undefined ? acpUsage(result.usage) : undefined;
      return usage ? { usage } : undefined;
    },
    completionTail: {
      isComplete: () => completed,
      accept(frame, session) {
        const update = updateFor(frame, session.nativeId);
        return frame.id === undefined && !!update && metadataUpdates.has(String(update.sessionUpdate));
      }
    },
    initialize: (connection, session) => initializationDeadline(async () => {
      const info = await rpc(connection, "initialize", {
        protocolVersion: 1,
        clientInfo: { name: "scienceevolve-sdk", version: "0.1.1" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
      });
      const agentName = str(agyRecord(info.agentInfo)?.name);
      if (info.protocolVersion !== 1 || !agentName || !agentName.includes("Antigravity")) {
        throw failure("unsupported agent/protocol identity");
      }
      const params: Record<string, unknown> = {
        cwd: options.cwd,
        mcpServers: agyMcpServers(options.mcpRows),
        ...(options.systemPromptAppend
          ? { _meta: { antigravity: { systemPrompt: { append: options.systemPromptAppend } } } }
          : {})
      };
      let initialized = session;
      if (session.resumedAt) {
        const caps = agyRecord(info.agentCapabilities);
        const sessionCaps = agyRecord(caps?.sessionCapabilities ?? caps?.session_capabilities);
        if (!sessionCaps?.resume && caps?.loadSession !== true) {
          throw new SessionResumeError("agy", session.nativeId);
        }
        activeSession = session.nativeId;
        try {
          const resumed = await rpc(connection, "session/resume", { ...params, sessionId: activeSession });
          const returnedId = str(resumed.sessionId);
          if (returnedId && returnedId !== activeSession) {
            throw new Error(`resumed unexpected session identity ${returnedId}`);
          }
        } catch (cause) {
          throw new SessionResumeError("agy", session.nativeId, { cause: cause instanceof Error ? cause : undefined });
        }
      } else {
        const created = await rpc(connection, "session/new", params);
        const nativeId = str(created.sessionId);
        if (!nativeId || !validAgySessionId(nativeId)) {
          throw failure("invalid newly allocated session");
        }
        initialized = { ...session, nativeId };
        activeSession = nativeId;
      }
      await rpc(connection, "session/set_model", { sessionId: activeSession, modelId: options.model });
      return initialized;
    }),
    async settleIdle(connection, session) {
      await connection.consumeInitializationNotifications((frame) => {
        const update = updateFor(frame, session.nativeId);
        return frame.id === undefined && !!update && metadataUpdates.has(String(update.sessionUpdate));
      }, "Agy metadata");
    },
    async submit(connection, session, turn) {
      completed = false;
      if (session.nativeId !== activeSession) throw failure("session changed before prompt");
      const id = connection.requestId();
      await connection.send({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: {
          sessionId: session.nativeId,
          prompt: [{
            type: "text",
            text: turn.prompt.startsWith("/") ? `Research task:\n${turn.prompt}` : turn.prompt
          }]
        }
      });
      const messages = new Map<string, string>();
      for (;;) {
        const frame = await connection.next(() => true, "Agy prompt");
        if (frame.id === id && frame.method === undefined) {
          const result = agyRecord(frame.result);
          if (frame.error != null || result?.stopReason !== "end_turn") {
            const errorRecord = agyRecord(frame.error);
            const detail = str(errorRecord?.message) ?? str(result?.stopReason) ?? "unknown";
            throw failure(`prompt did not complete successfully (${detail})`);
          }
          await connection.notify(frame, turn);
          const handoff = [...messages.values()].at(-1)?.trim() || "Antigravity turn completed.";
          completed = true;
          return { handoff, threadId: session.nativeId };
        }
        if (frame.method === "session/request_permission" && frame.id !== undefined) {
          const params = agyRecord(frame.params);
          if (params?.sessionId !== session.nativeId) throw failure("foreign permission request");
          const choices = Array.isArray(params.options) ? params.options.map(agyRecord) : [];
          const desired = options.allowNativeTools
            ? ["allow_once", "allow_always"]
            : ["reject_once", "reject_always"];
          const choice = choices.find((option) => desired.includes(str(option?.kind) ?? ""));
          await connection.send({
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              outcome: choice?.optionId
                ? { outcome: "selected", optionId: choice.optionId }
                : { outcome: "cancelled" }
            }
          });
          continue;
        }
        if (frame.id !== undefined) {
          if (typeof frame.method === "string") {
            await connection.send({
              jsonrpc: "2.0",
              id: frame.id,
              error: { code: -32601, message: "Client capability not provided" }
            });
            continue;
          }
          throw failure("uncorrelated response");
        }
        const update = updateFor(frame, session.nativeId);
        if (!update) throw failure("unexpected protocol notification");
        if (update.sessionUpdate === "agent_message_chunk") {
          const key = str(update.messageId) ?? "reply";
          messages.set(key, (messages.get(key) ?? "") + contentText(update.content));
        }
        if (update.sessionUpdate === "user_message_chunk") throw failure("unsolicited user turn");
        await connection.notify(frame, turn);
      }
    },
    async close() { /* ACP lifetime is stdio EOF; ProcessHost owns process-tree cleanup. */ }
  };
}
