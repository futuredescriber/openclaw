import { describe, expect, it } from "vitest";
import { projectIMessageReadResult } from "./read-result.js";

function row(id: number, text = "text") {
  return {
    id,
    chat_id: 42,
    created_at: `2026-01-02T03:04:${String(id).padStart(2, "0")}Z`,
    sender: "+15555550123",
    is_from_me: id % 2 === 0,
    text,
    guid: "private-native-guid",
    attachments: [{ original_path: "/private/attachment", transfer_name: "secret.png" }],
    reactions: [{ sender: "private-reaction-sender" }],
  };
}

function project(messages: unknown[], limit = 50) {
  return projectIMessageReadResult({ result: { messages }, chatId: 42, limit });
}

describe("bounded iMessage text projection", () => {
  it("preserves decoded whitespace, identifiers, timestamps and direction without native metadata", () => {
    const result = project([row(1, " \n text\t "), row(2, "outgoing")]);
    expect(result.details).toMatchObject({
      historyComplete: false,
      coverage: "recent-window",
      order: "newest-first",
      returned: 2,
      truncated: false,
      messages: [
        { id: "2", timestamp: "2026-01-02T03:04:02.000Z", direction: "outgoing" },
        { id: "1", text: " \n text\t ", direction: "incoming", sender: "+15555550123" },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/private|attachment|secret|reaction|guid/);
  });

  it("bounds Unicode text and sender metadata without splitting code points", () => {
    const result = project([{ ...row(1, "🚀".repeat(3000)), sender: "猫".repeat(3000) }]);
    expect(result.details).toMatchObject({
      truncated: true,
      messages: [
        {
          text: "🚀".repeat(1024),
          sender: "猫".repeat(85),
          textTruncated: true,
          senderTruncated: true,
        },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32 * 1024);
  });

  it("normalizes malformed surrogate input explicitly", () => {
    expect(project([row(1, "start\ud800end")]).details).toMatchObject({
      truncated: true,
      messages: [{ text: "start�end", textTruncated: true }],
    });
  });

  it("retains and further truncates a newest body whose JSON escaping exceeds the envelope", () => {
    const result = project([row(1, "\u0000".repeat(4096))]);
    expect(result.details).toMatchObject({
      returned: 1,
      omittedForBudget: 0,
      truncated: true,
      messages: [{ id: "1", textTruncated: true }],
    });
    const newest = result.details.messages[0];
    expect(newest?.text.length).toBeGreaterThan(0);
    expect(newest?.text.length).toBeLessThan(4096);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32 * 1024);
  });

  it.each(["a", "🚀", "\u0000", '"\\\n'])(
    "bounds the COMPLETE serialized result, keeping newest records for %j",
    (text) => {
      const result = project(
        Array.from({ length: 50 }, (_, index) => row(index + 1, text.repeat(9000))),
      );
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32 * 1024);
      expect(result.details).toMatchObject({
        historyComplete: false,
        truncated: true,
        omittedForBudget: expect.any(Number),
      });
      expect(result.details).toHaveProperty("messages.0.id", "50");
      expect(result.details).toHaveProperty("messages.0.textTruncated", true);
    },
  );

  it("reports malformed records as omitted, rather than claiming complete history", () => {
    const result = project([
      row(1),
      { ...row(2), id: Number.MAX_SAFE_INTEGER + 1 },
      { ...row(3), created_at: "bad".repeat(50_000) },
      { ...row(4), is_from_me: "false" },
      { ...row(5), sender: { nested: "not a handle" } },
      { ...row(6), text: { nested: "not text" } },
      null,
    ]);
    expect(result.details).toMatchObject({
      returned: 1,
      omittedInvalid: 6,
      truncated: true,
      historyComplete: false,
      messages: [{ id: "1" }],
    });
  });

  it.each([{ chat_id: 43 }, { is_group: true }])("never discloses another chat: %j", (override) => {
    expect(() => project([{ ...row(1), ...override }])).toThrow("different or group conversation");
  });

  it("rejects malformed or overfull native windows", () => {
    expect(() => projectIMessageReadResult({ result: [], chatId: 42, limit: 10 })).toThrow();
    expect(() => project([row(1), row(2)], 1)).toThrow("invalid recent-message window");
    expect(project([]).details).toMatchObject({ returned: 0, historyComplete: false });
  });
});
