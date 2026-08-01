import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imessagePlugin } from "./channel.js";
import type { runIMessageCliJsonCommand } from "./cli-output.js";

const native = vi.hoisted(() => ({
  cli: vi.fn<typeof runIMessageCliJsonCommand>(),
  createClient: vi.fn(),
  request: vi.fn(),
  stop: vi.fn(),
}));
// mock-isolation: Exercise real shared message admission without any native Messages processes.
vi.mock("./client.js", () => ({ createIMessageRpcClient: native.createClient }));
vi.mock("./cli-output.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli-output.js")>()),
  runIMessageCliJsonCommand: native.cli,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const workspaceDir = tempDirs.make("imessage-read-boundary-");
const cfg: OpenClawConfig = {
  agents: { entries: { main: {} }, defaults: { workspace: workspaceDir } },
  tools: { allow: ["message"], web: { search: { enabled: false }, fetch: { enabled: false } } },
  channels: {
    imessage: {
      cliPath: "imsg",
      dbPath: "/synthetic/messages.db",
      dmPolicy: "disabled",
      groupPolicy: "disabled",
    },
  },
};
const metadata = {
  id: 42,
  is_group: false,
  guid: "iMessage;-;+15555550123",
  identifier: "+15555550123",
  participants: ["+15555550123"],
};
const hosts: Array<Awaited<ReturnType<typeof createAgentHarnessHostCapabilitiesForTest>>> = [];
let run = 0;

async function createMessageFixture(options: { owner?: boolean; nativeContext?: boolean } = {}) {
  const owner = options.owner !== false;
  const runId = `imessage-read-${++run}`;
  const sessionKey = `agent:main:${runId}`;
  const nativeContext = options.nativeContext
    ? {
        messageChannel: "imessage",
        agentAccountId: "default",
        currentChannelId: "chat_id:42",
        chatType: "direct" as const,
      }
    : { messageChannel: "webchat" };
  const host = await createAgentHarnessHostCapabilitiesForTest({
    pluginId: "imessage-read-fixture",
    attempt: {
      runId,
      sessionId: runId,
      sessionKey,
      agentId: "main",
      workspaceDir,
      config: cfg,
      senderIsOwner: owner,
      ...nativeContext,
    },
    operatorSource: {
      profileId: owner ? "fixture-owner" : "fixture-member",
      scopes: owner ? ["operator.admin"] : ["operator.read", "operator.write"],
      assertCurrent: () => {},
    },
  });
  hosts.push(host);
  const tools = await host.capabilities.createToolSurfaceAsync!({
    config: cfg,
    workspaceDir,
    sessionKey,
    agentId: "main",
    senderIsOwner: owner,
    ...nativeContext,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: true,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  });
  const message = tools.find((tool) => tool.name === "message");
  if (!message) {
    throw new Error("Expected the host-created shared message tool");
  }
  return { host, message };
}

function nativeMetadata(
  params: Parameters<typeof runIMessageCliJsonCommand>[0],
  afterStart: () => void = () => {},
) {
  if (!params.initiateSpawn) {
    throw new Error("The native metadata command must retain its initiation guard");
  }
  return params.initiateSpawn(() => {
    afterStart();
    return metadata;
  });
}

beforeEach(() => {
  native.cli.mockReset().mockImplementation(async (params) => nativeMetadata(params));
  native.request.mockReset().mockResolvedValue({
    messages: [
      {
        id: 7,
        chat_id: 42,
        created_at: "2026-01-02T03:04:05Z",
        sender: "+15555550123",
        is_from_me: false,
        text: "synthetic boundary text",
      },
    ],
  });
  native.stop.mockReset().mockResolvedValue(undefined);
  native.createClient.mockReset().mockResolvedValue({ request: native.request, stop: native.stop });
  const registry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntimeMock(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "imessage",
    origin: "bundled",
    trustedOfficialInstall: true,
  });
  registry.registry.plugins.push(record);
  registry
    .createApi(record, { config: cfg, registrationMode: "full" })
    .registerChannel({ plugin: imessagePlugin });
  setActivePluginRegistry(registry.registry);
});

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.close();
  }
  resetPluginRuntimeStateForTest();
});

describe("host-created shared message -> iMessage read", () => {
  it("admits an owner-selected DM without enabling inbound intake", async () => {
    const { message } = await createMessageFixture();
    const result = await message.execute("owner-read", {
      action: "read",
      channel: "imessage",
      target: "chat_id:42",
    });
    expect(JSON.stringify(result)).toContain("synthetic boundary text");
    expect(native.request).toHaveBeenCalledWith(
      "messages.history",
      { chat_id: 42, limit: 10 },
      expect.any(Object),
    );
    expect(cfg.channels?.imessage?.dmPolicy).toBe("disabled");
    expect(cfg.channels?.imessage?.groupPolicy).toBe("disabled");
  });

  it("keeps the shared trusted-current-DM selection and canonical alias precedence", async () => {
    const { message } = await createMessageFixture({ nativeContext: true });
    await message.execute("current-read", { action: "read", channel: "imessage" });
    await message.execute("canonical-read", {
      action: "read",
      channel: "imessage",
      target: "chat_id:42",
      to: "chat_id:43",
    });
    expect(native.request.mock.calls.map((call) => call[1])).toEqual([
      { chat_id: 42, limit: 10 },
      { chat_id: 42, limit: 10 },
    ]);
  });

  it("rejects missing dashboard selection and model-supplied owner claims before native I/O", async () => {
    const owner = await createMessageFixture();
    await expect(
      owner.message.execute("missing-target", { action: "read", channel: "imessage" }),
    ).rejects.toThrow();
    const member = await createMessageFixture({ owner: false });
    await expect(
      member.message.execute("spoofed-owner", {
        action: "read",
        channel: "imessage",
        target: "chat_id:42",
        senderIsOwner: true,
        gatewayClientScopes: ["operator.admin"],
      }),
    ).rejects.toThrow();
    expect(native.cli).not.toHaveBeenCalled();
    expect(native.createClient).not.toHaveBeenCalled();
  });

  it.each(["caller", "registration"])(
    "blocks history when the %s retires after metadata",
    async (owner) => {
      const { host, message } = await createMessageFixture({
        nativeContext: owner === "registration",
      });
      let retired = false;
      native.cli.mockImplementationOnce(async (params) =>
        nativeMetadata(params, () => {
          if (owner === "caller") {
            host.close();
          } else {
            setActivePluginRegistry(createTestRegistry());
          }
          retired = true;
        }),
      );
      await expect(
        message.execute("retired-read", {
          action: "read",
          channel: "imessage",
          target: "chat_id:42",
        }),
      ).rejects.toThrow();
      expect(retired).toBe(true);
      expect(native.cli).toHaveBeenCalledOnce();
      expect(native.createClient).not.toHaveBeenCalled();
      expect(native.request).not.toHaveBeenCalled();
    },
  );
});
