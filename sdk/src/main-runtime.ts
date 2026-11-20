import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventHub } from "./core/event-hub.js";
import { ProjectStorage } from "./core/storage.js";
import { SkillCatalog } from "./core/skill-catalog.js";
import { GatewayStore, type GatewayStoreOptions, type GatewayInput } from "./core/agent-runtime.js";
import { HarnessRuntimeFacade, type HarnessRuntimeOptions } from "./core/harness-runtime/runtime.js";
import { createProductionHarnessRuntimeResidentAdapter } from "./core/harness-runtime/resident-runtime-adapter.js";
import { createProductionCollaborationResidentLauncher } from "./core/collaboration-resident-launcher.js";
import {
  CollaborationRuntimeCoordinator,
  ProductionCollaborationExecutionInputBuilder,
  ProductionCollaborationInvocationDispatcher,
  type CollaborationResidentLauncher,
  type CollaborationRuntimeOptions
} from "./core/collaboration-runtime.js";
import {
  createCollaborationGitFacade,
  type GitHubCredentialResolver
} from "./core/collaboration-git/index.js";
import { Orchestrator } from "./core/orchestrator.js";
import type { AgentRunner } from "./core/types.js";
import { trackMainResidents, trackResidentOpens } from "./main-resident-tracker.js";
import { MainSourceWorkspaceStore } from "./main-source-workspace.js";
import { MainProjectWorkspaceStore } from "./main-project-workspace.js";
import { MainGitWorkspaceStore } from "./main-git-workspace.js";
import { MainNativeAgyProfiles, MainNativeCodexProfiles } from "./main-native-profiles.js";
import { SiiExperimentService } from "./core/sii-experiments.js";
import type { MainResearchSdkOptions } from "./main-options.js";
import { createSdkHarnessRuntime } from "./host/harness-adapters.js";

const sourceManifest = JSON.parse(await fs.readFile(new URL("../resources/main-runtime/manifest.json", import.meta.url), "utf8"));
if (!/^[a-f0-9]{40}$/.test(sourceManifest.sourceCommit) || typeof sourceManifest.runtimeRevision !== "string") {
  throw new Error("Unsupported main-runtime source manifest");
}
/** Git base; MAIN_RUNTIME_REVISION also identifies the captured working-tree source. */
export const MAIN_RUNTIME_SOURCE_COMMIT: string = sourceManifest.sourceCommit;
/** Includes the exact core/schema bytes and declared shared fixes, not only the upstream base commit. */
export const MAIN_RUNTIME_REVISION: string = sourceManifest.runtimeRevision;
export const MAIN_RUNTIME_MARKER = ".scienceevolve-main-runtime.json";
const builtinSkillRoot = fileURLToPath(new URL("../assets/skills/", import.meta.url));

/** Internal, same-version host backing the main/default API and CLI. */
export interface MainApplicationRuntimeOptions {
  /** Use a dedicated absolute directory, not a legacy SDK/Web data directory. */
  dataDir: string;
  skillRoots?: string[];
  userSkillRoot?: string;
  nativeCodexProfiles?: Record<string, string>;
  nativeAgyProfiles?: Record<string, string>;
  /** Explicit opt-in; this host owns the service lifecycle. */
  sii?: MainResearchSdkOptions["sii"];
  runnerOptions?: HarnessRuntimeOptions;
  gatewayOptions?: GatewayStoreOptions;
  initialGateway?: GatewayInput;
  execution?: ConstructorParameters<typeof Orchestrator>[3];
  /** Internal migration mode: load and repair state without scheduling projects. */
  deferAutomaticRecovery?: boolean;
  /** Internal migration mode: replace profile aliases in the copied destination only. */
  migrationProfileRebind?: boolean;
  /** Inject credentials in memory. Never store tokens in workflow.json. */
  git?: {
    credentialResolver: GitHubCredentialResolver;
    expectedIdentity?: { id: number; login: string };
  };
  /** Internal contract-test seam; custom runners must provide a trusted resident launcher. */
  internal?: {
    runner: AgentRunner;
    residentLauncher: CollaborationResidentLauncher;
    /** Trusted deterministic provider/local-Git seam, never part of the public SDK options. */
    gitFactory?: CollaborationRuntimeOptions["gitFactory"];
  };
}

