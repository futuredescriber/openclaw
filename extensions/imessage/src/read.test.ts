import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { imessageMessageActions } from "./actions.js";

const native = vi.hoisted(() => ({
  cli: vi.fn(),
  createClient: vi.fn(),
  request: vi.fn(),
  stop: vi.fn(),
  remote: vi.fn(),
  probe: vi.fn(),
}));
const authority = vi.hoisted(() => ({
  current: true,
}));

// mock-isolation: Native process and bridge entry points must never run in this fixture.
vi.mock("./client.js", () => ({ createIMessageRpcClient: native.createClient }));
vi.mock("./cli-output.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli-output.js")>()),
  runIMessageCliJsonCommand: native.cli,
}));
vi.mock("./remote-host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remote-host.js")>()),
  resolveIMessageRemoteHost: native.remote,
}));
vi.mock("./probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./probe.js")>()),
  probeIMessagePrivateApi: native.probe,
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  captureChannelReadAuthority: () => () => {
    if (!authority.current) {
      throw new Error("read authority retired");
    }
  },
}));

const metadata = {
  id: 42,
  is_group: false,
  guid: "iMessage;-;+15555550123",
  identifier: "+15555550123",
  participants: ["+15555550123"],
};
const row = {
  id: 7,
  chat_id: 42,
  created_at: "2026-01-02T03:04:05Z",
  sender: "+15555550123",
  is_from_me: false,
  text: "  decoded text\n",
};
const config: ChannelMessageActionContext["cfg"] = {
  channels: {
    imessage: {
      cliPath: "imsg",
      dbPath: "/synthetic/messages.db",
      dmPolicy: "disabled",
      groupPolicy: "disabled",
    },
  },
};

