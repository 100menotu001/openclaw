// Defensive extraction of the latest user/assistant turn from a full session
// message snapshot. Messages arrive as unknown[] from the agent_end hook.

const MAX_USER_TEXT_CHARS = 2000;
const MAX_ASSISTANT_TEXT_CHARS = 4000;
const MAX_TRACKED_SESSIONS = 200;

export type LatestTurn = {
  userText?: string;
  assistantText?: string;
  nextCursor: number;
};

export type SessionCursorTracker = {
  advance(sessionKey: string, messages: unknown[]): { userText?: string; assistantText?: string };
  clear(sessionKey: string): void;
  size(): number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageRole(message: unknown): string | undefined {
  const record = asRecord(message);
  return record && typeof record.role === "string" ? record.role : undefined;
}

/** Extracts trimmed text from string content or text blocks; unknown blocks are ignored. */
function messageText(message: unknown): string {
  const record = asRecord(message);
  if (!record) {
    return "";
  }
  const content = record.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const texts: string[] = [];
  for (const block of content) {
    const blockRecord = asRecord(block);
    if (blockRecord?.type === "text" && typeof blockRecord.text === "string") {
      texts.push(blockRecord.text);
    }
  }
  return texts.join("\n").trim();
}

/**
 * Finds the latest turn in the unprocessed tail: the last user message with
 * nonempty text plus every assistant message after it. nextCursor always
 * advances to the full snapshot length so a turn is never processed twice.
 */
export function extractLatestTurn(messages: unknown[], cursor: number): LatestTurn {
  const nextCursor = messages.length;
  // Cursor beyond the snapshot means compaction/reset shrank it; reprocess from 0.
  const start = cursor >= 0 && cursor <= messages.length ? cursor : 0;
  const tail = messages.slice(start);

  let userIndex = -1;
  let userText = "";
  for (let index = tail.length - 1; index >= 0; index--) {
    if (messageRole(tail[index]) !== "user") {
      continue;
    }
    const text = messageText(tail[index]);
    if (text) {
      userIndex = index;
      userText = text;
      break;
    }
  }
  if (userIndex < 0) {
    return { nextCursor };
  }

  const assistantParts: string[] = [];
  for (let index = userIndex + 1; index < tail.length; index++) {
    if (messageRole(tail[index]) !== "assistant") {
      continue;
    }
    const text = messageText(tail[index]);
    if (text) {
      assistantParts.push(text);
    }
  }
  const assistantText = assistantParts.join("\n");
  if (!assistantText) {
    return { nextCursor };
  }

  return {
    userText: userText.slice(0, MAX_USER_TEXT_CHARS),
    assistantText: assistantText.slice(0, MAX_ASSISTANT_TEXT_CHARS),
    nextCursor,
  };
}

/** Cheap identity of the last processed message so a rewritten snapshot is detectable. */
function fingerprintAt(messages: unknown[], cursor: number): string {
  if (cursor <= 0 || cursor > messages.length) {
    return "";
  }
  const message = messages[cursor - 1];
  return `${messageRole(message) ?? "?"}:${messageText(message).slice(0, 64)}`;
}

type CursorState = { cursor: number; fingerprint: string };

/** In-memory per-session cursor store; bounded so abandoned sessions cannot leak. */
export function createSessionCursorTracker(): SessionCursorTracker {
  const cursors = new Map<string, CursorState>();
  return {
    advance(sessionKey, messages) {
      const state = cursors.get(sessionKey);
      // Compaction can rewrite the snapshot without shrinking it below the stored
      // cursor; a fingerprint mismatch at cursor-1 means the tail is not a pure
      // append, so rescan from the start rather than silently skipping the turn.
      const cursor =
        state !== undefined && fingerprintAt(messages, state.cursor) === state.fingerprint
          ? state.cursor
          : 0;
      const { userText, assistantText, nextCursor } = extractLatestTurn(messages, cursor);
      // Delete-then-set keeps Map insertion order equal to recency so the
      // eviction below drops the longest-idle sessions first.
      cursors.delete(sessionKey);
      cursors.set(sessionKey, {
        cursor: nextCursor,
        fingerprint: fingerprintAt(messages, nextCursor),
      });
      while (cursors.size > MAX_TRACKED_SESSIONS) {
        const oldest = cursors.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        cursors.delete(oldest);
      }
      return { userText, assistantText };
    },
    clear(sessionKey) {
      cursors.delete(sessionKey);
    },
    size() {
      return cursors.size;
    },
  };
}
