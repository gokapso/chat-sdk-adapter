# @kapso/chat-adapter

Kapso-first WhatsApp adapter for [Chat SDK](https://chat-sdk.dev). Use it when
an agent needs to receive Kapso WhatsApp webhooks, reply through Chat SDK
threads, send cards/buttons, send or receive media, and read Kapso conversation
history.

This package should be understood as a Kapso adapter. WhatsApp Cloud API details
are implementation details of `@kapso/whatsapp-cloud-api`; they are not the
primary integration surface.

## Install

```bash
npm install chat @kapso/chat-adapter @chat-adapter/state-memory
```

For production, use a durable Chat SDK state adapter instead of
`@chat-adapter/state-memory`.

## Quick Start

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createKapsoAdapter } from "@kapso/chat-adapter";

export const bot = new Chat({
  userName: "support",
  state: createMemoryState(),
  adapters: {
    kapso: createKapsoAdapter(),
  },
});

bot.onDirectMessage(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});
```

## Environment

These are the default Kapso-first variables:

| Variable | Required | Description |
| --- | --- | --- |
| `KAPSO_API_KEY` | Yes | Kapso API key used for sends, history, contacts, conversations, and media. |
| `KAPSO_PHONE_NUMBER_ID` | Recommended | WhatsApp phone number ID connected in Kapso. Required for `openDM()` and useful as a webhook fallback. |
| `KAPSO_WEBHOOK_SECRET` | Recommended | Secret used to verify Kapso `X-Webhook-Signature` webhook deliveries. |
| `KAPSO_BASE_URL` | No | Kapso proxy URL. Defaults to `https://api.kapso.ai/meta/whatsapp`. |
| `KAPSO_BOT_USERNAME` | No | Bot display name. Defaults to the Chat SDK `userName` after initialization. |

Explicit config uses the same names:

```ts
createKapsoAdapter({
  kapsoApiKey: process.env.KAPSO_API_KEY,
  phoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID,
  webhookSecret: process.env.KAPSO_WEBHOOK_SECRET,
});
```

## Webhook Route

Kapso platform webhooks are `POST` requests. Forward the raw `Request` to Chat
SDK:

```ts
import { bot } from "@/lib/bot";

export async function POST(request: Request): Promise<Response> {
  return bot.webhooks.kapso(request);
}
```

Configure the Kapso webhook with:

| Kapso webhook setting | Value |
| --- | --- |
| Endpoint URL | Your public `POST` route, for example `https://app.example.com/webhooks/kapso` |
| Secret key | Same value as `KAPSO_WEBHOOK_SECRET` |
| Events | `whatsapp.message.received`; add `whatsapp.message.sent` only if your app needs sent-message echoes |

The adapter verifies `X-Webhook-Signature` by default. For local unsigned
fixtures only:

```ts
createKapsoAdapter({
  kapsoApiKey: "test-key",
  verifyWebhookSignatures: false,
});
```

## Agent Checklist

1. Install `chat`, `@kapso/chat-adapter`, and a Chat SDK state adapter.
2. Set `KAPSO_API_KEY`.
3. Set `KAPSO_PHONE_NUMBER_ID` if the agent will initiate outbound DMs.
4. Set `KAPSO_WEBHOOK_SECRET` and use the same secret in Kapso webhook settings.
5. Create one shared `Chat` instance with `createKapsoAdapter()`.
6. Add a public `POST` route that calls `bot.webhooks.kapso(request)`.
7. Use `bot.onDirectMessage()` for incoming WhatsApp conversations.
8. Use `thread.post()` for replies, cards, buttons, and media.

## Sending Messages

Reply inside a handler:

```ts
bot.onDirectMessage(async (thread, message) => {
  await thread.post({
    markdown: `Received: **${message.text}**`,
  });
});
```

Start a WhatsApp conversation from your app:

```ts
import type { KapsoAdapter } from "@kapso/chat-adapter";

const adapter = bot.getAdapter("kapso") as KapsoAdapter;
const threadId = await adapter.openDM("15551234567");
const thread = bot.thread(threadId);

await thread.post("Hello from Kapso.");
```

## Buttons

Chat SDK cards with buttons become WhatsApp reply buttons.