async function requireDedicatedDirectory(root: string) {
  const markerPath = path.join(root, MAIN_RUNTIME_MARKER);
  let markerStat;
  try { markerStat = await fs.lstat(markerPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (markerStat) {
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("Invalid main-runtime directory marker");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    if (marker.schemaVersion !== 1 || marker.engine !== "main-runtime" || typeof marker.sourceCommit !== "string") {
      throw new Error("Unsupported runtime directory format");
    }
    if (marker.sourceCommit !== MAIN_RUNTIME_SOURCE_COMMIT || marker.runtimeRevision !== MAIN_RUNTIME_REVISION) {
      throw new Error("Runtime data belongs to another main revision; an explicit migration is required");
    }
    return false;
  }
  const entries = (await fs.readdir(root)).filter((name) => name !== ".scienceevolve-runtime.lock");
  if (entries.length) throw new Error("Main runtime requires an empty dedicated data directory. Existing SDK/Web data and source repositories are not migrated or modified automatically.");
  await fs.writeFile(markerPath, JSON.stringify({ schemaVersion: 1, engine: "main-runtime", sourceCommit: MAIN_RUNTIME_SOURCE_COMMIT,
    runtimeRevision: MAIN_RUNTIME_REVISION }) + "\n", { flag: "wx", mode: 0o600 });
  return true;
}

/** Compose main's actual runtime without HTTP, Web OAuth, global signal handlers or a main checkout. */
export async function createMainApplicationRuntime(options: MainApplicationRuntimeOptions) {
  if (!path.isAbsolute(options.dataDir)) throw new Error("dataDir must be an absolute, dedicated directory");
  if (options.sii && options.runnerOptions?.siiExperiments) {
    throw new Error("Choose host-owned sii options or a caller-owned siiExperiments service, not both");
  }
  const root = path.resolve(options.dataDir);
  // Pin the resolver/expected identity for this host; callers may rotate a
  // token inside the resolver, but mutating the options object cannot swap
  // the credential route underneath an already running project.
  const git = options.git ? {
    credentialResolver: options.git.credentialResolver,
    ...(options.git.expectedIdentity ? { expectedIdentity: { ...options.git.expectedIdentity } } : {})
  } : undefined;
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, ".scienceevolve-runtime.lock");
  const lock = await fs.open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Data directory is in use (or has a stale .scienceevolve-runtime.lock). Confirm the owner has stopped before operator recovery.");
    throw error;
  });
  const release = async () => { await lock.close(); await fs.unlink(lockPath); };
  let engine: Orchestrator | undefined;
  let residents: ReturnType<typeof trackMainResidents> | undefined;
  let collaborationRuntime: CollaborationRuntimeCoordinator | undefined;
  let unsubscribeDelivery: (() => void) | undefined;
  let deliverySweep: ReturnType<typeof setInterval> | undefined;
  let siiExperiments: SiiExperimentService | undefined;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, engine: "main-runtime", startedAt: new Date().toISOString() }));
    const fresh = await requireDedicatedDirectory(root);
    const nativeProfiles = new MainNativeCodexProfiles();
    await nativeProfiles.initialize(root, options.nativeCodexProfiles, fresh, options.migrationProfileRebind === true);
    const nativeAgyProfiles = new MainNativeAgyProfiles();
    await nativeAgyProfiles.initialize(root, options.nativeAgyProfiles, fresh, options.migrationProfileRebind === true);
    const sourceWorkspaces = new MainSourceWorkspaceStore(root);
    await sourceWorkspaces.initialize(fresh);
    const projectWorkspaces = new MainProjectWorkspaceStore(root);
    await projectWorkspaces.initialize();
    const gitWorkspaces = new MainGitWorkspaceStore(root, sourceWorkspaces);
    await gitWorkspaces.initialize();
    const eventHub = new EventHub();
    const storage = new ProjectStorage(root, eventHub, {
      workspaceResolver: (id) => projectWorkspaces.resolve(id)
    });
    await storage.initialize();
    if (options.sii) {
      siiExperiments = new SiiExperimentService({
        ...options.sii,
        noProxy: options.sii.noProxy ? [...options.sii.noProxy] : undefined,
        projectsRoot: storage.projectsDir(),
        knowledgeRoot: options.sii.knowledgeRoot ?? path.join(builtinSkillRoot, "general", "inspire"),
        resolveProjectWorkspace: (id) => projectWorkspaces.resolve(id)
      });
    }
    const gatewayStore = new GatewayStore(root, options.gatewayOptions);
    if (options.initialGateway) await gatewayStore.seedBuiltin(options.initialGateway);
    const skills = new SkillCatalog(options.skillRoots ?? [builtinSkillRoot], options.userSkillRoot ?? path.join(root, "skills"));
    const facade = options.internal ? undefined : createSdkHarnessRuntime({
      ...options.runnerOptions,
      // Let transport recovery settle before either outer model watchdog expires.
      protocolProxyTimeoutMs: Math.floor(Math.min(options.runnerOptions?.protocolProxyTimeoutMs ?? 20 * 60_000,
        options.execution?.agentActivityIdleWindowMs ?? 20 * 60_000,
        options.runnerOptions?.residentModelInactivityTimeoutMs ?? 20 * 60_000) * 0.9),
      ...(siiExperiments ? { siiExperiments,
        // Async SII uses direct execFile in its service. Do not activate the
        // legacy shell wrapper, whose root guard rejects bound SDK workspaces.
        inspireBin: undefined,
        inspireConfigPath: options.sii!.configPath,
        inspireNoProxy: options.sii!.noProxy ? [...options.sii!.noProxy] : undefined,
        inspireWorkspaceRoot: options.sii!.workspaceRoot
      } : {}),
      resolveNativeCodexProfile: (id) => nativeProfiles.resolve(id),
      resolveNativeAgyProfile: (id) => nativeAgyProfiles.resolve(id),
      resolveProjectWorkspace: (id) => projectWorkspaces.resolve(id),
      validateGatewayTarget: (url) => gatewayStore.assertAllowedNetworkTarget(url)
    });
    const runner = options.internal?.runner ?? facade!;
    if (facade) gatewayStore.setAdapterSmokeProbe(facade);
    const nativeResidents = facade ? trackResidentOpens(createProductionHarnessRuntimeResidentAdapter(facade)) : undefined;
    const launcherResidents = trackMainResidents(options.internal?.residentLauncher ?? createProductionCollaborationResidentLauncher(
      facade!, nativeResidents!.launcher
    ));
    residents = { launcher: launcherResidents.launcher, async stopRemaining() {
      await launcherResidents.stopRemaining();
      await nativeResidents?.stopRemaining();
    } };
    collaborationRuntime = new CollaborationRuntimeCoordinator({
      storage,
      // Both HTTPS Git transport and provider API use the same resolver.
      gitFactory: (binding) => {
        const hostBinding = { ...binding, initialTree: (input: { repositoryPath: string; signal?: AbortSignal }) => sourceWorkspaces.initialTree(binding.projectId, input) };
        if (options.internal?.gitFactory) return options.internal.gitFactory(hostBinding);
        return createCollaborationGitFacade({ ...hostBinding,
          ...(git ? { credentialResolver: git.credentialResolver } : {}),
          ...(git?.expectedIdentity ? { expectedIdentity: git.expectedIdentity } : {}) });
      },
      executionInputBuilder: new ProductionCollaborationExecutionInputBuilder(storage, skills),
      invocationDispatcher: new ProductionCollaborationInvocationDispatcher(storage),
      residentLauncher: residents.launcher,
      validateWorkflowConfiguration: (state, proposal) => engine!.prepareWorkflowConfiguration(state, proposal)
    });
    // Match main's bootstrap: formal state must exist before SII can import
    // its ledger or publish experiment outcomes. Never start its monitor on
    // the obsolete file-only state store.
    await collaborationRuntime.initialize();
    (siiExperiments ?? options.runnerOptions?.siiExperiments)?.configureDocumentStore(collaborationRuntime.projectStateDocuments());
    engine = new Orchestrator(storage, skills, runner, {
      retryBaseMs: 2_000, retryMaxMs: 60_000, ...options.execution,
      ...(options.deferAutomaticRecovery ? { deferAutomaticRecovery: true } : {})
    }, gatewayStore, collaborationRuntime, undefined, {
      beforePersist: async ({ projectId }) => { await sourceWorkspaces.bindDefault(projectId); },
      validateNativeCodexProfile: async (config) => { await nativeProfiles.resolve(config.nativeCodexProfileId!); },
      validateNativeAgyProfile: async (config) => { await nativeAgyProfiles.resolve(config.nativeAgyProfileId!); }
    });
    await engine.initialize();
    await siiExperiments?.start();
    const orchestrator = engine;
    const deliveryNotifications = new Map<string, Promise<void>>();
    const reconcileDelivery = (id: string) => {
      if (deliveryNotifications.has(id)) return;
      const notification = orchestrator.getProject(id).then(async state => {
        if (state) await gitWorkspaces.synchronize(state);
      }).catch(() => {});
      deliveryNotifications.set(id, notification);
      void notification.finally(() => deliveryNotifications.delete(id));
    };
    unsubscribeDelivery = eventHub.subscribeAll((event) => {
      const sourceType = event.data?.sourceType;
      // Git-on uses committed scoped/node completion facts, not the old
      // Git-off project.completed event. No API polling is required to deliver.
      if (!gitWorkspaces.receipt(event.projectId) || (event.type !== "project.completed" &&
          !(typeof sourceType === "string" && sourceType.endsWith(".completed")))) return;
      // Event listeners must never throw into the main invocation transaction.
      reconcileDelivery(event.projectId);
    });
    // Scoped facts can be published before the coordinator refreshes its
    // terminal projection. Reconcile pending host deliveries independently
    // of public wait/snapshot calls; never overlap reads for a project.
    deliverySweep = setInterval(() => {
      for (const id of gitWorkspaces.ids()) {
        if (["pending", "applying"].includes(gitWorkspaces.receipt(id)!.status)) reconcileDelivery(id);
      }
    }, 250);
    deliverySweep.unref();
    for (const id of gitWorkspaces.ids()) {
      const state = await orchestrator.getProject(id);
      if (state) await gitWorkspaces.synchronize(state);
    }
    const trackedResidents = residents;
    let closing: Promise<void> | undefined;
    let closed = false;
    return {
      sourceCommit: MAIN_RUNTIME_SOURCE_COMMIT,
      runtimeRevision: MAIN_RUNTIME_REVISION,
      eventHub, storage, gatewayStore, skills, runner, orchestrator, collaborationRuntime, sourceWorkspaces, projectWorkspaces, gitWorkspaces,
      close(): Promise<void> {
        if (closed) return Promise.resolve();
        if (closing) return closing;
        closing = (async () => {
          clearInterval(deliverySweep);
          try {
            await gatewayStore.close();
            await orchestrator.shutdown();
            await trackedResidents.stopRemaining();
          } finally { await siiExperiments?.stop(); }
          unsubscribeDelivery?.();
          await Promise.all(deliveryNotifications.values());
          await gitWorkspaces.flush();
          await release();
          closed = true;
        })().finally(() => { closing = undefined; });
        return closing;
      }
    };
  } catch (error) {
    clearInterval(deliverySweep);
    unsubscribeDelivery?.();
    try {
      try {
        if (engine) await engine.shutdown();
        else await collaborationRuntime?.shutdown();
        await residents?.stopRemaining();
      } finally { await siiExperiments?.stop(); }
    } catch (stopError) {
      throw new AggregateError([error, stopError], "Runtime initialization failed and Stop was not confirmed; directory remains locked");
    }
    await release();
    throw error;
  }
}

