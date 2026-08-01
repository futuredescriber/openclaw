import { ChildProcess, type MessageOptions, type SendHandle } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import {
  captureChannelReadAuthority,
  withChannelReadAuthority,
} from "../../shared/channel-read-authority.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runGuardedCommandWithTimeout } from "../exec-runner.js";
import { spawnCommand, withCommandProcessScope } from "../exec-spawn.js";
import { runWithSpawnBroker } from "./context.js";
import { serializeExecaError, type BrokerExecaResult } from "./execa-protocol.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import { SpawnBrokerError, type BrokerResponse } from "./protocol.js";

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  execa: vi.fn(() => {
    throw new Error("Native command execution is outside this transport fixture");
  }),
  lostChildCleanup: vi.fn(() => ({ force: vi.fn(), settled: Promise.resolve() })),
  groupCleanup: vi.fn(() => ({ force: vi.fn(), settled: Promise.resolve() })),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
vi.mock("execa", () => ({ execa: native.execa }));
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/spawn-broker.js"),
  resolveRuntimeWorkerArgv: () => ["synthetic-spawn-broker"],
}));
vi.mock("./cleanup.js", () => ({
  terminateLostBrokerChild: native.lostChildCleanup,
  terminateBrokerProcessGroup: native.groupCleanup,
}));
vi.mock("../../shared/pid-alive.js", () => ({
  getFileLockProcessStartTime: () => {
    throw new Error("Synthetic broker children cannot authorize a PID probe");
  },
}));
vi.mock("../child-process-tree.js", () => ({
  isChildProcessTreeAlive: () => {
    throw new Error("Synthetic broker children cannot authorize a tree probe");
  },
}));
vi.mock("../kill-tree.js", () => ({
  killProcessTree: () => {
    throw new Error("Synthetic broker children cannot authorize a process signal");
  },
}));
vi.mock("../windows-command.js", () => ({
  resolveSafeChildProcessInvocation: ({ argv }: { argv: string[] }) => ({
    command: argv[0],
    args: argv.slice(1),
    windowsHide: true,
    windowsVerbatimArguments: false,
    usesWindowsExitCodeShim: false,
  }),
}));

const hosts: SpawnBrokerHost[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("This fixture must not signal or inspect native processes");
  });
});

afterEach(async () => {
  try {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  } finally {
    vi.restoreAllMocks();
  }
});

function brokerFixture(ready = true, guardedExeca = true) {
  // Construct the event surface only; the mocked spawn never starts this child.
  const worker = new ChildProcess();
  const requestSent = createDeferredCore<number>();
  let connected = true;
  let exited = false;
  const exit = () => {
    if (!exited) {
      exited = true;
      worker.emit("exit", 0, null);
      worker.emit("close", 0, null);
    }
  };
  const send = vi.fn(
    (
      message: unknown,
      ...args: Array<SendHandle | MessageOptions | ((error: Error | null) => void) | undefined>
    ) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        (message.type === "spawn-execa" ||
          message.type === "prepare-spawn-execa" ||
          message.type === "spawn") &&
        "id" in message &&
        typeof message.id === "number"
      ) {
        requestSent.resolve(message.id);
      }
      args.find((arg) => typeof arg === "function")?.(null);
      return true;
    },
  );
  Object.defineProperties(worker, {
    pid: { value: 41001 },
    connected: { get: () => connected },
    exitCode: { get: () => (exited ? 0 : null) },
    send: { value: send },
    disconnect: {
      value: () => {
        connected = false;
        worker.emit("disconnect");
        exit();
      },
    },
    kill: {
      value: () => {
        exit();
        return true;
      },
    },
  });
  native.spawn.mockReturnValueOnce(worker);
  const host = createSpawnBrokerHost();
  hosts.push(host);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: "bootstrap" }, expect.any(Function));
  // Assertions below distinguish command transmission from transport bootstrap.
  send.mockClear();
  const receive = (message: BrokerResponse) => worker.emit("message", message);
  if (ready) {
    receive({ type: "ready", pid: 41001, ...(guardedExeca ? { guardedExeca: true } : {}) });
  }
  return { host, worker, send, receive, requestSent: requestSent.promise };
}

function missingExecutableResult(): BrokerExecaResult {
  const error = Object.assign(new Error("spawn synthetic-missing ENOENT"), { code: "ENOENT" });
  return {
    failed: true,
    code: "ENOENT",
    timedOut: false,
    isCanceled: false,
    isGracefullyCanceled: false,
    isMaxBuffer: false,
    isTerminated: false,
    isForcefullyTerminated: false,
    command: "synthetic-missing",
    escapedCommand: "synthetic-missing",
    cwd: "/synthetic",
    durationMs: 0,
    stdout: "",
    stderr: "",
    error: serializeExecaError(error),
  };
}

