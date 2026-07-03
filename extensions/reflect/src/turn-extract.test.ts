import { describe, expect, it } from "vitest";
import { createSessionCursorTracker, extractLatestTurn } from "./turn-extract.js";

function user(text: string): unknown {
  return { role: "user", content: text };
}

function userBlocks(...texts: string[]): unknown {
  return { role: "user", content: texts.map((text) => ({ type: "text", text })) };
}

function assistant(text: string): unknown {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("extractLatestTurn", () => {
  const cases: Array<{
    name: string;
    messages: unknown[];
    userText?: string;
    assistantText?: string;
  }> = [
    {
      name: "string content",
      messages: [user("  hello  "), { role: "assistant", content: " hi there " }],
      userText: "hello",
      assistantText: "hi there",
    },
    {
      name: "text-block arrays",
      messages: [userBlocks("first line", "second line"), assistant("answer")],
      userText: "first line\nsecond line",
      assistantText: "answer",
    },
    {
      name: "tool and thinking blocks ignored",
      messages: [
        user("question"),
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "read", input: {} },
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "visible" },
            { type: "tool_result", content: "raw" },
          ],
        },
      ],
      userText: "question",
      assistantText: "visible",
    },
    {
      name: "last nonempty user message wins",
      messages: [user("first"), assistant("a1"), user("second"), assistant("a2")],
      userText: "second",
      assistantText: "a2",
    },
    {
      name: "empty trailing user skipped in favor of earlier nonempty user",
      messages: [user("real"), assistant("reply"), user("   ")],
      userText: "real",
      assistantText: "reply",
    },
    {
      name: "assistant before the user message excluded",
      messages: [assistant("before"), user("ask"), assistant("after")],
      userText: "ask",
      assistantText: "after",
    },
    {
      name: "multiple assistant messages after user joined with newline",
      messages: [user("ask"), assistant("part one"), { role: "tool" }, assistant("part two")],
      userText: "ask",
      assistantText: "part one\npart two",
    },
    {
      name: "no assistant after user yields undefined fields",
      messages: [assistant("stale"), user("ask")],
    },
    {
      name: "no user text yields undefined fields",
      messages: [assistant("only assistant")],
    },
    {
      name: "non-record messages and malformed blocks skipped",
      messages: [
        null,
        42,
        "loose string",
        [],
        {
          role: "user",
          content: [
            null,
            { type: "text" },
            { type: "text", text: 5 },
            { text: "typeless" },
            { type: "text", text: "ok" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "fine" }, "junk"] },
      ],
      userText: "ok",
      assistantText: "fine",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = extractLatestTurn(testCase.messages, 0);
      expect(result.userText).toBe(testCase.userText);
      expect(result.assistantText).toBe(testCase.assistantText);
      expect(result.nextCursor).toBe(testCase.messages.length);
    });
  }

  it("only reads the tail past the cursor", () => {
    const messages = [user("old"), assistant("old reply"), user("new"), assistant("new reply")];
    const result = extractLatestTurn(messages, 2);
    expect(result).toEqual({ userText: "new", assistantText: "new reply", nextCursor: 4 });
  });

  it("second pass over the same snapshot yields nothing new", () => {
    const messages = [user("ask"), assistant("reply")];
    const first = extractLatestTurn(messages, 0);
    expect(first.userText).toBe("ask");
    const second = extractLatestTurn(messages, first.nextCursor);
    expect(second).toEqual({ nextCursor: 2 });
  });

  it("advances the cursor even when extraction fails", () => {
    const result = extractLatestTurn([assistant("no user turn")], 0);
    expect(result).toEqual({ nextCursor: 1 });
  });

  it("treats a cursor beyond the snapshot as 0 (compaction reset)", () => {
    const messages = [user("ask"), assistant("reply")];
    const result = extractLatestTurn(messages, 10);
    expect(result).toEqual({ userText: "ask", assistantText: "reply", nextCursor: 2 });
  });

  it("bounds userText to 2000 chars and assistantText to 4000 chars", () => {
    const longUser = "u".repeat(3000);
    const longAssistant = "a".repeat(3000);
    const result = extractLatestTurn(
      [user(longUser), assistant(longAssistant), assistant(longAssistant)],
      0,
    );
    expect(result.userText).toHaveLength(2000);
    expect(result.assistantText).toHaveLength(4000);
  });
});

describe("createSessionCursorTracker", () => {
  const turn = [user("ask"), assistant("reply")];

  it("advances per session and yields nothing on a repeat snapshot", () => {
    const tracker = createSessionCursorTracker();
    expect(tracker.advance("s1", turn)).toEqual({ userText: "ask", assistantText: "reply" });
    expect(tracker.advance("s1", turn)).toEqual({ userText: undefined, assistantText: undefined });
    expect(tracker.size()).toBe(1);
  });

  it("extracts only the new tail when the snapshot grows", () => {
    const tracker = createSessionCursorTracker();
    tracker.advance("s1", turn);
    const grown = [...turn, user("next"), assistant("next reply")];
    expect(tracker.advance("s1", grown)).toEqual({
      userText: "next",
      assistantText: "next reply",
    });
  });

  it("clear resets the cursor so the session reprocesses from the start", () => {
    const tracker = createSessionCursorTracker();
    tracker.advance("s1", turn);
    tracker.clear("s1");
    expect(tracker.size()).toBe(0);
    expect(tracker.advance("s1", turn)).toEqual({ userText: "ask", assistantText: "reply" });
  });

  it("recovers when compaction shrinks the snapshot below the stored cursor", () => {
    const tracker = createSessionCursorTracker();
    tracker.advance("s1", [...turn, user("more"), assistant("more reply")]);
    expect(tracker.advance("s1", turn)).toEqual({ userText: "ask", assistantText: "reply" });
  });

  it("rescans when compaction rewrites the snapshot without shrinking it", () => {
    const tracker = createSessionCursorTracker();
    tracker.advance("s1", [
      user("old one"),
      assistant("old reply"),
      user("ask"),
      assistant("reply"),
    ]);
    // Compaction replaced the history with a same-length snapshot whose tail
    // differs; the fingerprint mismatch must force a rescan instead of a skip.
    const rewritten = [
      user("summary of earlier context"),
      assistant("summary ack"),
      user("fresh question"),
      assistant("fresh answer"),
    ];
    expect(tracker.advance("s1", rewritten)).toEqual({
      userText: "fresh question",
      assistantText: "fresh answer",
    });
  });

  it("treats a same-length identical tail as already processed", () => {
    const tracker = createSessionCursorTracker();
    const snapshot = [user("ask"), assistant("reply")];
    tracker.advance("s1", snapshot);
    expect(tracker.advance("s1", [user("ask"), assistant("reply")])).toEqual({
      userText: undefined,
      assistantText: undefined,
    });
  });

  it("evicts the oldest sessions beyond 200 but keeps recently-advanced keys", () => {
    const tracker = createSessionCursorTracker();
    for (let index = 0; index < 200; index++) {
      tracker.advance(`s${index}`, turn);
    }
    // Re-advance s0 so it becomes the most recently active session.
    tracker.advance("s0", turn);
    tracker.advance("s200", turn);
    expect(tracker.size()).toBe(200);
    // s1 was the oldest and got evicted: its cursor is gone, so the turn reappears.
    expect(tracker.advance("s1", turn)).toEqual({ userText: "ask", assistantText: "reply" });
    // s0 kept its cursor, so the same snapshot yields nothing.
    expect(tracker.advance("s0", turn)).toEqual({ userText: undefined, assistantText: undefined });
  });
});
