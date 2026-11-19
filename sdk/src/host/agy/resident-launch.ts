import path from "node:path";
import {
  launchPlan,
  residentMcpRows,
  type ResidentAdapterLaunchDefinition,
  type ResidentAdapterLaunchRequest
} from "../../core/harness-runtime/adapters/resident-adapter-factory.js";
import { harnessExecutableLaunch } from "../../core/harness-runtime/adapters/adapter-utils.js";
import { buildInvocationEnvironment } from "../../core/harness-runtime/process-host.js";
import { selectedSkillInstructions } from "../../core/harness-runtime/selected-skills.js";
import { agyAcpCodec } from "./agy-acp.js";
import { resolveAgyProfileLayout } from "./agy-profile.js";

/** Protocol-specific preparation for Antigravity CLI (agy) resident sessions. */
export async function buildAgyResidentLaunch(input: ResidentAdapterLaunchRequest): Promise<ResidentAdapterLaunchDefinition> {
  if (!("nativeAgyProfileHome" in input.launchRoute)) {
    throw new Error("Antigravity CLI (agy) requires a native Agy login profile route");
  }
  const { spec } = input;
  const layout = await resolveAgyProfileLayout(input.launchRoute.nativeAgyProfileHome);
  if (path.resolve(layout.launchHome) !== path.resolve(input.launchRoute.launchHome) ||
    layout.geminiDir !== input.launchRoute.geminiDir ||
    layout.appDataDir !== input.launchRoute.appDataDir) {
    throw new Error("Native Agy profile layout changed before launch");
  }
  const allowNativeTools = input.filesystemAuthority.rawTools !== "forbidden";
  const args = [
    "acp",
    "--stdio",
    "--include-default-customizations=false",
    "--gemini-dir", layout.geminiDir,
    "--app-data-dir", layout.appDataDir,
    "--dangerously-skip-permissions"
  ];
  const launch = harnessExecutableLaunch(input.executable, args);
  const environment = buildInvocationEnvironment({
    common: {
      ...(input.processBinding.commonEnvironment ?? {}),
      HOME: layout.launchHome
    }
  });
  return {
    plan: launchPlan(input, launch.command, launch.args, environment, []),
    codec: agyAcpCodec({
      cwd: spec.inputs.workspacePath,
      model: spec.model,
      mcpRows: await residentMcpRows(input),
      allowNativeTools,
      systemPromptAppend: selectedSkillInstructions([
        ...spec.policy.skillPaths,
        ...spec.policy.autoSkillPaths
      ])
    })
  };
}