const SUPPORTED_MIGRATION_SOURCES = [
  { sourceCommit: "61d257921a5c98903d305941e450b27e6a757af1", runtimeRevision: "61d257921a5c98903d305941e450b27e6a757af1+5b16d1f83fc9c54a" },
  // Current installed releases can be copied too, which supports Agy -> Codex as well as Codex -> Agy.
  { sourceCommit: "1385b7c85ae920746d45b7ffac715764b3e3a503", runtimeRevision: "1385b7c85ae920746d45b7ffac715764b3e3a503+1f5c7e8b50d2f552" },
  { sourceCommit: MAIN_RUNTIME_SOURCE_COMMIT, runtimeRevision: MAIN_RUNTIME_REVISION }
] as const;

async function migrationTreeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, relative = "") => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Migration data contains a symbolic link: ${name}`);
      if (entry.isDirectory()) { hash.update(`dir\0${name}\0`); await visit(full, name); }
      else if (entry.isFile()) { hash.update(`file\0${name}\0`); hash.update(await fs.readFile(full)); }
      else throw new Error(`Migration data contains an unsupported filesystem entry: ${name}`);
    }
  };
  await visit(root);
  return hash.digest("hex");
}

/** Copy one explicitly supported older runtime, persist model/Harness choices, and leave scheduling deferred. */
export async function migrateMainRuntimeData(input: {
  sourceDataDir: string;
  destinationDataDir: string;
  model: string;
  harness?: "codex" | "agy";
  nativeProfileId?: string;
  runtime?: Omit<MainApplicationRuntimeOptions, "dataDir" | "deferAutomaticRecovery" | "migrationProfileRebind">;
}): Promise<{ destinationDataDir: string; runtimeRevision: string; projects: number; agents: number; model: string; harness?: "codex" | "agy" }> {
  const source = path.resolve(input.sourceDataDir), destination = path.resolve(input.destinationDataDir);
  if (!path.isAbsolute(input.sourceDataDir) || !path.isAbsolute(input.destinationDataDir)) throw new Error("Migration source and destination must be absolute paths");
  if (source === destination || source.startsWith(`${destination}${path.sep}`) || destination.startsWith(`${source}${path.sep}`)) {
    throw new Error("Migration source and destination must be separate, non-nested directories");
  }
  const model = input.model.trim();
  if (!model || model.length > 200) throw new Error("Migration model must be nonempty and at most 200 characters");
  if (input.harness && !["codex", "agy"].includes(input.harness)) throw new Error("Migration harness must be codex or agy");
  if (input.harness && (!input.nativeProfileId || !/^[A-Za-z0-9_-]{1,80}$/.test(input.nativeProfileId)))
    throw new Error("A native profile ID is required when changing the migration harness");
  if (!input.harness && input.nativeProfileId !== undefined) throw new Error("A native profile ID requires --harness");
  const lockPath = path.join(source, ".scienceevolve-runtime.lock");
  const assertSourceUnlocked = async () => {
    try { await fs.access(lockPath); throw new Error("Migration source has a runtime lock; confirm its owner has stopped before migration"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  await assertSourceUnlocked();
  const markerPath = path.join(source, MAIN_RUNTIME_MARKER);
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  if (marker.schemaVersion !== 1 || marker.engine !== "main-runtime" ||
      !SUPPORTED_MIGRATION_SOURCES.some((supported) => marker.sourceCommit === supported.sourceCommit && marker.runtimeRevision === supported.runtimeRevision)) {
    throw new Error("Migration source runtime revision is not in the explicitly supported migration set");
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try { await fs.lstat(destination); throw new Error("Migration destination already exists; choose a new directory"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let migrationRuntime: Awaited<ReturnType<typeof createMainApplicationRuntime>> | undefined;
  try {
    await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    const [sourceDigest, copiedDigest] = await Promise.all([migrationTreeDigest(source), migrationTreeDigest(destination)]);
    if (sourceDigest !== copiedDigest) throw new Error("Copied migration data does not match its source");
    await assertSourceUnlocked();
    const copiedMarker = { ...marker, sourceCommit: MAIN_RUNTIME_SOURCE_COMMIT, runtimeRevision: MAIN_RUNTIME_REVISION };
    await fs.writeFile(path.join(destination, MAIN_RUNTIME_MARKER), `${JSON.stringify(copiedMarker)}\n`, { flag: "w", mode: 0o600 });
    const stateSourcePath = path.join(destination, "project-state-source.json");
    try {
      const stateSource = JSON.parse(await fs.readFile(stateSourcePath, "utf8"));
      if (stateSource.protocol !== "project-state-v1" || stateSource.kind !== "sqlite" ||
          typeof stateSource.databasePath !== "string" || !path.isAbsolute(stateSource.databasePath)) {
        throw new Error("Migration source formal state pointer does not match its database");
      }
      const referencedDatabase = path.resolve(stateSource.databasePath);
      const sourceDatabase = path.join(source, "collaboration-state.sqlite");
      if (referencedDatabase !== sourceDatabase) {
        const [referencedDigest, copiedDigest] = await Promise.all([
          fs.readFile(referencedDatabase).then((bytes) => createHash("sha256").update(bytes).digest("hex")),
          fs.readFile(sourceDatabase).then((bytes) => createHash("sha256").update(bytes).digest("hex"))
        ]);
        if (referencedDigest !== copiedDigest) throw new Error("Migration source formal state pointer resolves to different database contents");
      }
      stateSource.databasePath = path.join(destination, "collaboration-state.sqlite");
      await fs.writeFile(stateSourcePath, `${JSON.stringify(stateSource, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    migrationRuntime = await createMainApplicationRuntime({ ...input.runtime, dataDir: destination,
      deferAutomaticRecovery: true, migrationProfileRebind: Boolean(input.harness) });
    const states = await migrationRuntime.storage.listStates();
    let agents = 0;
    for (const state of states) {
      if (["completed", "cancelled"].includes(state.status) || state.archivedAt) continue;
      agents += state.orchestration.agents.filter(({ name }) => state.agents[name]).length;
      await migrationRuntime.orchestrator.migrateAgentModels(state.id, model,
        input.harness ? { harness: input.harness, nativeProfileId: input.nativeProfileId! } : undefined);
    }
    await migrationRuntime.close();
    migrationRuntime = undefined;
    await assertSourceUnlocked();
    if (await migrationTreeDigest(source) !== sourceDigest) throw new Error("Migration source changed while migration was in progress");
    return { destinationDataDir: destination, runtimeRevision: MAIN_RUNTIME_REVISION, projects: states.filter((state) => !["completed", "cancelled"].includes(state.status) && !state.archivedAt).length, agents, model,
      ...(input.harness ? { harness: input.harness } : {}) };
  } catch (error) {
    if (migrationRuntime) await migrationRuntime.close();
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export type MainApplicationRuntime = Awaited<ReturnType<typeof createMainApplicationRuntime>>;
