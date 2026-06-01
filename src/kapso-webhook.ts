import type { UnifiedMessage } from "@kapso/whatsapp-cloud-api";
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

const KAPSO_MESSAGE_RECEIVED_EVENT = "whatsapp.message.received";

export interface NormalizedWebhookResult {
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  contacts: Array<Record<string, unknown>>;
  messages: UnifiedMessage[];
  statuses: Array<Record<string, unknown>>;
}

export interface KapsoWebhookNormalizeOptions {
  defaultPhoneNumberId?: string;
  eventName?: string;
  batchHeader?: string;
}

export function isKapsoWebhookRequest(request: Request): boolean {
  return (
    request.headers.has("x-webhook-signature") ||
    request.headers.has("x-webhook-event") ||
    request.headers.has("x-webhook-batch")
  );
}

export function verifyKapsoWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  webhookSecret: string;
}): boolean {
  const signature = input.signatureHeader?.replace(/^sha256=/, "");
  if (!signature) {
    return false;
  }

  const expected = createHmac("sha256", input.webhookSecret)
    .update(input.rawBody)
    .digest("hex");

  try {
    const signatureBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    return (
      signatureBuffer.byteLength === expectedBuffer.byteLength &&
      timingSafeEqual(signatureBuffer, expectedBuffer)
    );
  } catch {
    return false;
  }
}

export function normalizeKapsoWebhook(
  payload: unknown,
  options: KapsoWebhookNormalizeOptions,
): NormalizedWebhookResult {
  if (options.eventName && options.eventName !== KAPSO_MESSAGE_RECEIVED_EVENT) {
    return {
      contacts: [],
      messages: [],
      statuses: [],
      phoneNumberId: options.defaultPhoneNumberId,
    };
  }

  const events = extractKapsoWebhookEvents(payload, options.batchHeader);
  const contacts: Array<Record<string, unknown>> = [];
  const messages: UnifiedMessage[] = [];
  let phoneNumberId = options.defaultPhoneNumberId;
  let displayPhoneNumber: string | undefined;

  for (const event of events) {
    const eventName = readRecordString(event, "event", "type");
    if (eventName && eventName !== KAPSO_MESSAGE_RECEIVED_EVENT) {
      continue;
    }

    const message = readRecord(event, "message");
    if (!message || !isKapsoWebhookMessage(message)) {
      continue;
    }

    const conversation = readRecord(event, "conversation");
    const eventPhoneNumberId =
      readRecordString(event, "phone_number_id", "phoneNumberId") ??
      readRecordString(conversation, "phone_number_id", "phoneNumberId") ??
      phoneNumberId;
    if (eventPhoneNumberId) {
      phoneNumberId = eventPhoneNumberId;
    }
    displayPhoneNumber =
      displayPhoneNumber ??
      readRecordString(
        conversation,
        "display_phone_number",
        "displayPhoneNumber",
      );

    const normalizedMessage = normalizeKapsoWebhookMessage(
      message,
      conversation,
      eventPhoneNumberId,
    );
    messages.push(normalizedMessage);

    const contact = contactFromKapsoWebhookMessage(
      normalizedMessage,
      conversation,
    );
    if (contact) {
      contacts.push(contact);
    }
  }

  return {
    contacts,
    displayPhoneNumber,
    messages,
    phoneNumberId,
    statuses: [],
  };
}

function extractKapsoWebhookEvents(
  payload: unknown,
  batchHeader?: string,
): Record<string, unknown>[] {
  const record = asRecord(payload);
  if (!record) {
    return [];
  }

  const data = record.data;
  if (Array.isArray(data)) {
    return data.flatMap((item) => {
      const event = asRecord(item);
      return event ? [event] : [];
    });
  }

  if (batchHeader === "true") {
    return [];
  }

  return [record];
}

function normalizeKapsoWebhookMessage(
  message: Record<string, unknown>,
  conversation?: Record<string, unknown>,
  phoneNumberId?: string,
): UnifiedMessage {
  const normalized = { ...message } as Record<string, unknown>;
  const kapso = {
    ...(asRecord(message.kapso) ?? {}),
  };

  const conversationId = readRecordString(conversation, "id");
  if (conversationId && !kapso.whatsappConversationId) {
    kapso.whatsappConversationId = conversationId;
  }

  const contactName =
    readRecordString(
      conversation?.kapso as Record<string, unknown> | undefined,
      "contactName",
      "contact_name",
    ) ?? readRecordString(conversation, "contactName", "contact_name");
  if (contactName && !kapso.contactName) {
    kapso.contactName = contactName;
  }

  const phoneNumber = readRecordString(
    conversation,
    "phone_number",
    "phoneNumber",
  );
  if (phoneNumberId && !kapso.phoneNumberId) {
    kapso.phoneNumberId = phoneNumberId;
  }
  if (phoneNumber && !kapso.phoneNumber) {
    kapso.phoneNumber = phoneNumber;
  }

  if (!kapso.direction) {
    kapso.direction = "inbound";
  }

  const mediaData = kapso.mediaData ?? kapso.media_data;
  if (mediaData && !kapso.mediaData) {
    kapso.mediaData = mediaData;
  }
  if (kapso.media_url && !kapso.mediaUrl) {
    kapso.mediaUrl = kapso.media_url;
  }
  if (kapso.order_text && !kapso.orderText) {
    kapso.orderText = kapso.order_text;
  }

  normalized.kapso = kapso;

  const fallbackFrom = normalizePhoneNumber(phoneNumber);
  if (!normalized.from && fallbackFrom) {
    normalized.from = fallbackFrom;
  }

  const reaction = asRecord(normalized.reaction);
  if (reaction?.message_id && !reaction.messageId) {
    normalized.reaction = {
      ...reaction,
      messageId: reaction.message_id,
    };
  }

  const interactive = asRecord(normalized.interactive);
  if (interactive?.button_reply && !interactive.buttonReply) {
    normalized.interactive = {
      ...interactive,
      buttonReply: interactive.button_reply,
    };
  }
  if (interactive?.list_reply && !interactive.listReply) {
    normalized.interactive = {
      ...interactive,
      listReply: interactive.list_reply,
    };
  }

  return normalized as UnifiedMessage;
}

function contactFromKapsoWebhookMessage(
  message: UnifiedMessage,
  conversation?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const waId =
    message.from ??
    normalizePhoneNumber(
      readRecordString(conversation, "phone_number", "phoneNumber"),
    );
  if (!waId) {
    return undefined;
  }

  const name =
    kapsoString(message, "contactName", "contact_name") ??
    readRecordString(
      conversation?.kapso as Record<string, unknown> | undefined,
      "contactName",
      "contact_name",
    ) ??
    waId;

  return {
    waId,
    wa_id: waId,
    displayName: name,
    profileName: name,
    profile: { name },
  };
}

function isKapsoWebhookMessage(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.timestamp === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRecord(
  source: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(source?.[key]);
}

function readRecordString(
  source: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizePhoneNumber(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\D/g, "");
  return normalized.length > 0 ? normalized : undefined;
}

function kapsoString(raw: UnifiedMessage, ...keys: string[]): string | undefined {
  const kapso = raw.kapso as Record<string, unknown> | undefined;
  for (const key of keys) {
    const value = kapso?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
