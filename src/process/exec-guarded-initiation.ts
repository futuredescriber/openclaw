import { captureEffectAuthority, prepareEffectAuthority } from "../shared/effect-authority.js";
import type { SpawnInitiation } from "./spawn-initiation.js";

export async function withGuardedCommandAuthority<T>(
  originalInitiateSpawn: SpawnInitiation,
  run: (initiate: SpawnInitiation) => Promise<T>,
): Promise<T> {
  if (typeof originalInitiateSpawn !== "function") {
    throw new TypeError("Guarded command requires synchronous spawn initiation authority");
  }
  const authority = captureEffectAuthority();
  const use = authority.active ? await authority.run(prepareEffectAuthority) : undefined;
  try {
    return await run((launch, settlement) =>
      use
        ? use.initiate(() => originalInitiateSpawn(launch, settlement), settlement)
        : originalInitiateSpawn(launch, settlement),
    );
  } finally {
    use?.release();
  }
}

/** Retain a started command even when its caller throws after native initiation. */
export function createCommandSpawnInitiation(
  initiateSpawn: SpawnInitiation | undefined,
  assertCurrent: () => void,
  failedAfterLaunch: (error: unknown) => void,
): SpawnInitiation | undefined {
  if (!initiateSpawn) {
    return undefined;
  }
  return <T>(launch: () => T, settlement?: Promise<unknown>): T => {
    let open = true;
    let launched: { value: T } | undefined;
    try {
      const result = initiateSpawn(() => {
        if (!open || launched) {
          throw new Error("Command spawn initiation is no longer available");
        }
        assertCurrent();
        launched = { value: launch() };
        return launched.value;
      }, settlement);
      if (!launched) {
        // An untyped async callback cannot retain launch authority after returning.
        void Promise.resolve(result).catch(() => {});
        throw new TypeError("Command spawn initiation must launch synchronously or throw");
      }
      return launched.value;
    } catch (error) {
      if (!launched) {
        throw error;
      }
      failedAfterLaunch(error);
      return launched.value;
    } finally {
      open = false;
    }
  };
}
