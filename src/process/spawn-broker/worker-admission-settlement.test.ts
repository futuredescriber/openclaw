import { ChildProcess, type spawn } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { killProcessTree } from "../kill-tree.js";
import type { BrokerPublisher } from "./ipc.js";
import type { BrokerRequest, BrokerResponse } from "./protocol.js";
import type { BrokerBootstrap } from "./resource-protocol.js";
import type { createWorkerSender } from "./worker-sender.js";

type Sender = ReturnType<typeof createWorkerSender>;
type Receive = (message: BrokerBootstrap | BrokerRequest) => void;
const boundary = vi.hoisted(() => ({
  spawn: vi.fn<typeof spawn>(),
  execa: vi.fn(),
  killTree: vi.fn<typeof killProcessTree>(),
  reserve: vi.fn<Sender["reserve"]>(),
  send: vi.fn<(message: BrokerResponse) => Promise<void>>(),
  close: vi.fn<Sender["close"]>(),
  acknowledge: vi.fn<Sender["acknowledge"]>(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: boundary.spawn,
}));
vi.mock("execa", () => ({ execa: boundary.execa }));
// mock-isolation: No synthetic child may reach native process signaling.
vi.mock("../kill-tree.js", () => ({ killProcessTree: boundary.killTree }));
// mock-isolation: Admission and publication barriers are owned by this in-memory peer.
vi.mock("./worker-sender.js", () => ({
  createWorkerSender: () => ({
    reserve: boundary.reserve,
    send: boundary.send,
    close: boundary.close,
    acknowledge: boundary.acknowledge,
  }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  boundary.reserve.mockRejectedValue(new Error("synthetic reservation refused before startup"));
  boundary.send.mockResolvedValue(undefined);
  boundary.spawn.mockImplementation(() => {
    throw new Error("This worker admission fixture cannot spawn a process");
  });
  boundary.execa.mockImplementation(() => {
    throw new Error("This worker admission fixture cannot start native execa");
  });
  boundary.killTree.mockImplementation(() => {
    throw new Error("This worker admission fixture cannot signal a process");
  });
});

async function withWorker(run: (receive: Receive) => Promise<void>) {
  let receive: Receive | undefined;
  const connected = Object.getOwnPropertyDescriptor(process, "connected");
  const originalOn = process.on.bind(process);
  const originalOnce = process.once.bind(process);
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "message") {
      receive = listener;
      return process;
    }
    if (event === "SIGTERM" || event === "SIGINT") {
      return process;
    }
    return originalOn(event, listener);
  });
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "disconnect") {
      return process;
    }
    return originalOnce(event, listener);
  });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("This worker admission fixture cannot signal or inspect a process");
  });
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("This worker admission fixture cannot exit the test process");
  });
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  const ready = createDeferredCore();
  const send = boundary.send.getMockImplementation()!;
  boundary.send.mockImplementation(async (message) => {
    await send(message);
    if (message.type === "ready") {
      ready.resolve();
    }
  });
  try {
    await import("./worker.js");
    if (!receive) {
      throw new Error("The worker did not register its message entrypoint");
    }
    // Keep loader scheduling real; the worker lifecycle owns the fake clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    receive({ type: "bootstrap" });
    await ready.promise;
    expect(boundary.send).toHaveBeenCalledWith(
      { type: "ready", pid: process.pid, guardedExeca: true },
      undefined,
    );
    await run(receive);
    expect(boundary.killTree).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(boundary.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    // Join the worker's owned reservation/report continuations before restoring hooks.
    await Promise.allSettled([
      ...boundary.reserve.mock.results.flatMap((result) =>
        result.type === "return" ? [result.value] : [],
      ),
      ...boundary.send.mock.results.flatMap((result) =>
        result.type === "return" ? [result.value] : [],
      ),
    ]);
    await setImmediate();
    vi.clearAllTimers();
    vi.useRealTimers();
    if (connected) {
      Object.defineProperty(process, "connected", connected);
    } else {
      Reflect.deleteProperty(process, "connected");
    }
    vi.restoreAllMocks();
  }
}