type FailureCase = {
  name: string;
  reject?: boolean;
  local?: boolean;
  owned?: boolean;
  disconnect?: boolean;
  result?: "missing" | "capacity";
};

const failures: FailureCase[] = [
  { name: "failed launch returned", result: "missing", reject: false },
  { name: "failed launch rejected", result: "missing" },
  { name: "unowned transport loss", disconnect: true },
  { name: "owned transport loss", disconnect: true, owned: true },
  { name: "capacity refusal with reject:false", result: "capacity", reject: false },
  { name: "capacity refusal with reject:true", result: "capacity" },
  { name: "unconfirmed unowned failure" },
  { name: "unconfirmed owned failure", owned: true },
  { name: "failed result after ownership", owned: true, result: "capacity" },
  { name: "local admission refusal", local: true },
];

describe("broker host scope settlement", () => {
  it.each([false, true])(
    "rechecks captured read authority after queued preparation (revoked: %s)",
    async (revoked) => {
      const fixture = brokerFixture();
      const preparation = createDeferredCore<number>();
      const grant = createDeferredCore<{ id: number; allowed: boolean }>();
      const blocked = createDeferredCore<() => void>();
      const send = fixture.send.getMockImplementation()!;
      fixture.send.mockImplementation((message, ...args) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          "id" in message &&
          typeof message.id === "number"
        ) {
          if (message.type === "prepare-spawn-execa") {
            preparation.resolve(message.id);
            blocked.resolve(() => {
              args.find((arg) => typeof arg === "function")?.(null);
            });
            return true;
          }
          if (
            message.type === "launch" &&
            "allowed" in message &&
            typeof message.allowed === "boolean"
          ) {
            grant.resolve({ id: message.id, allowed: message.allowed });
          }
        }
        return send(message, ...args);
      });
      const refusal = new Error("captured read authority revoked");
      let current = true;
      let calls = 0;
      let settlement: Promise<unknown> | undefined;
      const command = withChannelReadAuthority(
        () => {
          if (!current) {
            throw refusal;
          }
        },
        async () => {
          const assertRead = captureChannelReadAuthority()!;
          return await runWithSpawnBroker(fixture.host, () =>
            runGuardedCommandWithTimeout(["synthetic-command"], {
              baseEnv: {},
              initiateSpawn(launch, remoteSettlement) {
                calls++;
                settlement = remoteSettlement;
                assertRead();
                return launch();
              },
            }),
          );
        },
      );
      const outcome = command.catch((error: unknown) => error);
      const id = await preparation.promise;
      // The worker is prepared, but the final launch grant still waits behind
      // the preparation's native IPC receipt on the host's existing FIFO.
      fixture.receive({ type: "prepared", id });
      expect(calls).toBe(0);
      current = !revoked;
      (await blocked.promise)();
      expect(await grant.promise).toEqual({ id, allowed: !revoked });
      expect(calls).toBe(1);
      expect(settlement).toBeInstanceOf(Promise);
      if (revoked) {
        const refusalResult = new SpawnBrokerError("Spawn broker launch authority refused");
        fixture.receive({
          type: "execa-result",
          id,
          result: {
            ...missingExecutableResult(),
            code: refusalResult.code,
            error: serializeExecaError(refusalResult),
          },
        });
        fixture.receive({ type: "error", id, error: refusalResult, resultUnavailable: true });
        expect(await outcome).toBe(refusal);
      } else {
        fixture.receive({ type: "owned", id, pid: 41002 });
        await settlement;
        fixture.receive({
          type: "spawned",
          id,
          pid: 41002,
          spawnfile: "synthetic-command",
          spawnargs: ["synthetic-command"],
          connected: false,
          stdioLength: 3,
        });
        fixture.receive({ type: "exit", id, code: 0, signal: null });
        fixture.receive({ type: "closed", id });
        fixture.receive({
          type: "execa-result",
          id,
          result: {
            ...missingExecutableResult(),
            failed: false,
            code: undefined,
            error: undefined,
            exitCode: 0,
          },
        });
        expect(await command).toMatchObject({ code: 0, cleanup: "normal" });
      }
      await settlement;
      expect(native.execa).not.toHaveBeenCalled();
      expect(native.spawn).toHaveBeenCalledOnce();
    },
  );

  it("refuses an older broker without transmitting or falling back to a local command", async () => {
    const fixture = brokerFixture(true, false);
    const initiation = vi.fn((): never => {
      throw new Error("Refused commands must not reach native launch authority");
    });
    const reservation = { spawned: vi.fn(), settled: vi.fn() };
    const command = runWithSpawnBroker(fixture.host, () =>
      withCommandProcessScope(
        () => runGuardedCommandWithTimeout(["synthetic-command"], { initiateSpawn: initiation }),
        undefined,
        { reserve: () => reservation },
      ),
    );
    await expect(command).rejects.toThrow("does not support guarded Execa commands");
    expect(initiation).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(native.execa).not.toHaveBeenCalled();
    expect(reservation.spawned).not.toHaveBeenCalled();
    expect(reservation.settled).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "retire"] as const)(
    "refuses %s before a queued final grant without retaining unknown process custody",
    async (state) => {
      const fixture = brokerFixture();
      const preparation = createDeferredCore<{ id: number; release: () => void }>();
      const denied = createDeferredCore();
      const send = fixture.send.getMockImplementation()!;
      fixture.send.mockImplementation((message, ...args) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          "id" in message &&
          typeof message.id === "number"
        ) {
          if (message.type === "prepare-spawn-execa") {
            preparation.resolve({
              id: message.id,
              release: () => {
                args.find((arg) => typeof arg === "function")?.(null);
              },
            });
            return true;
          }
          if (message.type === "launch" && "allowed" in message && message.allowed === false) {
            denied.resolve();
          }
        }
        return send(message, ...args);
      });
      const initiation = vi.fn((): never => {
        throw new Error("Refused commands must not reach native launch authority");
      });
      const command = fixture.host.spawnExeca(
        ["synthetic-command"],
        { stdio: "ignore" },
        initiation,
      );
      const result = command.result.catch((error: unknown) => error);
      const { id, release } = await preparation.promise;
      fixture.receive({ type: "prepared", id });
      if (state === "cancel") {
        command.cancel();
        release();
        await denied.promise;
        const refusal = new SpawnBrokerError("Spawn broker launch authority refused");
        fixture.receive({
          type: "execa-result",
          id,
          result: {
            ...missingExecutableResult(),
            code: refusal.code,
            error: serializeExecaError(refusal),
          },
        });
        fixture.receive({ type: "error", id, error: refusal, resultUnavailable: true });
      } else {
        await fixture.host.close();
        release();
      }
      await result;
      await command.child.waitForClose();
      // Drain the already-enqueued sender continuations, not a wall-clock delay.
      await setImmediate();
      expect(command.child.notStarted).toBe(true);
      expect(initiation).not.toHaveBeenCalled();
      expect(fixture.send).not.toHaveBeenCalledWith(
        { type: "launch", id, allowed: true },
        undefined,
        expect.anything(),
        expect.any(Function),
      );
      expect(native.execa).not.toHaveBeenCalled();
      expect(native.lostChildCleanup).not.toHaveBeenCalled();
    },
  );

  it.each(["receipt", "broker-close"] as const)(
    "retains guarded Execa native settlement after proxy failure until %s",
    async (completion) => {
      const fixture = brokerFixture();
      const granted = createDeferredCore<{ settlement: Promise<unknown> }>();
      const command = fixture.host.spawnExeca(
        ["synthetic-command"],
        { stdio: "ignore" },
        (launch, settlement) => {
          if (!settlement) {
            throw new Error("Missing native settlement");
          }
          const result = launch();
          granted.resolve({ settlement });
          return result;
        },
      );
      const result = command.result.catch((error: unknown) => error);
      const id = await fixture.requestSent;
      fixture.receive({ type: "prepared", id });
      const { settlement: nativeSettlement } = await granted.promise;
      let settled = false;
      void nativeSettlement.then(() => {
        settled = true;
      });
      command.child.fail(new Error("synthetic proxy failure"));
      await command.child.waitForClose();
      expect(settled).toBe(false);
      if (completion === "receipt") {
        fixture.receive({ type: "owned", id, pid: 41002 });
        fixture.receive({ type: "execa-result", id, result: missingExecutableResult() });
        expect(native.lostChildCleanup).toHaveBeenCalledOnce();
      } else {
        await fixture.host.close();
      }
      await nativeSettlement;
      expect(settled).toBe(true);
      await result;
    },
  );

  it.each(failures)("settles $name according to admission evidence", async (failure) => {
    const fixture = brokerFixture(!failure.local);
    let commandFailure: unknown;
    const scope = runWithSpawnBroker(fixture.host, () =>
      withCommandProcessScope(async () => {
        try {
          return await spawnCommand(
            [failure.result === "missing" ? "synthetic-missing" : "synthetic-command"],
            {
              reject: failure.reject ?? true,
              baseEnv: {},
            },
          );
        } catch (error) {
          commandFailure = error;
          throw error;
        }
      }),
    );
    const outcome = scope.then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    if (!failure.local) {
      const id = await fixture.requestSent;
      if (failure.owned) {
        fixture.receive({ type: "owned", id, pid: 41002 });
      }
      if (failure.disconnect) {
        fixture.worker.emit("disconnect");
        // Cancel the restart timer; native cleanup is mocked.
        await fixture.host.close();
      } else {
        const refusal = new SpawnBrokerError("Spawn broker request capacity exceeded");
        if (failure.result) {
          // Failed admission sends a result before the error, without ownership.
          fixture.receive({
            type: "execa-result",
            id,
            result: {
              ...missingExecutableResult(),
              ...(failure.result === "capacity"
                ? { code: refusal.code, error: serializeExecaError(refusal) }
                : {}),
            },
          });
        }
        fixture.receive({
          type: "error",
          id,
          error: failure.result === "missing" ? { message: "missing", code: "ENOENT" } : refusal,
          ...(failure.result === "missing" ? {} : { resultUnavailable: true }),
        });
      }
    }
    const completed = await outcome;
    const uncertain = !failure.local && (!failure.result || failure.owned);
    if (uncertain) {
      expect(completed.error).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
      expect(collectNestedErrorCandidates(completed.error)).toContain(commandFailure);
    } else if (failure.result === "missing" && failure.reject === false) {
      expect(completed.error).toBeUndefined();
      expect(completed.result).toMatchObject({ failed: true, code: "ENOENT" });
    } else {
      expect(completed.error).toBe(commandFailure);
      expect(completed.error).toMatchObject({
        code: failure.result === "missing" ? "ENOENT" : "ERR_SPAWN_BROKER_UNAVAILABLE",
      });
    }
    if (failure.disconnect) {
      expect(native.lostChildCleanup).toHaveBeenCalledTimes(failure.owned ? 1 : 0);
    } else if (!uncertain) {
      expect(native.lostChildCleanup).not.toHaveBeenCalled();
    }
    if (failure.local) {
      expect(fixture.send).not.toHaveBeenCalled();
    }
  });

  it("settles raw-spawn readiness and close after confirmed worker refusal", async () => {
    const fixture = brokerFixture();
    const child = fixture.host.spawn("synthetic-command", [], { stdio: "pipe" });
    const ready = child.ready().catch((error: unknown) => error);
    const closed = child.waitForClose();
    const id = await fixture.requestSent;
    const refusal = new SpawnBrokerError("Spawn broker request capacity exceeded");
    fixture.receive({
      type: "execa-result",
      id,
      result: {
        ...missingExecutableResult(),
        code: refusal.code,
        error: serializeExecaError(refusal),
      },
    });
    fixture.receive({ type: "error", id, error: refusal, resultUnavailable: true });
    await closed;
    expect(await ready).toMatchObject({ code: refusal.code });
    expect(child.notStarted).toBe(true);
    expect(native.lostChildCleanup).not.toHaveBeenCalled();
  });

  it("retires undelivered guarded preparations and refuses a late orphan", async () => {
    const fixture = brokerFixture();
    let orphanId: number | undefined;
    let initiations = 0;
    // Exceed the broker's request capacity without delivering any preparation to its peer.
    for (let attempt = 0; attempt < 257; attempt++) {
      fixture.send.mockImplementationOnce((message, ...args) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "prepare-spawn" &&
          "id" in message &&
          typeof message.id === "number"
        ) {
          orphanId ??= message.id;
        }
        args.find((arg) => typeof arg === "function")?.(new Error("synthetic delivery refusal"));
        return false;
      });
      const child = fixture.host.spawn("synthetic-command", [], { stdio: "ignore" }, (launch) => {
        initiations++;
        return launch();
      });
      await expect(child.ready(), `preparation ${attempt}`).rejects.toThrow(
        "Spawn broker request delivery failed",
      );
      await child.waitForClose();
    }
    if (orphanId === undefined) {
      throw new Error("Expected a transmitted preparation identity");
    }
    const refusal = createDeferredCore<unknown>();
    fixture.send.mockImplementationOnce((message, ...args) => {
      refusal.resolve(message);
      args.find((arg) => typeof arg === "function")?.(null);
      return true;
    });
    fixture.receive({ type: "prepared", id: orphanId });
    await expect(refusal.promise).resolves.toEqual({
      type: "launch",
      id: orphanId,
      allowed: false,
    });

    const recovered = fixture.host.spawn("synthetic-command", [], { stdio: "ignore" });
    const result = expect(recovered.ready()).rejects.toThrow("synthetic native refusal");
    const id = await fixture.requestSent;
    fixture.receive({ type: "error", id, error: { message: "synthetic native refusal" } });
    await result;
    await recovered.waitForClose();
    expect(initiations).toBe(0);
  });
});
