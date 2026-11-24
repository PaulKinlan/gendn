// sys.mjs: the file, process and subprocess helpers every gendn script uses, built on Node.
//
// The scripts and fixtures were written for Deno. When gendn moved to Node, their calls were
// rewritten to these helpers, which keep the same contracts the scripts were written and tested
// against, so the port changed no behaviour:
//   - fs calls throw errors.NotFound / errors.AlreadyExists (not raw ENOENT/EEXIST), so the many
//     `err instanceof errors.NotFound` branches keep working;
//   - readDir() yields { name, isFile, isDirectory, isSymlink } with booleans, not Dirent methods;
//   - remove() refuses a non-empty directory unless { recursive: true }, and a missing path throws;
//   - Command reports { code, success, signal } with code = 128 + signo for a signalled child and
//     Uint8Array stdout/stderr, and output() reads them only when "piped" (the default there).
//
// Use plain node: APIs in new code where they read as well. These helpers exist so the port is a
// mechanical rename rather than 1,300 hand-rewritten call sites.

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------
// errors

class NotFound extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "NotFound";
    this.code = "ENOENT";
  }
}
class AlreadyExists extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "AlreadyExists";
    this.code = "EEXIST";
  }
}
export const errors = { NotFound, AlreadyExists };

/** True for a missing-path error from these helpers or from node:fs directly. */
export function isNotFound(err) {
  return err instanceof NotFound || err?.code === "ENOENT";
}

function mapError(err) {
  if (err instanceof NotFound || err instanceof AlreadyExists) return err;
  if (err?.code === "ENOENT") return new NotFound(err.message, { cause: err });
  if (err?.code === "EEXIST") return new AlreadyExists(err.message, { cause: err });
  return err;
}
async function wrap(promise) {
  try {
    return await promise;
  } catch (err) {
    throw mapError(err);
  }
}
function wrapSync(fn) {
  try {
    return fn();
  } catch (err) {
    throw mapError(err);
  }
}

function toPath(p) {
  return p instanceof URL ? fileURLToPath(p) : p;
}

// ---------------------------------------------------------------------------------------------
// process

export const args = process.argv.slice(2);

/** `isMain(import.meta.url)`: true when this module is the script Node was asked to run. */
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

export const env = {
  get: (name) => process.env[name],
  set: (name, value) => {
    process.env[name] = String(value);
  },
  delete: (name) => {
    delete process.env[name];
  },
  has: (name) => Object.hasOwn(process.env, name),
  toObject: () => ({ ...process.env }),
};

// ---------------------------------------------------------------------------------------------
// files

function statInfo(s) {
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymlink: s.isSymbolicLink(),
    size: s.size,
    mtime: s.mtime,
    atime: s.atime,
    birthtime: s.birthtime,
    mode: s.mode,
    ino: s.ino,
    dev: s.dev,
    uid: s.uid,
    gid: s.gid,
  };
}
function entryInfo(d) {
  return {
    name: d.name,
    isFile: d.isFile(),
    isDirectory: d.isDirectory(),
    isSymlink: d.isSymbolicLink(),
  };
}