it.each(["spawn", "spawn-execa", "prepare-spawn-execa"] as const)(
  "reports authoritative no-start before the %s capacity refusal",
  async (type) => {
    await withWorker(async (receive) => {
      // Rejections wait for a microtask, so synchronous delivery fills admission.
      for (let id = 1; id <= 257; id += 1) {
        receive(
          type === "spawn"
            ? {
                type,
                id,
                argv: ["synthetic-command"],
                options: { stdio: ["ignore", "ignore", "ignore"] },
              }
            : {
                type,
                id,
                argv: ["synthetic-command"],
                options: { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
              },
        );
      }
      await setImmediate();
      const responses = boundary.send.mock.calls.map(([message]) => message);
      const refusal = responses.filter((message) => "id" in message && message.id === 257);
      expect(refusal.map((message) => message.type)).toEqual(["execa-result", "error"]);
      expect(refusal[0]).toMatchObject({
        result: {
          failed: true,
          code: "ERR_SPAWN_BROKER_UNAVAILABLE",
          error: { code: "ERR_SPAWN_BROKER_UNAVAILABLE" },
        },
      });
      expect(refusal[1]).toMatchObject({
        error: { code: "ERR_SPAWN_BROKER_UNAVAILABLE" },
      });
      expect(
        responses.some((message) => message.type === "owned" || message.type === "spawned"),
      ).toBe(false);
      expect(boundary.reserve).toHaveBeenCalledTimes(256);
      expect(responses.filter((message) => message.type === "error")).toHaveLength(257);
      expect(boundary.spawn).not.toHaveBeenCalled();
      expect(boundary.execa).not.toHaveBeenCalled();
    });
  },
);

class CommandChild extends ChildProcess {
  override stdio: ChildProcess["stdio"] = [null, null, null, null, null];
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
}

it.each(["revoked-in-queue", "revoked-at-grant", "canceled", "live"] as const)(
  "fences native Execa after worker admission (%s)",
  async (state) => {
    const admission = createDeferredCore();
    const prepared = createDeferredCore();
    const grant = createDeferredCore();
    const owned = createDeferredCore();
    const reported = createDeferredCore<BrokerResponse>();
    const completion = createDeferredCore<{
      exitCode: number;
      stdout: string;
      stderr: string;
      failed: boolean;
      timedOut: boolean;
      isCanceled: boolean;
      isGracefullyCanceled: boolean;
      isMaxBuffer: boolean;
      isTerminated: boolean;
      isForcefullyTerminated: boolean;
      command: string;
      escapedCommand: string;
      cwd: string;
      durationMs: number;
    }>();
    const child = new CommandChild();
    Object.defineProperty(child, "pid", { value: 41002 });
    boundary.execa.mockReturnValue(
      Object.assign(completion.promise, {
        nodeChildProcess: child,
        kill: vi.fn(() => true),
      }),
    );
    boundary.send.mockImplementation(async (message) => {
      if (
        (state === "live" && message.type === "execa-result") ||
        (state !== "live" && message.type === "error")
      ) {
        reported.resolve(message);
      }
    });
    await withWorker(async (receive) => {
      let current = true;
      let assertions = 0;
      const capturedReadAssertion = () => {
        assertions++;
        if (!current) {
          throw new Error("captured read authority revoked");
        }
      };
      const publish: BrokerPublisher = async (message) => {
        if (message && typeof message === "object" && "type" in message) {
          if (message.type === "prepared") {
            prepared.resolve();
            await grant.promise;
            let allowed = true;
            try {
              capturedReadAssertion();
            } catch {
              allowed = false;
            }
            receive({ type: "launch", id: 1, allowed });
          } else if (message.type === "owned") {
            owned.resolve();
          }
        }
      };
      boundary.reserve.mockImplementation(<T>(run: (publisher: BrokerPublisher) => Promise<T>) =>
        admission.promise.then(() => run(publish)),
      );
      receive({
        type: "prepare-spawn-execa",
        id: 1,
        argv: ["synthetic-command"],
        options: { stdio: "ignore" },
      });
      expect(boundary.execa).not.toHaveBeenCalled();
      if (state === "revoked-in-queue") {
        current = false;
      }
      admission.resolve();
      await prepared.promise;
      expect(assertions).toBe(0);
      expect(boundary.execa).not.toHaveBeenCalled();
      if (state === "revoked-at-grant") {
        current = false;
      }
      if (state === "canceled") {
        receive({ type: "cancel", id: 1 });
      }
      grant.resolve();
      if (state === "live") {
        await owned.promise;
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
        completion.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
          failed: false,
          timedOut: false,
          isCanceled: false,
          isGracefullyCanceled: false,
          isMaxBuffer: false,
          isTerminated: false,
          isForcefullyTerminated: false,
          command: "synthetic-command",
          escapedCommand: "synthetic-command",
          cwd: "/synthetic",
          durationMs: 0,
        });
        expect(await reported.promise).toMatchObject({
          type: "execa-result",
          result: { failed: false, exitCode: 0 },
        });
        expect(boundary.execa).toHaveBeenCalledOnce();
      } else {
        expect(await reported.promise).toMatchObject({ type: "error", resultUnavailable: true });
        expect(boundary.send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "execa-result",
            id: 1,
            result: expect.objectContaining({ failed: true, code: "ERR_SPAWN_BROKER_UNAVAILABLE" }),
          }),
          undefined,
        );
        expect(boundary.execa).not.toHaveBeenCalled();
      }
      expect(assertions).toBe(1);
      expect(boundary.spawn).not.toHaveBeenCalled();
    });
  },
);