function read(
  params: Record<string, unknown> = { target: "chat_id:42" },
  context: Partial<ChannelMessageActionContext> = {},
) {
  return imessageMessageActions.handleAction!({
    channel: "imessage",
    action: "read",
    cfg: config,
    params,
    senderIsOwner: true,
    conversationReadOrigin: "direct-operator",
    ...context,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authority.current = true;
  native.cli.mockReset().mockResolvedValue(metadata);
  native.remote.mockReset().mockResolvedValue(undefined);
  native.request.mockReset().mockResolvedValue({ messages: [row] });
  native.stop.mockReset().mockResolvedValue(undefined);
  native.createClient.mockReset().mockResolvedValue({ request: native.request, stop: native.stop });
});

describe("iMessage explicit DM read action", () => {
  it("uses exact metadata then numeric history with intake disabled and no bridge probe", async () => {
    const result = await read();
    expect(result.details).toMatchObject({
      chatId: 42,
      limit: 10,
      coverage: "recent-window",
      historyComplete: false,
      messages: [{ id: "7", sender: row.sender, direction: "incoming", text: row.text }],
    });
    expect(native.cli).toHaveBeenCalledExactlyOnceWith({
      cliPath: "imsg",
      dbPath: "/synthetic/messages.db",
      timeoutMs: undefined,
      args: ["group", "--chat-id", "42"],
      initiateSpawn: expect.any(Function),
    });
    expect(native.request).toHaveBeenCalledExactlyOnceWith(
      "messages.history",
      { chat_id: 42, limit: 10 },
      { timeoutMs: undefined, assertCurrent: expect.any(Function) },
    );
    expect(native.stop).toHaveBeenCalledOnce();
    expect(native.probe).not.toHaveBeenCalled();
  });

  it.each(["any", "SMS", "RCS"])(
    "reads verified direct metadata with the native %s service",
    async (service) => {
      native.cli.mockResolvedValue({ ...metadata, guid: service + ";-;+15555550123" });
      expect((await read()).details).toMatchObject({ chatId: 42, returned: 1 });
      expect(native.request).toHaveBeenCalledOnce();
    },
  );

  it("keeps the selected CLI, database, and remote account together", async () => {
    native.remote.mockResolvedValue("bot@messages-mac");
    await read(
      { target: "chat_id:42", limit: 50 },
      {
        accountId: "remote",
        cfg: {
          channels: {
            imessage: {
              accounts: {
                remote: {
                  cliPath: "/synthetic/imsg-ssh",
                  dbPath: "~/synthetic/messages.db",
                  remoteHost: "bot@messages-mac",
                  probeTimeoutMs: 1234,
                },
              },
            },
          },
        },
      },
    );
    expect(native.cli).toHaveBeenCalledWith({
      cliPath: "/synthetic/imsg-ssh",
      dbPath: "~/synthetic/messages.db",
      timeoutMs: 1234,
      args: ["group", "--chat-id", "42"],
      initiateSpawn: expect.any(Function),
    });
    expect(native.createClient).toHaveBeenCalledWith({
      cliPath: "/synthetic/imsg-ssh",
      dbPath: "~/synthetic/messages.db",
      remoteHost: "bot@messages-mac",
    });
    expect(native.request.mock.calls[0]?.[1]).toEqual({ chat_id: 42, limit: 50 });
  });

  it("accepts trusted admin scope, not owner or scope claims in model parameters", async () => {
    await read(undefined, { senderIsOwner: false, gatewayClientScopes: ["operator.admin"] });
    native.cli.mockClear();
    await expect(
      read(
        { target: "chat_id:42", senderIsOwner: true, gatewayClientScopes: ["operator.admin"] },
        { senderIsOwner: false, gatewayClientScopes: ["operator.read"] },
      ),
    ).rejects.toThrow("requires an owner or operator.admin");
    expect(native.cli).not.toHaveBeenCalled();
  });

  it("uses the host's canonical target, not an earlier alias", async () => {
    await read({ target: "an earlier alias", to: "chat_id:42" });
    expect(native.request.mock.calls[0]?.[1]).toEqual({ chat_id: 42, limit: 10 });
  });

  it("accepts the host-resolved trusted current numeric DM on the same delegated account", async () => {
    await read(
      { target: "chat_id:42", to: "chat_id:42" },
      {
        conversationReadOrigin: "delegated",
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "imessage",
          currentChannelId: "chat_id:42",
          currentChatType: "direct",
        },
      },
    );
    expect(native.request).toHaveBeenCalledOnce();
  });

  it.each([
    { currentChannelId: "chat_id:43", currentChatType: "direct" as const },
    { currentChannelId: "chat_id:42", currentChatType: "group" as const },
    { currentChannelId: "+15555550123", currentChatType: "direct" as const },
    { currentChannelId: "chat_id:42", currentChatType: undefined },
  ])("rejects delegated native contexts without exact current-DM proof: %j", async (current) => {
    await expect(
      read(undefined, {
        conversationReadOrigin: "delegated",
        requesterAccountId: "default",
        toolContext: { currentChannelProvider: "imessage", ...current },
      }),
    ).rejects.toThrow("trusted current direct chat and account");
    expect(native.cli).not.toHaveBeenCalled();
  });

  it.each([undefined, "another"])(
    "rejects an unproven originating account: %j",
    async (requesterAccountId) => {
      await expect(
        read(undefined, {
          conversationReadOrigin: "delegated",
          requesterAccountId,
          toolContext: {
            currentChannelProvider: "imessage",
            currentChannelId: "chat_id:42",
            currentChatType: "direct",
          },
        }),
      ).rejects.toThrow("trusted current direct chat and account");
      expect(native.cli).not.toHaveBeenCalled();
    },
  );

  it.each([
    { senderIsOwner: false },
    { senderIsOwner: undefined },
    { accountId: "missing" },
    { cfg: {} },
    { cfg: { channels: { imessage: { enabled: false, cliPath: "imsg" } } } },
    {
      accountId: "off",
      cfg: { channels: { imessage: { accounts: { off: { enabled: false, cliPath: "imsg" } } } } },
    },
  ] satisfies Partial<ChannelMessageActionContext>[])(
    "rejects unauthorized or unavailable account context before native I/O: %j",
    async (context) => {
      await expect(read(undefined, context)).rejects.toThrow();
      expect(native.cli).not.toHaveBeenCalled();
      expect(native.createClient).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { target: "+15555550123" },
    { target: "name" },
    { target: "person@example.com" },
    { target: "chat_id:0" },
    { target: "chat_id:-1" },
    { target: "chat_id:1.5" },
    { target: "chat_id:9007199254740992" },
    { target: "chat_id:42", chatId: 43 },
    { target: "chat_id:42", before: "7" },
    { target: "chat_id:42", attachments: true },
    { target: "chat_id:42", service: "sms" },
    { target: "chat_id:42", limit: 0 },
    { target: "chat_id:42", limit: 1.5 },
    { target: "chat_id:42", limit: 51 },
  ])("rejects non-numeric or unsupported normalized parameters: %j", async (params) => {
    await expect(
      read(params, { toolContext: { currentChannelId: "chat_id:42" } }),
    ).rejects.toThrow();
    expect(native.cli).not.toHaveBeenCalled();
    expect(native.createClient).not.toHaveBeenCalled();
  });

  it.each([
    { id: 43 },
    { is_group: true },
    { is_group: undefined },
    { is_group: "false" },
    { participants: [] },
    { participants: ["+15555550123", "+15555550124"] },
    { participants: [""] },
    { participants: ["x".repeat(100_000)] },
    { identifier: "+15555550124" },
    { guid: "iMessage;+;group" },
    { guid: "iMessage;-;+15555550124" },
    { guid: "x".repeat(100_000) },
  ])("refuses unproven direct metadata before history (case %#)", async (override) => {
    native.cli.mockResolvedValue({ ...metadata, ...override });
    await expect(read()).rejects.toThrow();
    expect(native.createClient).not.toHaveBeenCalled();
    expect(native.request).not.toHaveBeenCalled();
    expect(native.cli).toHaveBeenCalledOnce();
  });

  it("does not read a group-like chat explicitly configured as a group", async () => {
    await expect(
      read(undefined, {
        cfg: { channels: { imessage: { cliPath: "imsg", groups: { "42": {} } } } },
      }),
    ).rejects.toThrow("configured group");
    expect(native.cli).not.toHaveBeenCalled();
  });

  it.each(["metadata", "history"])(
    "propagates %s errors without discovery or recovery",
    async (at) => {
      const error = new Error("Full Disk Access denied");
      (at === "metadata" ? native.cli : native.request).mockRejectedValueOnce(error);
      await expect(read()).rejects.toBe(error);
      expect(native.cli).toHaveBeenCalledOnce();
      expect(native.probe).not.toHaveBeenCalled();
      if (at === "metadata") {
        expect(native.createClient).not.toHaveBeenCalled();
      } else {
        expect(native.request).toHaveBeenCalledOnce();
        expect(native.stop).toHaveBeenCalledOnce();
      }
    },
  );

  it("rechecks the original read authority at queued metadata launch", async () => {
    let nativeStarts = 0;
    native.cli.mockImplementationOnce(async (params) => {
      await Promise.resolve();
      authority.current = false;
      const launch = () => {
        nativeStarts += 1;
        return metadata;
      };
      return params.initiateSpawn ? params.initiateSpawn(launch) : launch();
    });
    await expect(read()).rejects.toThrow("read authority retired");
    expect(nativeStarts).toBe(0);
    expect(native.createClient).not.toHaveBeenCalled();
  });

  it("rechecks after asynchronous transport resolution", async () => {
    native.remote.mockImplementationOnce(async () => {
      authority.current = false;
      return undefined;
    });
    await expect(read()).rejects.toThrow("read authority retired");
    expect(native.cli).not.toHaveBeenCalled();
  });

  it.each(["metadata", "history", "stop"])("fences authority retirement during %s", async (at) => {
    const selected =
      at === "metadata" ? native.cli : at === "history" ? native.request : native.stop;
    selected.mockImplementationOnce(async () => {
      authority.current = false;
      return at === "metadata" ? metadata : { messages: [row] };
    });
    await expect(read()).rejects.toThrow("read authority retired");
    if (at === "metadata") {
      expect(native.createClient).not.toHaveBeenCalled();
    } else {
      expect(native.stop).toHaveBeenCalledOnce();
    }
  });
});
