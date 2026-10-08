// Corpus paths are a plain tree. Check only components BELOW the supplied repo root:
// the root itself may legitimately be a symlink (worktree/clone mount). Never follow a
// symlink to an external, empty, or dangling directory before reading a touched item.
export async function plainCorpusPath(root, relative, leaf = "directory") {
  const raw = relative.split("/");
  // Documentation hrefs legitimately use ./#fragment for the same page. A dot
  // changes no path component; discard it, but never allow .. to escape the root.
  const parts = raw.filter((part) => part !== ".");
  if (
    !parts.length || raw.some((part) => !part || part === "..") ||
    !["directory", "file"].includes(leaf)
  ) return { state: "invalid", path: relative, reason: "invalid corpus-relative path" };

  let path = root;
  for (const [index, part] of parts.entries()) {
    path += `/${part}`;
    const component = parts.slice(0, index + 1).join("/");
    let stat;
    try {
      stat = await Deno.lstat(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return { state: "missing", path: component, reason: `missing component ${component}` };
      }
      return {
        state: "invalid",
        path: component,
        reason: `cannot lstat ${component}: ${err.message}`,
      };
    }
    if (stat.isSymlink) {
      return {
        state: "invalid",
        path: component,
        reason: `symlink component ${component} is not a plain corpus path`,
      };
    }
    const expected = index === parts.length - 1 ? leaf : "directory";
    if (expected === "directory" && !stat.isDirectory || expected === "file" && !stat.isFile) {
      return { state: "invalid", path: component, reason: `${component} is not a ${expected}` };
    }
  }
  return { state: "ok", path: relative };
}