export const readTextFile = (p) => wrap(fsp.readFile(toPath(p), "utf8"));
export const readTextFileSync = (p) => wrapSync(() => fs.readFileSync(toPath(p), "utf8"));
export async function readFile(p) {
  const buf = await wrap(fsp.readFile(toPath(p)));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
export function readFileSync(p) {
  const buf = wrapSync(() => fs.readFileSync(toPath(p)));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function writeFlag(options) {
  if (options?.createNew) return "wx";
  if (options?.append) return "a";
  return "w";
}
async function writeAny(p, data, options) {
  const path = toPath(p);
  if (options?.create === false) await wrap(fsp.access(path)); // Deno: create:false needs it to exist
  await wrap(fsp.writeFile(path, data, { flag: writeFlag(options), mode: options?.mode }));
  if (options?.mode !== undefined) await wrap(fsp.chmod(path, options.mode));
}
export const writeTextFile = (p, text, options) => writeAny(p, text, options);
export const writeFile = (p, bytes, options) => writeAny(p, bytes, options);
export function writeTextFileSync(p, text, options) {
  wrapSync(() => fs.writeFileSync(toPath(p), text, { flag: writeFlag(options) }));
}

export const mkdir = (p, options) =>
  wrap(fsp.mkdir(toPath(p), { recursive: !!options?.recursive, mode: options?.mode })).then(
    () => undefined,
  );

export async function remove(p, options) {
  const path = toPath(p);
  const s = await wrap(fsp.lstat(path));
  if (s.isDirectory() && !options?.recursive) return wrap(fsp.rmdir(path));
  return wrap(fsp.rm(path, { recursive: !!options?.recursive }));
}
export function removeSync(p, options) {
  const path = toPath(p);
  const s = wrapSync(() => fs.lstatSync(path));
  if (s.isDirectory() && !options?.recursive) return wrapSync(() => fs.rmdirSync(path));
  return wrapSync(() => fs.rmSync(path, { recursive: !!options?.recursive }));
}

export const stat = async (p) => statInfo(await wrap(fsp.stat(toPath(p))));
export const lstat = async (p) => statInfo(await wrap(fsp.lstat(toPath(p))));
export const statSync = (p) => statInfo(wrapSync(() => fs.statSync(toPath(p))));
export const lstatSync = (p) => statInfo(wrapSync(() => fs.lstatSync(toPath(p))));

/** Async iterable of { name, isFile, isDirectory, isSymlink }, like the Deno API it replaces. */
export async function* readDir(p) {
  const entries = await wrap(fsp.readdir(toPath(p), { withFileTypes: true }));
  for (const d of entries) yield entryInfo(d);
}
export function readDirSync(p) {
  return wrapSync(() => fs.readdirSync(toPath(p), { withFileTypes: true })).map(entryInfo);
}

export const readLinkSync = (p) => wrapSync(() => fs.readlinkSync(toPath(p)));
export const readLink = (p) => wrap(fsp.readlink(toPath(p)));
export const realPath = (p) => wrap(fsp.realpath(toPath(p)));
export const symlink = (target, path, options) =>
  wrap(fsp.symlink(toPath(target), toPath(path), options?.type));
export const copyFile = (from, to) => wrap(fsp.copyFile(toPath(from), toPath(to)));
export const chmod = (p, mode) => wrap(fsp.chmod(toPath(p), mode));
export const rename = (from, to) => wrap(fsp.rename(toPath(from), toPath(to)));

export async function makeTempDir(options = {}) {
  const base = options.dir ?? tmpdir();
  const dir = await wrap(fsp.mkdtemp(join(base, options.prefix ?? "")));
  if (options.suffix) {
    const renamed = dir + options.suffix;
    await wrap(fsp.rename(dir, renamed));
    return renamed;
  }
  return dir;
}
export async function makeTempFile(options = {}) {
  const dir = await makeTempDir({ dir: options.dir, prefix: ".tmpfile-" });
  // Hoist the file out of its private directory so the returned path sits in `dir` like Deno's.
  const name = `${options.prefix ?? ""}${dir.slice(dir.lastIndexOf("-") + 1)}${
    options.suffix ?? ""
  }`;
  const file = join(options.dir ?? tmpdir(), name);
  await wrap(fsp.writeFile(file, "", { flag: "wx" }));
  await fsp.rmdir(dir);
  return file;
}

/** Minimal file handle for the two call sites that open a file and write or read through it. */
export async function open(p, options = {}) {
  const flags = options.createNew
    ? "wx"
    : options.append
    ? "a"
    : options.write
    ? (options.truncate || options.create ? "w" : "r+")
    : "r";
  const handle = await wrap(fsp.open(toPath(p), flags));
  return {
    rid: handle.fd,
    fd: handle.fd,
    handle,
    async write(bytes) {
      const { bytesWritten } = await handle.write(bytes);
      return bytesWritten;
    },
    async read(buffer) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      return bytesRead === 0 ? null : bytesRead;
    },
    close: () => handle.close(),
    get writable() {
      return Writable.toWeb(fs.createWriteStream("", { fd: handle.fd, autoClose: false }));
    },
  };
}
export function openSync(p, options = {}) {
  const flags = options.append ? "a" : options.write ? "w" : "r";
  const fd = wrapSync(() => fs.openSync(toPath(p), flags));
  return {
    rid: fd,
    fd,
    writeSync: (bytes) => fs.writeSync(fd, bytes),
    readSync: (buffer) => {
      const n = fs.readSync(fd, buffer);
      return n === 0 ? null : n;
    },
    close: () => fs.closeSync(fd),
  };
}

// ---------------------------------------------------------------------------------------------
// subprocesses

function signalNumber(name) {
  return osConstants.signals[name] ?? 0;
}
function statusOf(code, signal) {
  if (signal) return { success: false, code: 128 + signalNumber(signal), signal };
  return { success: code === 0, code: code ?? 1, signal: null };
}
function stdio(mode, fallback) {
  const m = mode ?? fallback;
  if (m === "piped") return "pipe";
  if (m === "null") return "ignore";
  return "inherit";
}
function spawnOptions(o, defaults) {
  const env = o.clearEnv ? { ...(o.env ?? {}) } : { ...process.env, ...(o.env ?? {}) };
  return {
    cwd: o.cwd ? toPath(o.cwd) : undefined,
    env,
    stdio: [
      stdio(o.stdin, defaults.stdin),
      stdio(o.stdout, defaults.stdout),
      stdio(o.stderr, defaults.stderr),
    ],
    detached: !!o.detached,
    signal: o.signal,
  };
}
function notPiped(name) {
  return () => {
    throw new TypeError(`Cannot get '${name}': '${name}' is not piped`);
  };
}
function outputResult(status, stdout, stderr, opts) {
  const result = { ...status };
  Object.defineProperty(result, "stdout", {
    enumerable: true,
    get: opts.stdoutPiped ? () => stdout : notPiped("stdout"),
  });
  Object.defineProperty(result, "stderr", {
    enumerable: true,
    get: opts.stderrPiped ? () => stderr : notPiped("stderr"),
  });
  return result;
}
function spawnError(cmd, err) {
  if (err?.code === "ENOENT") {
    return new NotFound(`Failed to spawn '${cmd}': No such file or directory`, { cause: err });
  }
  return err;
}

class ChildProcess {
  #child;
  #status;
  #modes;
  constructor(cmd, argv, options) {
    this.#modes = {
      stdin: options.stdin ?? "inherit",
      stdout: options.stdout ?? "inherit",
      stderr: options.stderr ?? "inherit",
    };
    const child = spawn(cmd, argv, spawnOptions(options, this.#modes));
    this.#child = child;
    let spawnFailure;
    child.once("error", (err) => {
      spawnFailure = err;
    });
    this.#status = new Promise((resolve, reject) => {
      child.once("close", (code, signal) => resolve(statusOf(code, signal)));
      child.once("error", (err) => {
        if (child.pid === undefined) reject(spawnError(cmd, err));
      });
    });
    if (child.pid === undefined && spawnFailure) throw spawnError(cmd, spawnFailure);
    this.stdout = child.stdout ? Readable.toWeb(child.stdout) : null;
    this.stderr = child.stderr ? Readable.toWeb(child.stderr) : null;
    this.stdin = child.stdin ? Writable.toWeb(child.stdin) : null;
  }
  get pid() {
    return this.#child.pid;
  }
  get status() {
    return this.#status;
  }
  /** The underlying node:child_process object, for code that needs Node-only features. */
  get node() {
    return this.#child;
  }
  kill(signal = "SIGTERM") {
    try {
      this.#child.kill(signal);
    } catch {
      // already gone
    }
  }
  ref() {
    this.#child.ref();
  }
  unref() {
    this.#child.unref();
    this.#child.stdout?.unref?.();
    this.#child.stderr?.unref?.();
  }
  async output() {
    const read = async (stream) => {
      if (!stream) return new Uint8Array();
      return new Uint8Array(await new Response(stream).arrayBuffer());
    };
    const [stdout, stderr, status] = await Promise.all([
      read(this.stdout),
      read(this.stderr),
      this.#status,
    ]);
    return outputResult(status, stdout, stderr, {
      stdoutPiped: this.#modes.stdout === "piped",
      stderrPiped: this.#modes.stderr === "piped",
    });
  }
}

