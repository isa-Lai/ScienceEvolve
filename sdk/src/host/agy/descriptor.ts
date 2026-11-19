import type { HarnessDescriptor } from "../../core/harness-runtime/contracts.js";
import { BUILTIN_HARNESS_DESCRIPTORS } from "../../core/harness-runtime/registry.js";

const codexCapabilities = BUILTIN_HARNESS_DESCRIPTORS.find((item) => item.id === "codex")!.capabilities;

/** SDK extension metadata for Antigravity CLI (agy) with native login profile auth. */
export const AGY_DESCRIPTOR: HarnessDescriptor = {
  schemaVersion: 1,
  id: "agy",
  label: "Antigravity CLI",
  adapterVersion: "1",
  nativeProtocol: "responses",
  purposes: ["workflow"],
  executableEnv: "SCIENCEEVOLVE_AGY_BIN",
  defaultCommand: "agy",
  notes: "Antigravity CLI (agy) ACP session/event adapter with native login profile",
  route: {
    requireMainControlTools: true,
    nativeProfileAuth: true
  },
  capabilities: {
    ...codexCapabilities,
    readOnlyExplainer: false,
    assistantStreaming: "native"
  }
};
