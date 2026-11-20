import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResolvedNativeAgyProfileLayout } from "./core/harness-runtime/gateway-route.js";
import { resolveAgyProfileLayout } from "./host/agy/agy-profile.js";

async function persistNativeProfileRegistry<T>(
  dataDir: string,
  fileName: string,
  configured: Record<string, string>,
  fresh: boolean,
  label: string,
  normalize: (id: string, input: string) => Promise<T>,
  serialize: (value: T) => string = (value) => String(value),
  allowMigrationRebind = false
): Promise<Readonly<Record<string, T>>> {
  const entries: Record<string, T> = {};
  const persisted: Record<string, string> = {};
  for (const [id, input] of Object.entries(configured).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !path.isAbsolute(input)) throw new Error(`Invalid native ${label} profile declaration`);
    const resolved = await normalize(id, input);
    entries[id] = resolved;
    persisted[id] = serialize(resolved);
  }
  const file = path.join(dataDir, fileName);
  if (fresh) await fs.writeFile(file, JSON.stringify(persisted) + "\n", { flag: "wx", mode: 0o600 });
  else {
    // Previous migration previews did not have native routes. A missing registry
    // can only reopen with no profiles; enabling it requires a new data directory.
    const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && (Object.keys(persisted).length === 0 || allowMigrationRebind)) return undefined;
      throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 256_000)) throw new Error("Native profile registry is not a bounded regular private file");
    const existing = info ? await fs.readFile(file, "utf8") : "{}";
    if (JSON.stringify(JSON.parse(existing)) !== JSON.stringify(persisted)) {
      if (!allowMigrationRebind) throw new Error(`Native ${label} profile bindings changed; reopen with the original deployment configuration`);
      await fs.writeFile(file, JSON.stringify(persisted) + "\n", { mode: 0o600 });
    }
  }
  return Object.freeze(entries);
}

/** Explicit deployment authority. No reading/copying auth.json and no native config writes. */
export class MainNativeCodexProfiles {
  #homes: Readonly<Record<string, string>> = {};
  async initialize(dataDir: string, configured: Record<string, string> = {}, fresh: boolean, allowMigrationRebind = false) {
    this.#homes = await persistNativeProfileRegistry(
      dataDir,
      ".scienceevolve-native-codex-profiles.json",
      configured,
      fresh,
      "Codex",
      async (_id, input) => {
        const home = await fs.realpath(input);
        if (!(await fs.stat(home)).isDirectory()) throw new Error("Native Codex profile home must be a directory");
        const config = await fs.lstat(path.join(home, "config.toml"));
        if (!config.isFile() || config.isSymbolicLink()) throw new Error("Native Codex profile requires a regular config.toml");
        return home;
      }, (value) => String(value), allowMigrationRebind
    );
  }
  async resolve(id: string): Promise<string> {
    const home = this.#homes[id];
    if (!home) throw new Error(`Unknown native Codex profile: ${id}`);
    if (await fs.realpath(home) !== home || !(await fs.stat(home)).isDirectory()) throw new Error("Native Codex profile authority changed on disk");
    return home;
  }
}

/** Explicit Antigravity CLI deployment authority. Verifies login profile layout without reading tokens. */
export class MainNativeAgyProfiles {
  #layouts: Readonly<Record<string, ResolvedNativeAgyProfileLayout>> = {};
  async initialize(dataDir: string, configured: Record<string, string> = {}, fresh: boolean, allowMigrationRebind = false) {
    this.#layouts = await persistNativeProfileRegistry(
      dataDir,
      ".scienceevolve-native-agy-profiles.json",
      configured,
      fresh,
      "agy",
      async (_id, input) => await resolveAgyProfileLayout(input),
      (layout) => layout.profileHome,
      allowMigrationRebind
    );
  }
  async resolve(id: string): Promise<ResolvedNativeAgyProfileLayout> {
    const layout = this.#layouts[id];
    if (!layout) throw new Error(`Unknown native agy profile: ${id}`);
    const current = await resolveAgyProfileLayout(layout.profileHome);
    if (
      current.profileHome !== layout.profileHome ||
      current.launchHome !== layout.launchHome ||
      current.geminiDir !== layout.geminiDir ||
      current.appDataDir !== layout.appDataDir
    ) {
      throw new Error("Native agy profile authority changed on disk");
    }
    return layout;
  }
}