/**
 * new Command(cmd, { args, cwd, env, clearEnv, stdin, stdout, stderr, signal, detached })
 *   .output()      -> Promise<{ code, success, signal, stdout, stderr }>  (stdout/stderr piped)
 *   .outputSync()  -> the same, synchronously
 *   .spawn()       -> { pid, status, stdout, stderr, stdin (web streams), kill(), output(), node }
 */
export class Command {
  #cmd;
  #options;
  constructor(cmd, options = {}) {
    this.#cmd = toPath(cmd);
    this.#options = options;
  }
  async output() {
    const o = this.#options;
    if (o.stdin === "piped") {
      throw new TypeError("Piped stdin is not supported for this function, use 'spawn()' instead");
    }
    const child = new ChildProcess(this.#cmd, o.args ?? [], {
      ...o,
      stdin: o.stdin ?? "null",
      stdout: o.stdout ?? "piped",
      stderr: o.stderr ?? "piped",
    });
    return await child.output();
  }
  outputSync() {
    const o = this.#options;
    const modes = {
      stdin: o.stdin ?? "null",
      stdout: o.stdout ?? "piped",
      stderr: o.stderr ?? "piped",
    };
    const r = spawnSync(this.#cmd, o.args ?? [], {
      ...spawnOptions(o, modes),
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (r.error) throw spawnError(this.#cmd, r.error);
    const bytes = (
      b,
    ) => (b ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array());
    return outputResult(statusOf(r.status, r.signal), bytes(r.stdout), bytes(r.stderr), {
      stdoutPiped: modes.stdout === "piped",
      stderrPiped: modes.stderr === "piped",
    });
  }
  spawn() {
    return new ChildProcess(this.#cmd, this.#options.args ?? [], this.#options);
  }
}

/** The Node binary running this script, for fixtures that re-run a script in a child process. */
export const execPath = () => process.execPath;

// ---------------------------------------------------------------------------------------------
// HTTP and TCP (test stubs)

/**
 * serve({ port, hostname, onListen }, handler): a fetch-style HTTP server on node:http, for test
 * stubs. Returns { addr: { hostname, port }, ready, finished, shutdown() }. `addr` is filled once
 * listening; await `ready` before reading it (the helpers that used the Deno API read it after an
 * await, so call sites do `await server.ready`).
 */
export function serve(options, handler) {
  if (typeof options === "function") [options, handler] = [{}, options];
  const addr = { hostname: options.hostname ?? "0.0.0.0", port: 0, transport: "tcp" };
  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        ...(hasBody ? { duplex: "half" } : {}),
      });
      const response = await handler(request, {
        remoteAddr: { hostname: req.socket.remoteAddress },
      });
      const out = {};
      response.headers.forEach((value, name) => {
        out[name] = name === "set-cookie" ? response.headers.getSetCookie() : value;
      });
      res.writeHead(response.status, response.statusText, out);
      if (req.method === "HEAD" || response.body === null) return res.end();
      for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err));
    }
  });
  let resolveFinished;
  const finished = new Promise((r) => (resolveFinished = r));
  server.on("close", () => resolveFinished());
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8000, options.hostname, () => {
      const a = server.address();
      addr.port = a.port;
      addr.hostname = a.address;
      options.onListen?.(addr);
      resolve(addr);
    });
  });
  options.signal?.addEventListener("abort", () => server.close());
  return {
    addr,
    ready,
    finished,
    node: server,
    async shutdown() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
    unref() {
      server.unref();
    },
  };
}