```tsx
import { Actions, Button, Card } from "chat";

await thread.post(
  Card({
    title: "Approve refund?",
    children: [
      Actions([
        Button({ id: "approve", label: "Approve", value: "refund-123" }),
        Button({ id: "reject", label: "Reject", value: "refund-123" }),
      ]),
    ],
  }),
);
```

Handle button clicks:

```ts
bot.onAction("approve", async (action) => {
  await action.thread?.post(`Approved ${action.value}`);
});
```

WhatsApp supports up to 3 reply buttons. Button labels must be 1-20 characters.
The adapter throws a validation error instead of silently truncating labels or
dropping buttons.

## Media

Send files through Chat SDK:

```ts
await thread.post({
  markdown: "Here is the receipt.",
  files: [
    {
      filename: "receipt.pdf",
      mimeType: "application/pdf",
      data: await fs.promises.readFile("receipt.pdf"),
    },
  ],
});
```

Inbound media is exposed as Chat SDK attachments. When Kapso includes a mirrored
media URL, the attachment has `url`. When a WhatsApp media ID is available, the
attachment has lazy `fetchData()`.

## History

With `KAPSO_API_KEY`, history reads from Kapso:

```ts
const page = await thread.adapter.fetchMessages(thread.id, { limit: 20 });
```

`fetchThread()` enriches metadata with Kapso contact and conversation records
when available.

## Thread IDs

Current thread IDs are encoded as:

```text
kapso:<base64url(phoneNumberId)>:<base64url(waId)>[:<base64url(conversationId)>]
```

Use helpers instead of constructing them manually:

```ts
const threadId = adapter.encodeThreadId({
  phoneNumberId: "16315558151",
  waId: "15551234567",
});

const decoded = adapter.decodeThreadId(threadId);
```

## Supported

| Feature | Support |
| --- | --- |
| Kapso platform webhooks | Yes, `POST` with `X-Webhook-Signature` |
| Batched Kapso webhook payloads | Yes, when Kapso sends `data: [...]` |
| Text send/receive | Yes |
| Markdown formatting | Basic WhatsApp-compatible formatting |
| Cards/buttons | Up to 3 reply buttons |
| CTA URL card button | Yes |
| Media send/receive | Images, video, audio, documents, stickers |
| Reactions | Add/remove and inbound reaction events |
| Message history | Kapso messages/conversations APIs |
| Contact/thread metadata | Kapso contacts/conversations when available |

## Not A Priority For V1

These are not the default design target. Add them only when a Kapso user asks
for them:

| Area | Current stance |
| --- | --- |
| Direct Meta setup | Compatibility path only, not the recommended setup. |
| Meta `GET` webhook verification | Compatibility path only. Kapso platform webhooks are preferred. |
| Raw WhatsApp templates, flows, catalogs | Use `@kapso/whatsapp-cloud-api` directly alongside this adapter. |
| Message edit/delete | Not supported by WhatsApp/Kapso for recipient devices. |

## Advanced Kapso SDK Usage

For APIs outside Chat SDK's adapter surface, create a shared
`WhatsAppClient` and pass it into the adapter:

```ts
import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { createKapsoAdapter } from "@kapso/chat-adapter";

const whatsapp = new WhatsAppClient({
  baseUrl: "https://api.kapso.ai/meta/whatsapp",
  kapsoApiKey: process.env.KAPSO_API_KEY!,
});

export const kapso = createKapsoAdapter({
  client: whatsapp,
  phoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID,
  webhookSecret: process.env.KAPSO_WEBHOOK_SECRET,
});
```

## Troubleshooting

| Problem | Check |
| --- | --- |
| Missing credentials | Set `KAPSO_API_KEY` or pass `kapsoApiKey`. |
| Webhook returns 401 | `KAPSO_WEBHOOK_SECRET` must match the Kapso webhook secret key. |
| Webhook returns 405 | Kapso should call your route with `POST`. |
| Messages do not arrive | Enable `whatsapp.message.received` on the Kapso webhook. |
| `openDM()` throws | Set `KAPSO_PHONE_NUMBER_ID` or pass `phoneNumberId`. |
| Button send fails | Use no more than 3 buttons and labels between 1 and 20 characters. |
| History is incomplete | Confirm the number and contact have Kapso conversation history. |

## Development

```bash
npm run typecheck
npm test
npm run build
```

## License

MIT
