import { HarnessRuntimeFacade, type HarnessRuntimeOptions } from "../core/harness-runtime/runtime.js";
import { harnessCatalogRegistry } from "../core/harness-runtime/registry.js";
import { AgyAdapter } from "./agy/agy-adapter.js";
import { AGY_DESCRIPTOR } from "./agy/descriptor.js";

/** SDK-only metadata for Antigravity CLI (agy) native login profile support. */
if (!harnessCatalogRegistry.has(AGY_DESCRIPTOR.id)) {
  harnessCatalogRegistry.register(new AgyAdapter());
} else if (JSON.stringify(harnessCatalogRegistry.descriptor(AGY_DESCRIPTOR.id)) !== JSON.stringify(AGY_DESCRIPTOR)) {
  throw new Error("SDK Agy catalog metadata conflicts with an existing registration");
}

export function createSdkHarnessRuntime(options: HarnessRuntimeOptions = {}): HarnessRuntimeFacade {
  return new HarnessRuntimeFacade({
    ...options,
    ...(!options.adapters ? {
      additionalAdapters: [new AgyAdapter(options), ...(options.additionalAdapters ?? [])]
    } : {})
  });
}