/** listen({ hostname, port }): a bare TCP listener that holds a port. Await `.ready`. */
export function listen(options) {
  const server = createNetServer((socket) => socket.destroy());
  const addr = { hostname: options.hostname ?? "0.0.0.0", port: 0, transport: "tcp" };
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname, () => {
      addr.port = server.address().port;
      resolve(addr);
    });
  });
  return { addr, ready, close: () => server.close() };
}

/**
 * connect({ hostname, port }): a TCP connection with read(buffer) -> bytes read or null at EOF,
 * write(bytes), and close(). `socket` is the underlying node:net Socket.
 */
export function connect(options) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: options.hostname ?? "127.0.0.1", port: options.port });
    const queue = [];
    let ended = false;
    let failure = null;
    let waiter = null;
    const wake = () => {
      const w = waiter;
      waiter = null;
      w?.();
    };
    socket.on("data", (chunk) => {
      queue.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      wake();
    });
    socket.on("end", () => {
      ended = true;
      wake();
    });
    socket.on("close", () => {
      ended = true;
      wake();
    });
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      socket.on("error", (err) => {
        failure = err;
        wake();
      });
      resolve({
        socket,
        async read(buffer) {
          while (queue.length === 0 && !ended && !failure) {
            await new Promise((r) => (waiter = r));
          }
          if (queue.length === 0) {
            if (failure) throw failure;
            return null;
          }
          const head = queue[0];
          const n = Math.min(head.length, buffer.length);
          buffer.set(head.subarray(0, n));
          if (n === head.length) queue.shift();
          else queue[0] = head.subarray(n);
          return n;
        },
        write(bytes) {
          return new Promise((r, j) =>
            socket.write(bytes, (err) => (err ? j(err) : r(bytes.length)))
          );
        },
        close() {
          socket.destroy();
        },
      });
    });
    socket.once("error", reject);
  });
}
