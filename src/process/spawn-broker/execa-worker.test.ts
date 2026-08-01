import { ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { createExecaOutput } from "./execa-output.js";
import { restoreExecaResult } from "./execa-protocol.js";
import { startBrokerExeca } from "./execa-worker.js";

const boundary = vi.hoisted(() => ({
  execa: vi.fn(),
  output: vi.fn<typeof createExecaOutput>(),
  transfer: vi.fn(),
}));
vi.mock("execa", () => ({ execa: boundary.execa }));
vi.mock("./pipe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pipe.js")>()),
  // Native descriptor transfer is owned by the pipe tests; this fixture has no OS handle.
  holdPipeForTransfer: boundary.transfer,
}));
vi.mock("./execa-output.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execa-output.js")>()),
  createExecaOutput: boundary.output,
}));

class CommandChild extends ChildProcess {
  override stdio: ChildProcess["stdio"] = [null, null, null, null, null];
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
}

function commandFixture() {
  const child = new CommandChild();
  const output = {
    stdout: "captured output",
    stderr: "",
    exitCode: 0,
    signal: undefined,
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
    durationMs: 200,
  };
  const completion = createDeferredCore<typeof output>();
  const kill = vi.fn(() => true);
  boundary.execa.mockReturnValue(
    Object.assign(completion.promise, { nodeChildProcess: child, kill }),
  );
  const options = { executionDeadlineMs: 1_200, stdio: "ignore" as const };
  return { child, output, completion, kill, options };
}

beforeEach(() => {
  vi.useFakeTimers();
  boundary.execa.mockReset();
  boundary.output.mockReset();
  boundary.transfer.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("broker execution deadline", () => {
  it.each(["revoked", "retired", "live"] as const)(
    "requests final authority only after output preparation (%s)",
    async (state) => {
      const fixture = commandFixture();
      const output = { receiver: new Socket(), transform: new PassThrough() };
      const preparation = createDeferredCore<typeof output>();
      boundary.output.mockReturnValue(preparation.promise);
      const refusal = new Error("captured read authority revoked");
      let current = true;
      let active = true;
      const prepareLaunch = vi.fn(async () => {
        if (!current) {
          throw refusal;
        }
        if (state === "retired") {
          active = false;
        }
      });
      const starting = startBrokerExeca(
        ["synthetic-command"],
        {
          ...fixture.options,
          stdout: "pipe",
        },
        () => {
          if (!active) {
            throw new Error("broker retired before native initiation");
          }
        },
        prepareLaunch,
      );
      const outcome = starting.catch((error: unknown) => error);
      try {
        expect(boundary.output).toHaveBeenCalledOnce();
        expect(prepareLaunch).not.toHaveBeenCalled();
        expect(boundary.execa).not.toHaveBeenCalled();
        current = state !== "revoked";
        preparation.resolve(output);
        if (state === "live") {
          const command = await starting;
          expect(boundary.execa).toHaveBeenCalledOnce();
          expect(boundary.transfer).toHaveBeenCalledExactlyOnceWith(output.receiver);
          fixture.completion.resolve(fixture.output);
          expect(await command.result).toMatchObject({ failed: false, exitCode: 0 });
          command.outputDrained(1);
        } else {
          expect(await outcome).toMatchObject({
            message:
              state === "revoked" ? refusal.message : "broker retired before native initiation",
          });
          expect(boundary.execa).not.toHaveBeenCalled();
          expect(boundary.transfer).not.toHaveBeenCalled();
          expect(output.receiver.destroyed).toBe(true);
          expect(output.transform.destroyed).toBe(true);
        }
        expect(prepareLaunch).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        preparation.resolve(output);
        fixture.completion.resolve(fixture.output);
        output.receiver.destroy();
        output.transform.destroy();
        await outcome;
      }
    },
  );

  it.each(["cancel", "kill", "cooperative", "signal", "exit-code", "exit-event"] as const)(
    "settles the deadline from root lifecycle state (%s)",
    async (state) => {
      const fixture = commandFixture();
      const run = await startBrokerExeca(["synthetic-command"], fixture.options, () => {});
      const hostStopped = state === "cancel" || state === "kill";
      const exited = state === "exit-code" || state === "exit-event";
      const timedOut = !hostStopped && !exited;
      await vi.advanceTimersByTimeAsync(199);
      if (hostStopped) {
        run[state]();
      } else if (exited) {
        fixture.child.exitCode = 0;
        if (state === "exit-event") {
          fixture.child.emit("exit", 0, null);
        }
      }
      // The result remains pending while either termination or output drain is stalled.
      await vi.advanceTimersByTimeAsync(1_002);
      expect(fixture.kill).toHaveBeenCalledTimes(timedOut || state === "kill" ? 1 : 0);
      if (timedOut) {
        expect(fixture.kill).toHaveBeenCalledExactlyOnceWith();
        fixture.child.exitCode = state === "cooperative" ? 0 : null;
        fixture.child.signalCode = state === "cooperative" ? null : "SIGTERM";
        fixture.child.emit("exit", fixture.child.exitCode, fixture.child.signalCode);
      }
      if (hostStopped || state === "signal") {
        fixture.completion.reject(
          Object.assign(new Error("Command stopped"), fixture.output, {
            failed: true,
            isCanceled: state === "cancel",
            ...(state === "signal"
              ? {
                  exitCode: undefined,
                  signal: "SIGTERM",
                  isTerminated: true,
                }
              : {}),
          }),
        );
      } else {
        fixture.completion.resolve(fixture.output);
      }
      const result = restoreExecaResult(await run.result);
      if (timedOut) {
        expect(result).toBeInstanceOf(Error);
      }
      expect(result).toMatchObject({
        failed: hostStopped || timedOut,
        timedOut,
        isCanceled: state === "cancel",
        stdout: "captured output",
        exitCode: state === "signal" ? undefined : 0,
        signal: state === "signal" ? "SIGTERM" : undefined,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
