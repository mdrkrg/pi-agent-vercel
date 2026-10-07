import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ChatApi } from "./api.ts";
import { createChat } from "./chat.ts";
import { loadConversation, saveConversation, STORAGE_KEY } from "./storage.ts";

beforeEach(() => sessionStorage.clear());
function setup() {
  const api = new ChatApi();
  const create = vi.spyOn(api, "createSession").mockResolvedValue({ session: { id: "session" } });
  const submit = vi.spyOn(api, "submit").mockResolvedValue({ submission: { id: "submission" } });
  const uuid = vi.fn().mockReturnValue("key-1");
  const chat = createChat(api, sessionStorage, uuid);
  chat.setToken("secret-token");
  return { api, create, submit, uuid, chat };
}
describe("durable browser request identity", () => {
  it("persists before sending and recovers a lost response without changing key or payload", async () => {
    const { api, chat, submit, uuid } = setup();
    await chat.newSession();
    chat.setDraft(" exact original prompt ");
    submit.mockImplementationOnce(async () => {
      expect(loadConversation(sessionStorage).turns[0]).toMatchObject({
        key: "key-1",
        prompt: " exact original prompt ",
      });
      throw new Error("Lost HTTP response");
    });
    await chat.send();
    expect(get(chat.state).turns[0]?.submissionId).toBeUndefined();
    const restored = createChat(api, sessionStorage, uuid);
    expect(get(restored.state).token).toBe("");
    restored.setToken("secret-token");
    await restored.send();
    expect(submit).toHaveBeenCalledTimes(2);
    for (const args of submit.mock.calls)
      expect(args.slice(0, 4)).toEqual([
        "session",
        "key-1",
        " exact original prompt ",
        "secret-token",
      ]);
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(get(restored.state).turns).toEqual([
      {
        key: "key-1",
        prompt: " exact original prompt ",
        submissionId: "submission",
        terminal: false,
      },
    ]);
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toContain("secret-token");
  });
  it("serializes turns and reuses the session with a fresh key after settlement", async () => {
    const { chat, submit, uuid } = setup();
    await chat.newSession();
    chat.setDraft("first");
    await chat.send();
    chat.setDraft("second");
    await chat.send();
    await chat.newSession();
    expect(submit).toHaveBeenCalledTimes(1);
    chat.settled("key-1");
    uuid.mockReturnValue("key-2");
    await chat.send();
    expect(submit.mock.calls[1]?.slice(0, 4)).toEqual([
      "session",
      "key-2",
      "second",
      "secret-token",
    ]);
    expect(get(chat.state).turns[0]).toMatchObject({
      key: "key-1",
      terminal: true,
      submissionId: "submission",
    });
  });
  it("does not blindly retry session creation or drop an existing conversation on failure", async () => {
    const { chat, create } = setup();
    await chat.newSession();
    create.mockRejectedValueOnce(new Error("response lost"));
    await chat.newSession();
    expect(create).toHaveBeenCalledTimes(2);
    expect(get(chat.state).sessionId).toBe("session");
    expect(get(chat.state).notice).toContain("A chat may have been created");
  });
  it("clears invalid auth but preserves the exact uncertain submission for retry", async () => {
    const { chat, submit } = setup();
    await chat.newSession();
    chat.setDraft("prompt");
    submit.mockRejectedValueOnce(new ApiError(401));
    await chat.send();
    expect(get(chat.state).token).toBe("");
    expect(loadConversation(sessionStorage).turns[0]?.key).toBe("key-1");
    chat.setToken("new-token");
    await chat.send();
    expect(submit.mock.calls[1]?.slice(0, 4)).toEqual(["session", "key-1", "prompt", "new-token"]);
  });
  it("ignores late mutation responses after clearing without issuing a user abort", async () => {
    const { chat, create } = setup();
    let resolve!: (response: { session: { id: string } }) => void;
    create.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = chat.newSession();
    chat.clear();
    resolve({ session: { id: "late-session" } });
    await pending;
    expect(get(chat.state)).toMatchObject({ token: "", turns: [], busy: false });
    expect(get(chat.state).sessionId).toBeUndefined();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
  it("makes unavailable storage explicit and clears safely if storage access throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    const chat = createChat(new ChatApi(), storage);
    chat.setDraft("draft");
    expect(get(chat.state).storageWarning).toBe(true);
    expect(() => chat.clear()).not.toThrow();
    expect(get(chat.state).storageWarning).toBe(true);
  });
});
describe("snapshot allowlist", () => {
  it("does not persist credentials or results even if the input object contains them", () => {
    const data = {
      sessionId: "session",
      draft: "draft",
      token: "never-store-token",
      result: "never-store-output",
      turns: [
        {
          key: "key",
          prompt: "prompt",
          submissionId: "id",
          terminal: true,
          output: "never-store-output",
        },
      ],
    };
    expect(saveConversation(sessionStorage, data)).toBe(true);
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toContain("never-store");
  });
  it("fails closed for malformed snapshots and invalid turn order", () => {
    for (const value of [
      null,
      {},
      { version: 1, draft: "", turns: [{ key: "k", prompt: "p", terminal: true }] },
      {
        version: 1,
        draft: "",
        sessionId: "s",
        turns: [
          { key: "a", prompt: "p", terminal: false },
          { key: "b", prompt: "p", terminal: false },
        ],
      },
    ]) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      expect(loadConversation(sessionStorage)).toEqual({ draft: "", turns: [] });
    }
  });
});
