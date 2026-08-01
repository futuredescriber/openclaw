import {
  runCommandWithTimeout,
  runGuardedCommandWithTimeout,
} from "openclaw/plugin-sdk/process-runtime";
// iMessage tests cover canonical bounded CLI execution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runIMessageCliJsonCommand } from "./cli-output.js";

// mock-isolation: Command execution stays synthetic; no real process or custody starts.
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: vi.fn(),
  runGuardedCommandWithTimeout: vi.fn(),
}));

const runCommandMock = vi.mocked(runCommandWithTimeout);
const runGuardedCommandMock = vi.mocked(runGuardedCommandWithTimeout);

function commandResult(
  overrides: Partial<Awaited<ReturnType<typeof runCommandWithTimeout>>> = {},
): Awaited<ReturnType<typeof runCommandWithTimeout>> {
  return {
    stdout: '{"success":true,"messageId":"ok"}\n',
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

describe("runIMessageCliJsonCommand", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    runGuardedCommandMock.mockReset();
    runCommandMock.mockResolvedValue(commandResult());
  });

  it("uses the canonical wrapper with bounded asymmetric output", async () => {
    await expect(
      runIMessageCliJsonCommand({
        cliPath: "/usr/local/bin/imsg",
        dbPath: " /tmp/chat.db ",
        args: ["send", "--text", "hello"],
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({ success: true, messageId: "ok" });

    expect(runCommandMock).toHaveBeenCalledWith(
      ["/usr/local/bin/imsg", "send", "--text", "hello", "--db", "/tmp/chat.db", "--json"],
      expect.objectContaining({
        maxOutputBytes: {
          stdout: 8 * 1024 * 1024,
          stderr: 64 * 1024,
        },
        outputCapture: { stdout: "head", stderr: "tail" },
        terminateOnOutputLimit: { stdout: true },
      }),
    );
  });

  it("retains the caller's guard through queued command preparation", async () => {
    let current = true;
    let nativeStarts = 0;
    const refusal = new Error("original read authority retired");
    runGuardedCommandMock.mockImplementationOnce(async (_argv, options) => {
      await Promise.resolve();
      current = false;
      return options.initiateSpawn(() => {
        nativeStarts += 1;
        return commandResult();
      });
    });
    await expect(
      runIMessageCliJsonCommand({
        cliPath: "imsg",
        args: ["group", "--chat-id", "42"],
        initiateSpawn: (launch) => {
          if (!current) {
            throw refusal;
          }
          return launch();
        },
      }),
    ).rejects.toBe(refusal);
    expect(nativeStarts).toBe(0);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("parses the last JSON object after CLI noise", async () => {
    runCommandMock.mockResolvedValueOnce(
      commandResult({ stdout: 'warning\n{"success":true,"messageId":"last"}\n' }),
    );
    await expect(
      runIMessageCliJsonCommand({ cliPath: "imsg", args: ["send"] }),
    ).resolves.toMatchObject({ messageId: "last" });
  });

  it("surfaces timeout and stdout-cap failures", async () => {
    runCommandMock.mockResolvedValueOnce(commandResult({ code: 124, termination: "timeout" }));
    await expect(
      runIMessageCliJsonCommand({ cliPath: "imsg", args: ["send"], timeoutMs: 25 }),
    ).rejects.toThrow("iMessage action timed out after 25ms");

    runCommandMock.mockResolvedValueOnce(
      commandResult({ code: null, termination: "signal", outputLimitExceeded: true }),
    );
    await expect(runIMessageCliJsonCommand({ cliPath: "imsg", args: ["send"] })).rejects.toThrow(
      "imsg stdout exceeded 8388608 bytes",
    );
  });

  it("prefers structured and stderr command failures", async () => {
    runCommandMock.mockResolvedValueOnce(
      commandResult({ code: 2, stdout: '{"success":false,"error":"denied"}\n' }),
    );
    await expect(runIMessageCliJsonCommand({ cliPath: "imsg", args: ["send"] })).rejects.toThrow(
      "denied",
    );

    runCommandMock.mockResolvedValueOnce(commandResult({ code: 2, stdout: "", stderr: "boom" }));
    await expect(runIMessageCliJsonCommand({ cliPath: "imsg", args: ["send"] })).rejects.toThrow(
      "boom",
    );
  });

  it("rejects successful non-JSON and success=false output", async () => {
    runCommandMock.mockResolvedValueOnce(commandResult({ stdout: "not json" }));
    await expect(runIMessageCliJsonCommand({ cliPath: "imsg", args: ["send"] })).rejects.toThrow(
      "imsg returned non-JSON output: not json",
    );

    runCommandMock.mockResolvedValueOnce(
      commandResult({ stdout: '{"success":false,"error":"failed"}\n' }),
    );
    await expect(runIMessageCliJsonCommand({ cliPath: "imsg", args: ["send"] })).rejects.toThrow(
      "failed",
    );
  });
});
