// A fast gate without an executable mutation proof can quietly stop checking types.
// Keep the production worktree clean: run the task in an isolated clone and introduce one
// deliberate server.ts type error there only.
import { runGit } from "./lib/bounded-git.mjs";

const root = new URL("..", import.meta.url).pathname;
const scratch = await Deno.makeTempDir({ prefix: "gendn-fast-typecheck-" });
const decoder = new TextDecoder();
async function git(...args) {
  const result = await runGit(args, { stdout: "piped", stderr: "piped" });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
async function checkFast() {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["task", "check:fast"],
    cwd: scratch,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: result.code, text: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
}
try {
  await git("clone", "--quiet", "--shared", root, scratch);
  const base = await git("-C", root, "rev-parse", "origin/main");
  await git("-C", scratch, "update-ref", "refs/remotes/origin/main", base);
  const healthy = await checkFast();
  if (healthy.code !== 0 || !healthy.text.includes("PASS — no published route")) {
    throw new Error(`healthy fast gate did not run route check: ${healthy.text}`);
  }
  await Deno.writeTextFile(
    `${scratch}/server.ts`,
    (await Deno.readTextFile(`${scratch}/server.ts`)) +
      '\nconst __fastTypeRegression: number = "not a number";\n',
  );
  const broken = await checkFast();
  if (
    broken.code === 0 || !broken.text.includes("TS2322") ||
    broken.text.includes("PASS — no published route")
  ) {
    throw new Error(`fast gate missed deliberate server.ts type error: ${broken.text}`);
  }
  console.log("fast typecheck fixture: healthy gate passes and TS2322 stops before route gate");
} finally {
  await Deno.remove(scratch, { recursive: true });
}
