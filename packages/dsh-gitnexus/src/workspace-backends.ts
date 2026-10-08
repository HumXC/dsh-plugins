import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { workspacePath } from "./workspace-isolation.js";

function paths(root: string) {
  const directory = join(root, ".gitnexus", "backends");
  if (workspacePath(root, directory) !== directory) throw new Error("Unsafe GitNexus backend directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Unsafe GitNexus backend directory");
  return { directory, marker: join(directory, "drain") };
}

/** Called only while holding the operation lease. Watchers can only close their own backend. */
export function registerWorkspaceBackend(root: string, close: () => Promise<void>, diagnostic: (error: unknown) => void): () => void {
  const { directory, marker } = paths(root);
  const registration = join(directory, randomUUID() + ".json");
  const token = randomUUID();
  writeFileSync(registration, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
  let closing = false;
  let stopped = false;
  const unregister = () => {
    if (stopped) return;
    if (lstatSync(registration).isSymbolicLink() || JSON.parse(readFileSync(registration, "utf8")).token !== token) throw new Error("GitNexus backend ownership changed");
    unlinkSync(registration);
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (closing || !existsSync(marker)) return;
    closing = true;
    void close().then(unregister).catch(error => { diagnostic(error); });
  }, 25);
  timer.unref();
  return unregister;
}

/** The caller holds the operation lease, so active reads have finished and new reads wait. */
export async function drainWorkspaceBackends(root: string, signal?: AbortSignal): Promise<void> {
  const { directory, marker } = paths(root);
  const token = randomUUID();
  writeFileSync(marker, token, { flag: "wx", mode: 0o600 });
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      signal?.throwIfAborted();
      const entries = readdirSync(directory).filter(name => name !== "drain");
      if (entries.length === 0) return;
      for (const name of entries) {
        try {
          const file = join(directory, name);
          if (!name.endsWith(".json") || lstatSync(file).isSymbolicLink()) throw new Error("Unsafe GitNexus backend registration");
          const value = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
          if (!Number.isSafeInteger(value.pid) || !value.pid || value.pid < 1) throw new Error("Unverifiable GitNexus backend owner");
          try { process.kill(value.pid, 0); }
          catch { throw new Error("Stale GitNexus backend registration; verify graph processes have exited before manual recovery"); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (Date.now() >= deadline) throw new Error("GitNexus backend did not close; maintenance refused");
      await delay(25, undefined, { signal });
    }
  } finally {
    if (lstatSync(marker).isSymbolicLink() || readFileSync(marker, "utf8") !== token) throw new Error("GitNexus drain ownership changed");
    unlinkSync(marker);
  }
}
