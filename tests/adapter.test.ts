import { Actions, Button, Card, Chat, NotImplementedError } from "chat";
import { createHmac } from "node:crypto";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createMockChatInstance } from "@chat-adapter/tests";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createKapsoAdapter,
  decodeKapsoActionId,
  encodeKapsoActionId,
  KapsoFormatConverter,
  toStandardMarkdown,
} from "../src";

const sendPayload = {
  messaging_product: "whatsapp",
  contacts: [{ input: "15551234567", wa_id: "15551234567" }],
  messages: [{ id: "wamid.out" }],
};

describe("KapsoAdapter configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllEnvs();
  });

  it("creates an adapter with explicit credentials", () => {
    const adapter = createKapsoAdapter({ kapsoApiKey: "key" });
    expect(adapter.name).toBe("kapso");
  });

  it("creates an adapter from environment credentials", () => {
    vi.stubEnv("KAPSO_API_KEY", "key");
    const adapter = createKapsoAdapter();
    expect(adapter.name).toBe("kapso");
  });

  it("uses Kapso-first environment aliases", async () => {
    vi.stubEnv("KAPSO_API_KEY", "key");
    vi.stubEnv("KAPSO_PHONE_NUMBER_ID", "123");
    vi.stubEnv("KAPSO_WEBHOOK_SECRET", "secret");
    vi.stubEnv("KAPSO_BOT_USERNAME", "support");
    const adapter = createKapsoAdapter();

    await expect(adapter.openDM("15551234567")).resolves.toBe(
      adapter.encodeThreadId({
        phoneNumberId: "123",
        waId: "15551234567",
      }),
    );
  });

  it("rejects missing send credentials", () => {
    expect(() => createKapsoAdapter()).toThrow(/Must provide either/);
  });

  it("emits opt-in debug diagnostics through the configured logger", async () => {
    const { fetchMock } = setupFetch([sendPayload]);
    const logger = createTestLogger();
    const adapter = createKapsoAdapter({
      accessToken: "token",
      fetch: fetchMock,
      logger,
      debug: true,
    });
    const threadId = adapter.encodeThreadId({
      phoneNumberId: "123",
      waId: "15551234567",
    });

    await adapter.postMessage(threadId, "hello");

    expect(logger.info).toHaveBeenCalledWith(
      "[debug] adapter constructed",
      expect.objectContaining({ verifyWebhookSignatures: true }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "[debug] postMessage start",
      expect.objectContaining({ threadId, files: 0, attachments: 0 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "[debug] postMessage text sent",
      expect.objectContaining({ threadId, messageId: "wamid.out" }),
    );
  });
});

describe("Kapso thread and action IDs", () => {
  const adapter = createKapsoAdapter({ accessToken: "token" });

  it("round-trips encoded thread IDs", () => {
    const thread = {
      phoneNumberId: "16315558151",
      waId: "15551234567",
      conversationId: "conv-1",
    };

    const encoded = adapter.encodeThreadId(thread);
    expect(encoded).toMatch(/^kapso:/);
    expect(adapter.decodeThreadId(encoded)).toEqual(thread);
    expect(adapter.channelIdFromThreadId(encoded)).toMatch(/^kapso:/);
  });

  it("rejects invalid thread IDs", () => {
    expect(() => adapter.decodeThreadId("slack:C:t")).toThrow(/Invalid Kapso/);
  });

  it("round-trips button action IDs", () => {
    const encoded = encodeKapsoActionId("approve", "refund-123");
    expect(decodeKapsoActionId(encoded)).toEqual({
      actionId: "approve",
      value: "refund-123",
    });
    expect(decodeKapsoActionId("approve")).toEqual({
      actionId: "approve",
      value: undefined,
    });
  });
});

describe("Kapso webhooks", () => {
  it("dispatches signed Kapso platform webhooks through processMessage", async () => {
    const chat = createMockChatInstance();
    const adapter = createKapsoAdapter({
      kapsoApiKey: "key",
      phoneNumberId: "123",
      webhookSecret: "secret",
    });
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      kapsoSignedRequest(kapsoMessageReceivedPayload("Hello"), "secret"),
    );

    expect(response.status).toBe(200);
    expect(chat.processMessage).toHaveBeenCalledOnce();
    const [, threadId, message] = vi.mocked(chat.processMessage).mock.calls[0];
    expect(threadId).toBe(
      adapter.encodeThreadId({
        phoneNumberId: "123",
        waId: "15551234567",
        conversationId: "conv-1",
      }),
    );
    expect(message).toMatchObject({
      id: "wamid.kapso",
      text: "Hello",
      author: {
        userId: "15551234567",
        userName: "Jane Doe",
        isMe: false,
      },
    });
  });

  it("rejects Kapso platform webhooks with invalid signatures", async () => {
    const chat = createMockChatInstance();
    const adapter = createKapsoAdapter({
      kapsoApiKey: "key",
      phoneNumberId: "123",
      webhookSecret: "secret",
    });
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      new Request("https://example.com/webhook", {
        method: "POST",
        headers: {
          "x-webhook-event": "whatsapp.message.received",
          "x-webhook-signature": "bad",
        },
        body: JSON.stringify(kapsoMessageReceivedPayload("Hello")),
      }),
    );

    expect(response.status).toBe(401);
    expect(chat.processMessage).not.toHaveBeenCalled();
  });

  it("handles Meta GET verification challenge", async () => {
    const adapter = createKapsoAdapter({
      accessToken: "token",
      webhookVerifyToken: "verify-me",
    });

    const response = await adapter.handleWebhook(
      new Request(
        "https://example.com/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=CHALLENGE",
        { method: "GET" },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("CHALLENGE");
  });

  it("rejects unsigned POST webhooks by default", async () => {
    const adapter = createKapsoAdapter({
      accessToken: "token",
      appSecret: "secret",
    });

    const response = await adapter.handleWebhook(
      new Request("https://example.com/webhook", {
        method: "POST",
        body: JSON.stringify({ entry: [] }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("rejects invalid JSON when signature verification is disabled", async () => {
    const adapter = createKapsoAdapter({
      accessToken: "token",
      verifyWebhookSignatures: false,
    });

    const response = await adapter.handleWebhook(
      new Request("https://example.com/webhook", {
        method: "POST",
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("dispatches signed text webhooks through processMessage", async () => {
    const chat = createMockChatInstance();
    const adapter = createKapsoAdapter({
      accessToken: "token",
      appSecret: "secret",
    });
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      signedRequest(textPayload("Hello"), "secret"),
    );

    expect(response.status).toBe(200);
    expect(chat.processMessage).toHaveBeenCalledOnce();
    const [, threadId, message] = vi.mocked(chat.processMessage).mock.calls[0];
    expect(threadId).toBe(
      adapter.encodeThreadId({
        phoneNumberId: "16315558151",
        waId: "15551234567",
      }),
    );
    expect(message).toMatchObject({
      id: "wamid.text",
      text: "Hello",
      author: { userId: "15551234567", isMe: false },
    });
  });

  it("dispatches interactive replies through processAction", async () => {
    const chat = createMockChatInstance();
    const adapter = createKapsoAdapter({
      accessToken: "token",
      verifyWebhookSignatures: false,
    });
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      unsignedRequest(interactivePayload("approve\nrefund-123")),
    );

    expect(response.status).toBe(200);
    expect(chat.processAction).toHaveBeenCalledOnce();
    expect(vi.mocked(chat.processAction).mock.calls[0][0]).toMatchObject({
      actionId: "approve",
      value: "refund-123",
      messageId: "wamid.original",
      user: { userId: "15551234567" },
    });
  });

  it("dispatches reactions through processReaction", async () => {
    const chat = createMockChatInstance();
    const adapter = createKapsoAdapter({
      accessToken: "token",
      verifyWebhookSignatures: false,
    });
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      unsignedRequest(reactionPayload()),
    );

    expect(response.status).toBe(200);
    expect(chat.processReaction).toHaveBeenCalledOnce();
    expect(vi.mocked(chat.processReaction).mock.calls[0][0]).toMatchObject({
      added: true,
      messageId: "wamid.original",
      rawEmoji: "👍",
      threadId: adapter.encodeThreadId({
        phoneNumberId: "16315558151",
        waId: "15551234567",
      }),
    });
  });
});

describe("Kapso message parsing", () => {
  it("parses inbound text and media messages", () => {
    const adapter = createKapsoAdapter({
      accessToken: "token",
      phoneNumberId: "16315558151",
    });

    const text = adapter.parseMessage({
      id: "wamid.1",
      from: "15551234567",
      timestamp: "1735689600",
      type: "text",
      text: { body: "*Bold*" },
    });
    expect(text.text).toBe("*Bold*");
    expect(text.author.isMe).toBe(false);
    expect(toStandardMarkdown(text.text)).toContain("**Bold**");

    const media = adapter.parseMessage({
      id: "wamid.2",
      from: "15551234567",
      timestamp: "1735689610",
      type: "image",
      image: { id: "MEDIA_ID", caption: "Receipt" },
      kapso: { mediaUrl: "https://cdn.example.com/image.jpg" },
    });
    expect(media.attachments[0]).toMatchObject({
      type: "image",
      url: "https://cdn.example.com/image.jpg",
      fetchMetadata: {
        mediaId: "MEDIA_ID",
        phoneNumberId: "16315558151",
      },
    });
  });

  it("marks outbound echoes as messages from self", () => {
    const adapter = createKapsoAdapter({
      accessToken: "token",
      phoneNumberId: "16315558151",
    });

    const message = adapter.parseMessage({
      id: "wamid.echo",
      from: "16315558151",
      to: "15551234567",
      timestamp: "1735689600",
      type: "text",
      text: { body: "Outbound" },
      kapso: { direction: "outbound" },
    });

    expect(message.author).toMatchObject({
      userId: "16315558151",
      isBot: true,
      isMe: true,
    });
  });
});

describe("Kapso outbound sends", () => {
  it("sends text messages", async () => {
    const { fetchMock, calls } = setupFetch([sendPayload]);
    const adapter = createKapsoAdapter({
      accessToken: "token",
      fetch: fetchMock,
    });
    const threadId = adapter.encodeThreadId({
      phoneNumberId: "123",
      waId: "15551234567",
    });

    const result = await adapter.postMessage(threadId, {
      markdown: "**Hello**",
    });

    expect(result.id).toBe("wamid.out");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      type: "text",
      text: { body: "*Hello*" },
      to: "15551234567",
    });
  });

  it("sends cards as WhatsApp reply buttons", async () => {
    const { fetchMock, calls } = setupFetch([sendPayload]);
    const adapter = createKapsoAdapter({
      accessToken: "token",
      fetch: fetchMock,
    });
    const threadId = adapter.encodeThreadId({
      phoneNumberId: "123",
      waId: "15551234567",
    });

    await adapter.postMessage(
      threadId,
      Card({
        title: "Refund",
        children: [
          Actions([
            Button({ id: "approve", label: "Approve", value: "refund-1" }),
            Button({ id: "reject", label: "Reject", value: "refund-1" }),
          ]),
        ],
      }),
    );

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      type: "interactive",
      interactive: {
        type: "button",
        action: {
          buttons: [
            {
              type: "reply",
              reply: { id: "approve\nrefund-1", title: "Approve" },
            },
            {
              type: "reply",
              reply: { id: "reject\nrefund-1", title: "Reject" },
            },
          ],
        },
      },
    });
  });

  it("uploads and sends media files", async () => {
    const { fetchMock, calls } = setupFetch([{ id: "MEDIA_ID" }, sendPayload]);
    const adapter = createKapsoAdapter({
      accessToken: "token",
      fetch: fetchMock,
    });
    const threadId = adapter.encodeThreadId({
      phoneNumberId: "123",
      waId: "15551234567",
    });

    await adapter.postMessage(threadId, {
      markdown: "Invoice",
      files: [
        {
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          data: Buffer.from("pdf"),
        },
      ],
    });

    expect(calls[0]?.init.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({
      type: "document",
      document: {
        id: "MEDIA_ID",
        caption: "Invoice",
        filename: "invoice.pdf",
      },
    });
  });

  it("sends and removes reactions", async () => {
    const { fetchMock, calls } = setupFetch([sendPayload, sendPayload]);
    const adapter = createKapsoAdapter({
      accessToken: "token",
      fetch: fetchMock,
    });
    const threadId = adapter.encodeThreadId({
      phoneNumberId: "123",
      waId: "15551234567",
    });

    await adapter.addReaction(threadId, "wamid.target", "👍");
    await adapter.removeReaction(threadId, "wamid.target", "👍");

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      type: "reaction",
      reaction: { message_id: "wamid.target", emoji: "👍" },
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({
      type: "reaction",
      reaction: { message_id: "wamid.target" },
    });
  });

  it("throws explicit unsupported-operation errors", async () => {
    const adapter = createKapsoAdapter({ accessToken: "token" });
    await expect(
      adapter.editMessage("thread", "msg", "updated"),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.deleteMessage("thread", "msg")).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

describe("Kapso history and integration", () => {
  it("fetches Kapso proxy history", async () => {
    const { fetchMock } = setupKapsoHistoryFetch();
    const adapter = createKapsoAdapter({
      kapsoApiKey: "key",
      fetch: fetchMock,
    });
    const threadId = adapter.encodeThreadId({
      phoneNumberId: "123",
      waId: "15551234567",
    });

    const page = await adapter.fetchMessages(threadId, { limit: 10 });

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].text).toBe("From history");
    expect(page.nextCursor).toBeUndefined();
  });

  it("runs through a real Chat instance and posts a response", async () => {
    const { fetchMock, calls } = setupFetch([sendPayload]);
    const adapter = createKapsoAdapter({
      accessToken: "token",
      appSecret: "secret",
      fetch: fetchMock,
    });
    const bot = new Chat({
      userName: "support",
      state: createMemoryState(),
      adapters: { kapso: adapter },
    });
    bot.onNewMention(async (thread, message) => {
      await thread.post(`Echo: ${message.text}`);
    });

    const tasks: Promise<unknown>[] = [];
    const response = await bot.webhooks.kapso(
      signedRequest(textPayload("Hi"), "secret"),
      { waitUntil: (task) => tasks.push(task) },
    );
    await Promise.all(tasks);

    expect(response.status).toBe(200);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      type: "text",
      text: { body: "Echo: Hi" },
    });
  });
});

describe("KapsoFormatConverter", () => {
  it("converts markdown to WhatsApp formatting", () => {
    const converter = new KapsoFormatConverter();
    expect(converter.fromMarkdown("**Bold** and *soft*")).toBe(
      "*Bold* and _soft_",
    );
    expect(converter.toMarkdown("*Bold*")).toContain("**Bold**");
  });
});

function signedRequest(payload: unknown, secret: string): Request {
  const body = JSON.stringify(payload);
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${digest}` },
    body,
  });
}

function kapsoSignedRequest(payload: unknown, secret: string): Request {
  const body = JSON.stringify(payload);
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: {
      "x-webhook-event": "whatsapp.message.received",
      "x-webhook-signature": digest,
    },
    body,
  });
}

function unsignedRequest(payload: unknown): Request {
  return new Request("https://example.com/webhook", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function textPayload(body: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              metadata: {
                display_phone_number: "+1 631-555-8151",
                phone_number_id: "16315558151",
              },
              contacts: [
                { profile: { name: "Jane Doe" }, wa_id: "15551234567" },
              ],
              messages: [
                {
                  from: "15551234567",
                  id: "wamid.text",
                  timestamp: "1735689600",
                  type: "text",
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function kapsoMessageReceivedPayload(body: string) {
  return {
    event: "whatsapp.message.received",
    phone_number_id: "123",
    conversation: {
      id: "conv-1",
      phone_number: "+1 (555) 123-4567",
      phone_number_id: "123",
      kapso: { contact_name: "Jane Doe" },
    },
    message: {
      from: "15551234567",
      id: "wamid.kapso",
      timestamp: "1735689600",
      type: "text",
      text: { body },
      kapso: {
        direction: "inbound",
        content: body,
      },
    },
  };
}

function interactivePayload(id: string) {
  const payload = textPayload("");
  const value = payload.entry[0].changes[0].value as any;
  value.messages = [
    {
      from: "15551234567",
      id: "wamid.button",
      timestamp: "1735689601",
      type: "interactive",
      context: { id: "wamid.original" },
      interactive: {
        type: "button_reply",
        button_reply: { id, title: "Approve" },
      },
    },
  ];
  return payload;
}

function reactionPayload() {
  const payload = textPayload("");
  const value = payload.entry[0].changes[0].value as any;
  value.messages = [
    {
      from: "15551234567",
      id: "wamid.reaction",
      timestamp: "1735689602",
      type: "reaction",
      reaction: { message_id: "wamid.original", emoji: "👍" },
    },
  ];
  return payload;
}

function setupFetch(payloads: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...payloads];
  const fetchMock: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(queue.shift() ?? sendPayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchMock, calls } as const;
}

function setupKapsoHistoryFetch() {
  const fetchMock: typeof fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/conversations")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "conv-1",
              phone_number: "15551234567",
              phone_number_id: "123",
            },
          ],
          paging: {
            cursors: { before: null, after: null },
            next: null,
            previous: null,
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        data: [
          {
            id: "wamid.history",
            from: "15551234567",
            type: "text",
            timestamp: "1735689600",
            text: { body: "From history" },
          },
        ],
        paging: {
          cursors: { before: null, after: null },
          next: null,
          previous: null,
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetchMock } as const;
}

function createTestLogger() {
  const logger = {
    child: vi.fn(() => logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}
