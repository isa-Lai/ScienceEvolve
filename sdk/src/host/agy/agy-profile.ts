import { promises as fs } from "node:fs";
import path from "node:path";

export interface AgyProfileLayout {
  profileHome: string;
  launchHome: string;
  geminiDir: string;
  appDataDir: string;
}

const PROFILE_MARKER_FILES = ["antigravity-oauth-token", "settings.json"] as const;

async function hasRegularProfileMarker(directory: string): Promise<boolean> {
  let found = false;
  for (const filename of PROFILE_MARKER_FILES) {
    const target = path.join(directory, filename);
    const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Native Agy profile ${filename} must be a regular non-symlink file`);
    }
    found = true;
  }
  return found;
}

/**
 * Validate a native Agy login profile directory without reading/copying tokens.
 * Accepts either an antigravity-cli directory (e.g. ~/.gemini/antigravity-cli
 * or a flat custom directory) or a home directory containing .gemini/antigravity-cli.
 */
export async function resolveAgyProfileLayout(profileHomeInput: string): Promise<AgyProfileLayout> {
  if (!path.isAbsolute(profileHomeInput)) {
    throw new Error("Native Agy profile path must be absolute");
  }
  const home = await fs.realpath(profileHomeInput);
  if (!(await fs.stat(home)).isDirectory()) {
    throw new Error("Native Agy profile home must be a directory");
  }
  if (await hasRegularProfileMarker(home)) {
    const parent = path.dirname(home);
    if (path.basename(parent) === ".gemini") {
      const parentInfo = await fs.lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
        throw new Error("Native Agy profile .gemini parent must be a regular directory");
      }
      return {
        profileHome: home,
        launchHome: path.dirname(parent),
        geminiDir: ".gemini",
        appDataDir: path.basename(home)
      };
    }
    return {
      profileHome: home,
      launchHome: path.dirname(home),
      geminiDir: ".",
      appDataDir: path.basename(home)
    };
  }
  const geminiRoot = path.join(home, ".gemini");
  const appDataRoot = path.join(geminiRoot, "antigravity-cli");
  const geminiInfo = await fs.lstat(geminiRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const appDataInfo = await fs.lstat(appDataRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (geminiInfo && (!geminiInfo.isDirectory() || geminiInfo.isSymbolicLink())) {
    throw new Error("Native Agy profile .gemini directory must be a regular directory");
  }
  if (appDataInfo && (!appDataInfo.isDirectory() || appDataInfo.isSymbolicLink())) {
    throw new Error("Native Agy profile antigravity-cli directory must be a regular directory");
  }
  if (geminiInfo && appDataInfo && await hasRegularProfileMarker(appDataRoot)) {
    return {
      profileHome: home,
      launchHome: home,
      geminiDir: ".gemini",
      appDataDir: "antigravity-cli"
    };
  }
  throw new Error("Native Agy profile requires a regular antigravity-oauth-token or settings.json");
}
