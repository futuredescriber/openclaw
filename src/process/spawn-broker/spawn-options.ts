import type { SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BrokerSpawnOptions } from "./protocol.js";

export function brokerSpawnOptions(options: SpawnOptions): BrokerSpawnOptions | undefined {
  const stdio = options.stdio ?? "pipe";
  const entries = typeof stdio === "string" ? [stdio, stdio, stdio] : [...stdio];
  const normalized: BrokerSpawnOptions["stdio"] = [];
  for (let fd = 0; fd < Math.max(3, entries.length); fd += 1) {
    const entry = entries[fd] ?? (fd < 3 ? "pipe" : "ignore");
    // Only stdin is inherited by the broker. Numeric/anonymous descriptors stay host-owned.
    if (entry === "inherit" && fd !== 0) {
      return undefined;
    }
    if (entry !== "pipe" && entry !== "ignore" && entry !== "inherit" && entry !== "ipc") {
      return undefined;
    }
    normalized.push(entry);
  }
  if (options.signal || options.timeout || options.killSignal) {
    throw new Error("Unsupported spawn broker cancellation options");
  }
  return {
    cwd: options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd,
    env: options.env ? { ...options.env } : { ...process.env },
    argv0: options.argv0,
    detached: options.detached,
    shell: options.shell,
    windowsHide: options.windowsHide,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    serialization: options.serialization,
    uid: options.uid,
    gid: options.gid,
    stdio: normalized,
  };
}
