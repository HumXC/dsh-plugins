import { lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { workspacePath, workspaceRoot } from "./workspace-isolation.js";

export interface WorkspaceLease { release(): void }

// All graph processes hold this lease until their database handles are closed.
// Never steal a stale lock: a dead parent can leave a live database child.
export async function acquireWorkspaceLease(cwd: string, signal?: AbortSignal): Promise<WorkspaceLease> {
  const root = workspaceRoot(cwd);
  const storage = workspacePath(root, join(root, ".gitnexus"));
  if (storage !== join(root, ".gitnexus")) throw new Error("Unsafe GitNexus storage alias");
  mkdirSync(storage, { recursive: true });
  if (lstatSync(storage).isSymbolicLink()) throw new Error("Unsafe GitNexus storage symlink");
  const path = join(storage, "coordination.lock");
  const owner = join(path, "owner.json");
  const token = randomUUID();
  const deadline = Date.now() + 30_000;
  while (true) {
    signal?.throwIfAborted();
    try { mkdirSync(path, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Ownership is diagnostic only, never permission to remove another lease.
      try {
        const entry = lstatSync(path);
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Unsafe GitNexus coordination lock");
        if (lstatSync(owner).isSymbolicLink()) throw new Error("Unsafe GitNexus lock owner");
        const value = JSON.parse(readFileSync(owner, "utf8")) as { pid?: number; host?: string };
        if (!Number.isSafeInteger(value.pid) || !value.pid || value.pid < 1 || value.host !== hostname()) throw new Error("Unverifiable GitNexus lock owner; manual recovery required");
        try { process.kill(value.pid, 0); }
        catch { throw new Error("Stale GitNexus lock; verify all graph processes have exited before manual recovery"); }
      } catch (error) {
        // mkdir and owner publication are separate; an empty lock remains closed.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline) throw new Error("GitNexus workspace is busy or has an incomplete lock; retry or verify manual recovery");
      await delay(25, undefined, { signal });
    }
  }
  const pendingOwner = join(path, "owner.pending");
  try {
    writeFileSync(pendingOwner, JSON.stringify({ pid: process.pid, host: hostname(), token }), { flag: "wx", mode: 0o600 });
    renameSync(pendingOwner, owner);
  } catch (error) {
    throw new Error("GitNexus lock owner publication failed; manual recovery required", { cause: error });
  }
  const identity = lstatSync(path);
  let released = false;
  return { release() {
    if (released) return;
    const current = lstatSync(path);
    if (current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev || lstatSync(owner).isSymbolicLink() || JSON.parse(readFileSync(owner, "utf8")).token !== token) throw new Error("GitNexus lease ownership changed; refusing cleanup");
    unlinkSync(owner);
    rmdirSync(path);
    released = true;
  } };
}
