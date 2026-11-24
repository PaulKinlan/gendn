// Runtime-neutral read-only view of the site's files (gendn moving off Deno, 2026-11).
//
// The server used to call Deno.readFile / Deno.readDir / Deno.stat directly, which tied it to the
// Deno runtime and to a real filesystem. Deno Deploy shuts down in April 2027 and Cloudflare
// Workers has no filesystem, so every read goes through this interface instead:
//
//   - nodeSiteFS()    reads the working tree with node:fs (Node, and Deno via its node: layer).
//                     Used by local dev (`npm run dev`) and by every test that imports server.ts.
//   - the Worker entry (worker.ts) installs an implementation backed by the static-assets binding
//     plus a build-time file index (scripts/build-worker-assets.mjs), because Workers cannot list
//     or stat files at runtime.
//
// Paths are repo-relative with no leading "./" or "/" (e.g. "v149/webmcp/index.html").

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface SiteFS {
  /** File bytes, or null when the file does not exist. */
  readFile(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Directory entries, or [] when the directory does not exist. */
  readDir(path: string): Promise<DirEntry[]>;
  /** Whether a regular file exists at the path (cheaper than readFile where the runtime allows). */
  exists(path: string): Promise<boolean>;
}

export function normalizeSitePath(path: string): string {
  const rel = path.replace(/^\.\//, "").replace(/^\/+/, "");
  return rel === "." ? "" : rel;
}

export async function readSiteText(fs: SiteFS, path: string): Promise<string | null> {
  const bytes = await fs.readFile(path);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

export function nodeSiteFS(root = "."): SiteFS {
  const join = (path: string) => {
    const rel = normalizeSitePath(path);
    return rel ? `${root}/${rel}` : root;
  };
  return {
    async readFile(path) {
      const { readFile } = await import("node:fs/promises");
      try {
        return new Uint8Array(await readFile(join(path)));
      } catch {
        return null;
      }
    },
    async readDir(path) {
      const { readdir } = await import("node:fs/promises");
      try {
        const entries = await readdir(join(path), { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
      } catch {
        return [];
      }
    },
    async exists(path) {
      const { stat } = await import("node:fs/promises");
      try {
        return (await stat(join(path))).isFile();
      } catch {
        return false;
      }
    },
  };
}

/**
 * A SiteFS over a precomputed list of repo-relative file paths, reading bytes with `fetchBytes`.
 * The Worker builds one from the static-assets binding; tests can build one from a fixture map.
 */
export function indexedSiteFS(
  files: readonly string[],
  fetchBytes: (path: string) => Promise<Uint8Array<ArrayBuffer> | null>,
): SiteFS {
  const fileSet = new Set(files.map(normalizeSitePath));
  const dirs = new Map<string, Map<string, boolean>>();
  for (const file of fileSet) {
    const parts = file.split("/");
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      const isDirectory = i < parts.length - 1;
      if (!dirs.has(parent)) dirs.set(parent, new Map());
      const children = dirs.get(parent)!;
      children.set(parts[i], (children.get(parts[i]) ?? false) || isDirectory);
    }
  }
  return {
    readFile(path) {
      const rel = normalizeSitePath(path);
      return fileSet.has(rel) ? fetchBytes(rel) : Promise.resolve(null);
    },
    readDir(path) {
      const rel = normalizeSitePath(path).replace(/\/+$/, "");
      const children = dirs.get(rel);
      return Promise.resolve(
        children ? [...children].map(([name, isDirectory]) => ({ name, isDirectory })) : [],
      );
    },
    exists(path) {
      return Promise.resolve(fileSet.has(normalizeSitePath(path)));
    },
  };
}

let current: SiteFS = nodeSiteFS();

/** The filesystem the server reads from. Defaults to the working tree via node:fs. */
export function siteFS(): SiteFS {
  return current;
}

/** Swap the implementation (the Worker entry does this once per isolate). */
export function setSiteFS(fs: SiteFS): void {
  current = fs;
}
