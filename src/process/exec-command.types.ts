import type {
  CommandOutputCaptureOption,
  CommandOutputErrorOption,
  CommandOutputLimitOption,
  CommandOutputStream,
  PreserveOutputLine,
} from "./exec-output.js";

export type CommandOptions = {
  timeoutMs?: number;
  cwd?: string;
  input?: string | Uint8Array;
  /** Borrow a caller-owned descriptor as stdin without buffering or piping its bytes. */
  stdinFileDescriptor?: number;
  /** Synchronous admission with the spawned PID and argv, before input is released. */
  beforeInput?: (pid: number, argv?: readonly string[]) => void;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  noOutputTimeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number | { stdout?: number; stderr?: number };
  maxCombinedOutputBytes?: number;
  outputCapture?: CommandOutputCaptureOption;
  /** Observe raw output without owning child lifecycle. Return false to stop the command. */
  onOutputChunk?: (chunk: Buffer, stream: CommandOutputStream) => boolean | void;
  /** Accept a successful exit when only the selected diagnostic output stream failed. */
  tolerateOutputError?: { stdout?: boolean; stderr?: boolean };
  /** Terminate when the selected output stream emits an error. */
  terminateOnOutputError?: CommandOutputErrorOption;
  terminateOnOutputLimit?: CommandOutputLimitOption;
  maxPreservedOutputLines?: number;
  preserveOutputLine?: PreserveOutputLine;
  killProcessTree?: boolean;
  /** Join owned descendants even after a successful root exits. */
  requireProcessTreeExtinction?: boolean;
  /** Initial signal for direct-child and graceful process-group cancellation. */
  killSignal?: NodeJS.Signals | number;
  /** Grace between graceful termination and the force-kill fallback. */
  killGraceMs?: number;
};
