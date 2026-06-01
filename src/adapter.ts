import {
  ConsoleLogger,
  Message,
  NotImplementedError,
  getEmoji,
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type Author,
  type ButtonElement,
  type CardElement,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FileUpload,
  type FormattedContent,
  type LinkButtonElement,
  type Logger,
  type RawMessage,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import {
  ValidationError,
  cardToFallbackText,
  extractCard,
  extractFiles,
  extractPostableAttachments,
  toBuffer,
} from "@chat-adapter/shared";
import {
  WhatsAppClient,
  buildKapsoMessageFields,
  type SendMessageResponse,
  type UnifiedMessage,
} from "@kapso/whatsapp-cloud-api";
import {
  normalizeWebhook,
  verifySignature,
} from "@kapso/whatsapp-cloud-api/server";
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeKapsoActionId, encodeKapsoActionId } from "./action-id";
import { KapsoFormatConverter } from "./format-converter";
import type {
  KapsoAdapterConfig,
  KapsoRawMessage,
  KapsoRawMessageResult,
  KapsoThreadId,
} from "./types";

const DEFAULT_KAPSO_BASE_URL = "https://api.kapso.ai/meta/whatsapp";
const DEFAULT_HISTORY_FIELDS = buildKapsoMessageFields(
  "direction",
  "status",
  "phone_number",
  "media_data",
  "media_url",
  "whatsapp_conversation_id",
  "contact_name",
  "message_type_data",
  "content",
  "flow_response",
  "flow_token",
  "flow_name",
  "order_text",
);
const DEFAULT_CACHE_SIZE = 200;
const INTERACTIVE_BODY_MAX_LENGTH = 1024;
const BUTTON_LABEL_MAX_LENGTH = 20;
const KAPSO_MESSAGE_RECEIVED_EVENT = "whatsapp.message.received";
const MAX_PROCESSED_WEBHOOK_KEYS = 1024;

interface NormalizedWebhookResult {
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  contacts: Array<Record<string, unknown>>;
  messages: UnifiedMessage[];
  statuses: Array<Record<string, unknown>>;
}

interface MessageParseContext {
  phoneNumberId: string;
  displayPhoneNumber?: string;
  contact?: Record<string, unknown>;
  conversationId?: string;
}

interface MediaSendInput {
  kind: "image" | "video" | "audio" | "document" | "sticker";
  id?: string;
  link?: string;
  caption?: string;
  filename?: string;
  mimeType?: string;
}

/** Chat SDK adapter for Kapso's WhatsApp Cloud API SDK. */
export class KapsoAdapter implements Adapter<KapsoThreadId, KapsoRawMessage> {
  readonly name = "kapso";
  readonly lockScope = "channel" as const;
  readonly persistThreadHistory = true;

  private readonly client: WhatsAppClient;
  private readonly webhookSecret?: string;
  private readonly appSecret?: string;
  private readonly webhookVerifyToken?: string;
  private readonly verifyWebhookSignatures: boolean;
  private readonly defaultPhoneNumberId?: string;
  private readonly historyFields: string;
  private readonly cacheSize: number;
  private readonly debugLogging: boolean;
  private readonly formatConverter: KapsoFormatConverter;
  private readonly messageCache = new Map<string, Message<KapsoRawMessage>[]>();
  private readonly latestInboundMessageByThread = new Map<string, string>();
  private readonly processedWebhookKeys = new Map<string, number>();

  private chat: ChatInstance | null = null;
  private logger: Logger;
  private warnedUnsignedWebhookMode = false;
  private _userName: string;

  constructor(config: KapsoAdapterConfig = {}) {
    this.client = config.client ?? createWhatsAppClient(config);
    this.webhookSecret = config.webhookSecret ?? env("KAPSO_WEBHOOK_SECRET");
    this.appSecret =
      config.appSecret ?? env("WHATSAPP_APP_SECRET") ?? env("META_APP_SECRET");
    this.webhookVerifyToken =
      config.webhookVerifyToken ?? env("WHATSAPP_WEBHOOK_VERIFY_TOKEN");
    this.verifyWebhookSignatures = config.verifyWebhookSignatures ?? true;
    this.defaultPhoneNumberId =
      config.phoneNumberId ??
      env("KAPSO_PHONE_NUMBER_ID") ??
      env("WHATSAPP_PHONE_NUMBER_ID");
    this.historyFields = config.historyFields ?? DEFAULT_HISTORY_FIELDS;
    this.cacheSize = config.cacheSize ?? DEFAULT_CACHE_SIZE;
    this.debugLogging = config.debug ?? false;
    this.formatConverter = new KapsoFormatConverter();
    this.logger =
      config.logger ??
      new ConsoleLogger(
        config.logLevel ?? (this.debugLogging ? "debug" : "info"),
        "kapso",
      );
    this._userName =
      config.userName ??
      env("KAPSO_BOT_USERNAME") ??
      env("KAPSO_ADAPTER_USER_NAME") ??
      "kapso";
    this.logDiagnostic("adapter constructed", {
      kapsoProxy: this.client.isKapsoProxy(),
      hasWebhookSecret: Boolean(this.webhookSecret),
      hasAppSecret: Boolean(this.appSecret),
      hasWebhookVerifyToken: Boolean(this.webhookVerifyToken),
      hasDefaultPhoneNumberId: Boolean(this.defaultPhoneNumberId),
      verifyWebhookSignatures: this.verifyWebhookSignatures,
    });
  }

  get userName(): string {
    return this._userName;
  }

  get botUserId(): string | undefined {
    return this.defaultPhoneNumberId;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger("kapso");
    if (this._userName === "kapso") {
      this._userName = chat.getUserName();
    }
    this.logDiagnostic("adapter initialized", {
      userName: this._userName,
      kapsoProxy: this.client.isKapsoProxy(),
    });
  }

  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    this.logDiagnostic("webhook received", {
      method: request.method,
      path: safeRequestPath(request),
      hasWaitUntil: Boolean(options?.waitUntil),
    });

    if (request.method === "GET") {
      return this.handleVerificationChallenge(request);
    }

    if (request.method !== "POST") {
      this.logDiagnostic("webhook rejected: method not allowed", {
        method: request.method,
      });
      return new Response("Method not allowed", { status: 405 });
    }

    const rawBody = await request.text();
    const isKapsoWebhook = isKapsoWebhookRequest(request);
    this.logDiagnostic("webhook body read", {
      bytes: Buffer.byteLength(rawBody),
      mode: isKapsoWebhook ? "kapso" : "meta",
      hasKapsoSignature: request.headers.has("x-webhook-signature"),
      hasMetaSignature: request.headers.has("x-hub-signature-256"),
    });
    const signatureResponse = isKapsoWebhook
      ? this.verifyKapsoWebhookRequest(request, rawBody)
      : this.verifyWebhookRequest(request, rawBody);
    if (signatureResponse) {
      return signatureResponse;
    }

    if (isKapsoWebhook && this.isDuplicateKapsoDelivery(request)) {
      return new Response("OK", { status: 200 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      this.logDiagnostic("webhook rejected: invalid JSON");
      return new Response("Invalid JSON", { status: 400 });
    }

    const normalized = isKapsoWebhook
      ? normalizeKapsoWebhook(payload, {
          defaultPhoneNumberId: this.defaultPhoneNumberId,
          eventName: request.headers.get("x-webhook-event") ?? undefined,
          batchHeader: request.headers.get("x-webhook-batch") ?? undefined,
        })
      : (normalizeWebhook(payload) as NormalizedWebhookResult);
    this.logDiagnostic("webhook normalized", {
      mode: isKapsoWebhook ? "kapso" : "meta",
      phoneNumberId: redactId(normalized.phoneNumberId),
      contacts: normalized.contacts.length,
      messages: normalized.messages.length,
      statuses: normalized.statuses.length,
    });
    if (!this.chat) {
      this.logger.warn("Chat instance is not initialized; ignoring webhook");
      this.logDiagnostic("webhook ignored: chat not initialized");
      return new Response("OK", { status: 200 });
    }

    for (const rawMessage of normalized.messages) {
      try {
        this.dispatchWebhookMessage(rawMessage, normalized, options);
      } catch (error) {
        this.logDiagnostic("webhook message dispatch failed", {
          messageId: rawMessage.id,
          type: rawMessage.type,
          error: describeError(error),
        });
        throw error;
      }
    }

    this.logDiagnostic("webhook processed", {
      messages: normalized.messages.length,
    });
    if (isKapsoWebhook && normalized.messages.length > 0) {
      this.rememberKapsoDelivery(request);
    }
    return new Response("OK", { status: 200 });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<KapsoRawMessage>> {
    try {
      const thread = this.decodeThreadId(threadId);
      const card = extractCard(message);
      const files = extractFiles(message);
      const attachments = extractPostableAttachments(message);
      this.logDiagnostic("postMessage start", {
        threadId,
        phoneNumberId: redactId(thread.phoneNumberId),
        waId: redactId(thread.waId),
        hasCard: Boolean(card),
        files: files.length,
        attachments: attachments.length,
      });

      if (card && (files.length > 0 || attachments.length > 0)) {
        throw new ValidationError(
          "kapso",
          "Kapso adapter does not support combining card buttons and file uploads in one WhatsApp message.",
        );
      }

      if (card) {
        return this.postCard(thread, threadId, card);
      }

      const text = this.formatConverter.renderPostable(message).trim();
      if (files.length > 0 || attachments.length > 0) {
        return this.postMediaBatch(thread, threadId, text, files, attachments);
      }

      if (!text) {
        throw new ValidationError("kapso", "Message text cannot be empty");
      }

      const response = await this.client.messages.sendText({
        phoneNumberId: thread.phoneNumberId,
        to: thread.waId,
        body: text,
      });
      this.logDiagnostic("postMessage text sent", {
        threadId,
        messageId: firstMessageId(response),
      });
      return this.rawSendResult(threadId, response);
    } catch (error) {
      this.logDiagnostic("postMessage failed", {
        threadId,
        error: describeError(error),
      });
      throw error;
    }
  }

  async editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<KapsoRawMessageResult> {
    throw new NotImplementedError(
      "WhatsApp Cloud API does not support editing sent messages.",
      "editMessage",
    );
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError(
      "WhatsApp Cloud API does not support deleting sent messages for recipients.",
      "deleteMessage",
    );
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    const thread = this.decodeThreadId(threadId);
    this.logDiagnostic("addReaction start", {
      threadId,
      targetMessageId: messageId,
    });
    await this.client.messages.sendReaction({
      phoneNumberId: thread.phoneNumberId,
      to: thread.waId,
      reaction: {
        messageId,
        emoji: emojiToWhatsApp(emoji),
      },
    });
    this.logDiagnostic("addReaction sent", {
      threadId,
      targetMessageId: messageId,
    });
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    _emoji?: EmojiValue | string,
  ): Promise<void> {
    const thread = this.decodeThreadId(threadId);
    this.logDiagnostic("removeReaction start", {
      threadId,
      targetMessageId: messageId,
    });
    await this.client.messages.sendReaction({
      phoneNumberId: thread.phoneNumberId,
      to: thread.waId,
      reaction: { messageId },
    });
    this.logDiagnostic("removeReaction sent", {
      threadId,
      targetMessageId: messageId,
    });
  }

  async startTyping(threadId: string): Promise<void> {
    const thread = this.decodeThreadId(threadId);
    const messageId = this.latestInboundMessageByThread.get(threadId);
    if (!messageId) {
      this.logger.debug(
        "No inbound message available for WhatsApp typing indicator",
        {
          threadId,
        },
      );
      this.logDiagnostic("startTyping skipped: no latest inbound message", {
        threadId,
      });
      return;
    }

    this.logDiagnostic("startTyping markRead", {
      threadId,
      messageId,
    });
    await this.client.messages.markRead({
      phoneNumberId: thread.phoneNumberId,
      messageId,
      typingIndicator: { type: "text" },
    });
  }

  async fetchMessages(
    threadId: string,
    options: FetchOptions = {},
  ): Promise<FetchResult<KapsoRawMessage>> {
    const thread = this.decodeThreadId(threadId);
    this.logDiagnostic("fetchMessages start", {
      threadId,
      direction: options.direction ?? "backward",
      limit: options.limit,
      cursor: options.cursor,
      kapsoProxy: this.client.isKapsoProxy(),
    });

    if (this.client.isKapsoProxy()) {
      try {
        const conversationId =
          thread.conversationId ?? (await this.resolveConversationId(thread));
        if (conversationId) {
          const page = await this.client.messages.listByConversation({
            phoneNumberId: thread.phoneNumberId,
            conversationId,
            limit: options.limit ?? 50,
            after: options.direction === "forward" ? options.cursor : undefined,
            before:
              options.direction === "forward" ? undefined : options.cursor,
            fields: this.historyFields,
          });
          const messages = page.data
            .map((item) =>
              this.parseMessageWithContext(item, {
                phoneNumberId: thread.phoneNumberId,
                conversationId,
              }),
            )
            .sort(compareMessages);
          const nextCursor =
            options.direction === "forward"
              ? (page.paging?.cursors?.after ?? undefined)
              : (page.paging?.cursors?.before ?? undefined);
          this.logDiagnostic("fetchMessages Kapso history result", {
            threadId,
            conversationId,
            messages: messages.length,
            nextCursor,
          });
          return { messages, nextCursor };
        }
      } catch (error) {
        this.logger.warn(
          "Falling back to cached messages after Kapso history fetch failed",
          {
            error: String(error),
            threadId,
          },
        );
        this.logDiagnostic("fetchMessages Kapso history failed", {
          threadId,
          error: describeError(error),
        });
      }
    }

    const page = this.paginateCachedMessages(threadId, options);
    this.logDiagnostic("fetchMessages cache result", {
      threadId,
      messages: page.messages.length,
      nextCursor: page.nextCursor,
    });
    return page;
  }

  async fetchMessage(
    threadId: string,
    messageId: string,
  ): Promise<Message<KapsoRawMessage> | null> {
    const cached = this.findCachedMessage(messageId);
    if (cached) {
      return cached;
    }

    const thread = this.decodeThreadId(threadId);
    if (!this.client.isKapsoProxy()) {
      return null;
    }

    try {
      const raw = await this.client.messages.get({
        phoneNumberId: thread.phoneNumberId,
        messageId,
        fields: this.historyFields,
      });
      return this.parseMessageWithContext(raw, {
        phoneNumberId: thread.phoneNumberId,
        conversationId: thread.conversationId,
      });
    } catch {
      return null;
    }
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const thread = this.decodeThreadId(threadId);
    let contact: Record<string, unknown> | undefined;
    let conversation: Record<string, unknown> | undefined;

    if (this.client.isKapsoProxy()) {
      try {
        contact = await this.client.contacts.get({
          phoneNumberId: thread.phoneNumberId,
          waId: thread.waId,
        });
      } catch {
        contact = undefined;
      }

      if (thread.conversationId) {
        try {
          conversation = await this.client.conversations.get({
            conversationId: thread.conversationId,
          });
        } catch {
          conversation = undefined;
        }
      }
    }

    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      channelName: `WhatsApp ${thread.phoneNumberId}`,
      isDM: true,
      metadata: {
        ...thread,
        contact,
        conversation,
      },
    };
  }

  channelIdFromThreadId(threadId: string): string {
    const thread = this.decodeThreadId(threadId);
    return `kapso:${encodePart(thread.phoneNumberId)}`;
  }

  async openDM(userId: string): Promise<string> {
    if (!this.defaultPhoneNumberId) {
      throw new ValidationError(
        "kapso",
        "phoneNumberId is required to open a WhatsApp DM.",
      );
    }

    return this.encodeThreadId({
      phoneNumberId: this.defaultPhoneNumberId,
      waId: userId,
    });
  }

  isDM(): boolean {
    return true;
  }

  encodeThreadId(platformData: KapsoThreadId): string {
    const parts = [
      "kapso",
      encodePart(platformData.phoneNumberId),
      encodePart(platformData.waId),
    ];
    if (platformData.conversationId) {
      parts.push(encodePart(platformData.conversationId));
    }
    return parts.join(":");
  }

  decodeThreadId(threadId: string): KapsoThreadId {
    const parts = threadId.split(":");
    if (parts[0] !== "kapso" || (parts.length !== 3 && parts.length !== 4)) {
      throw new ValidationError(
        "kapso",
        `Invalid Kapso thread ID: ${threadId}`,
      );
    }

    const phoneNumberId = decodePart(parts[1]);
    const waId = decodePart(parts[2]);
    const conversationId = parts[3] ? decodePart(parts[3]) : undefined;
    if (!phoneNumberId || !waId) {
      throw new ValidationError(
        "kapso",
        `Invalid Kapso thread ID: ${threadId}`,
      );
    }

    return { phoneNumberId, waId, conversationId };
  }

  parseMessage(raw: KapsoRawMessage): Message<KapsoRawMessage> {
    if (!isUnifiedMessage(raw)) {
      throw new ValidationError(
        "kapso",
        "KapsoAdapter.parseMessage expects a WhatsApp message payload.",
      );
    }

    const phoneNumberId =
      this.defaultPhoneNumberId ??
      (typeof raw.kapso?.phoneNumberId === "string"
        ? raw.kapso.phoneNumberId
        : undefined);
    if (!phoneNumberId) {
      throw new ValidationError(
        "kapso",
        "phoneNumberId is required to parse a WhatsApp message outside webhook context.",
      );
    }

    return this.parseMessageWithContext(raw, { phoneNumberId });
  }

  renderFormatted(content: FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  rehydrateAttachment(attachment: Attachment): Attachment {
    const mediaId = attachment.fetchMetadata?.mediaId;
    const phoneNumberId = attachment.fetchMetadata?.phoneNumberId;
    if (!mediaId || !phoneNumberId || attachment.fetchData) {
      return attachment;
    }

    return {
      ...attachment,
      fetchData: async () => {
        const data = await this.client.media.download({
          mediaId,
          phoneNumberId,
        });
        return Buffer.from(data as ArrayBuffer);
      },
    };
  }

  private handleVerificationChallenge(request: Request): Response {
    const url = new URL(request.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (
      mode === "subscribe" &&
      challenge != null &&
      token &&
      token === this.webhookVerifyToken
    ) {
      this.logDiagnostic("webhook verification challenge accepted");
      return new Response(challenge, { status: 200 });
    }

    this.logDiagnostic("webhook verification challenge rejected", {
      mode,
      hasToken: Boolean(token),
      hasVerifyToken: Boolean(this.webhookVerifyToken),
      hasChallenge: challenge != null,
    });
    return new Response("Forbidden", { status: 403 });
  }

  private verifyWebhookRequest(
    request: Request,
    rawBody: string,
  ): Response | undefined {
    if (!this.verifyWebhookSignatures) {
      if (!this.warnedUnsignedWebhookMode) {
        this.warnedUnsignedWebhookMode = true;
        this.logger.warn(
          "Kapso webhook signature verification is disabled. Only use this in local development.",
        );
      }
      this.logDiagnostic("webhook signature verification skipped");
      return undefined;
    }

    if (!this.appSecret) {
      this.logDiagnostic("webhook rejected: missing app secret");
      return new Response("Webhook signature verification is not configured", {
        status: 401,
      });
    }

    const signatureHeader =
      request.headers.get("x-hub-signature-256") ?? undefined;
    const valid = verifySignature({
      appSecret: this.appSecret,
      rawBody,
      signatureHeader,
    });

    return valid
      ? (this.logDiagnostic("webhook signature verified"), undefined)
      : (this.logDiagnostic("webhook rejected: invalid signature", {
          hasSignature: Boolean(signatureHeader),
        }),
        new Response("Invalid signature", { status: 401 }));
  }

  private verifyKapsoWebhookRequest(
    request: Request,
    rawBody: string,
  ): Response | undefined {
    if (!this.verifyWebhookSignatures) {
      if (!this.warnedUnsignedWebhookMode) {
        this.warnedUnsignedWebhookMode = true;
        this.logger.warn(
          "Kapso webhook signature verification is disabled. Only use this in local development.",
        );
      }
      this.logDiagnostic("Kapso webhook signature verification skipped");
      return undefined;
    }

    if (!this.webhookSecret) {
      this.logDiagnostic("Kapso webhook rejected: missing webhook secret");
      return new Response(
        "Kapso webhook signature verification is not configured",
        {
          status: 401,
        },
      );
    }

    const signatureHeader = request.headers.get("x-webhook-signature");
    const valid = verifyKapsoWebhookSignature({
      rawBody,
      signatureHeader,
      webhookSecret: this.webhookSecret,
    });

    return valid
      ? (this.logDiagnostic("Kapso webhook signature verified"), undefined)
      : (this.logDiagnostic("Kapso webhook rejected: invalid signature", {
          hasSignature: Boolean(signatureHeader),
        }),
        new Response("Invalid signature", { status: 401 }));
  }

  private isDuplicateKapsoDelivery(request: Request): boolean {
    const idempotencyKey = request.headers.get("x-idempotency-key");
    if (!idempotencyKey) {
      return false;
    }

    const duplicate = this.processedWebhookKeys.has(idempotencyKey);
    if (duplicate) {
      this.logDiagnostic("Kapso webhook duplicate ignored", {
        idempotencyKey,
      });
    }
    return duplicate;
  }

  private rememberKapsoDelivery(request: Request): void {
    const idempotencyKey = request.headers.get("x-idempotency-key");
    if (!idempotencyKey) {
      return;
    }

    this.processedWebhookKeys.set(idempotencyKey, Date.now());
    while (this.processedWebhookKeys.size > MAX_PROCESSED_WEBHOOK_KEYS) {
      const oldestKey = this.processedWebhookKeys.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.processedWebhookKeys.delete(oldestKey);
    }
  }

  private dispatchWebhookMessage(
    rawMessage: UnifiedMessage,
    normalized: NormalizedWebhookResult,
    options?: WebhookOptions,
  ): void {
    if (!this.chat) {
      return;
    }

    const contact = findContact(normalized.contacts, rawMessage);
    const phoneNumberId =
      kapsoString(rawMessage, "phoneNumberId", "phone_number_id") ??
      normalized.phoneNumberId ??
      this.defaultPhoneNumberId;
    if (!phoneNumberId) {
      this.logger.warn(
        "Skipping WhatsApp webhook message without phoneNumberId",
        {
          messageId: rawMessage.id,
        },
      );
      return;
    }

    const conversationId = kapsoString(
      rawMessage,
      "whatsappConversationId",
      "whatsapp_conversation_id",
    );
    const threadData = this.threadDataFromMessage(rawMessage, {
      phoneNumberId,
      displayPhoneNumber: normalized.displayPhoneNumber,
      contact,
      conversationId,
    });
    if (!threadData) {
      this.logger.warn(
        "Skipping WhatsApp webhook message without participant",
        {
          messageId: rawMessage.id,
        },
      );
      return;
    }

    const threadId = this.encodeThreadId(threadData);
    this.logDiagnostic("webhook message dispatch", {
      messageId: rawMessage.id,
      type: rawMessage.type,
      direction: rawMessage.kapso?.direction,
      threadId,
      phoneNumberId: redactId(phoneNumberId),
      waId: redactId(threadData.waId),
    });
    if (isReactionMessage(rawMessage)) {
      this.dispatchReaction(
        rawMessage,
        threadId,
        {
          phoneNumberId,
          displayPhoneNumber: normalized.displayPhoneNumber,
          contact,
          conversationId,
        },
        options,
      );
      return;
    }

    if (isInteractiveActionMessage(rawMessage)) {
      this.dispatchAction(
        rawMessage,
        threadId,
        {
          phoneNumberId,
          displayPhoneNumber: normalized.displayPhoneNumber,
          contact,
          conversationId,
        },
        options,
      );
      return;
    }

    const message = this.parseMessageWithContext(rawMessage, {
      phoneNumberId,
      displayPhoneNumber: normalized.displayPhoneNumber,
      contact,
      conversationId,
    });
    this.cacheMessage(message);
    if (!message.author.isMe) {
      this.latestInboundMessageByThread.set(threadId, message.id);
    }

    this.logDiagnostic("processMessage queued", {
      messageId: message.id,
      threadId,
      isMe: message.author.isMe,
      attachments: message.attachments.length,
    });
    void this.chat.processMessage(this, threadId, message, options);
  }

  private dispatchAction(
    rawMessage: UnifiedMessage,
    threadId: string,
    context: MessageParseContext,
    options?: WebhookOptions,
  ): void {
    if (!this.chat) return;

    const reply = interactiveReply(rawMessage);
    if (!reply?.id) return;

    const decoded = decodeKapsoActionId(String(reply.id));
    this.logDiagnostic("processAction queued", {
      messageId: rawMessage.context?.id ?? rawMessage.id,
      threadId,
      actionId: decoded.actionId,
      hasValue: decoded.value !== undefined,
    });
    this.chat.processAction(
      {
        adapter: this,
        actionId: decoded.actionId,
        value: decoded.value,
        messageId: rawMessage.context?.id ?? rawMessage.id,
        threadId,
        user: this.authorForMessage(rawMessage, context),
        raw: rawMessage,
      },
      options,
    );
  }

  private dispatchReaction(
    rawMessage: UnifiedMessage,
    threadId: string,
    context: MessageParseContext,
    options?: WebhookOptions,
  ): void {
    if (!this.chat) return;

    const messageId = reactionMessageId(rawMessage);
    if (!messageId) return;

    const rawEmoji = rawMessage.reaction?.emoji ?? "";
    this.logDiagnostic("processReaction queued", {
      messageId,
      threadId,
      added: rawEmoji.length > 0,
      rawEmoji,
    });
    this.chat.processReaction(
      {
        adapter: this,
        added: rawEmoji.length > 0,
        emoji: getEmoji(rawEmoji || "removed"),
        messageId,
        raw: rawMessage,
        rawEmoji,
        threadId,
        user: this.authorForMessage(rawMessage, context),
      },
      options,
    );
  }

  private parseMessageWithContext(
    raw: UnifiedMessage,
    context: MessageParseContext,
  ): Message<KapsoRawMessage> {
    const threadData = this.threadDataFromMessage(raw, context);
    if (!threadData) {
      throw new ValidationError(
        "kapso",
        `Cannot derive thread ID for WhatsApp message ${raw.id}`,
      );
    }

    const threadId = this.encodeThreadId(threadData);
    const text = messageText(raw);
    const message = new Message<KapsoRawMessage>({
      id: raw.id,
      threadId,
      text,
      formatted: this.formatConverter.toAst(text),
      raw,
      author: this.authorForMessage(raw, context),
      metadata: {
        dateSent: dateFromTimestamp(raw.timestamp),
        edited: false,
      },
      attachments: this.attachmentsForMessage(raw, context.phoneNumberId),
      links: [],
    });
    return message;
  }

  private authorForMessage(
    raw: UnifiedMessage,
    context: MessageParseContext,
  ): Author {
    if (isOutbound(raw)) {
      const name = context.displayPhoneNumber ?? this._userName;
      return {
        userId: context.phoneNumberId,
        userName: name,
        fullName: name,
        isBot: true,
        isMe: true,
      };
    }

    const waId = raw.from ?? contactWaId(context.contact) ?? "unknown";
    const name =
      contactName(context.contact) ??
      kapsoString(raw, "contactName", "contact_name") ??
      kapsoString(raw, "phoneNumber", "phone_number") ??
      waId;
    return {
      userId: waId,
      userName: name,
      fullName: name,
      isBot: false,
      isMe: false,
    };
  }

  private threadDataFromMessage(
    raw: UnifiedMessage,
    context: MessageParseContext,
  ): KapsoThreadId | null {
    const waId = isOutbound(raw)
      ? (raw.to ?? kapsoString(raw, "phoneNumber", "phone_number"))
      : (raw.from ?? contactWaId(context.contact));
    if (!waId) {
      return null;
    }

    return {
      phoneNumberId: context.phoneNumberId,
      waId,
      conversationId: context.conversationId,
    };
  }

  private attachmentsForMessage(
    raw: UnifiedMessage,
    phoneNumberId: string,
  ): Attachment[] {
    const attachments: Attachment[] = [];
    const media = mediaFromMessage(raw);
    if (!media) {
      return attachments;
    }

    attachments.push({
      type:
        media.kind === "document"
          ? "file"
          : media.kind === "sticker"
            ? "image"
            : media.kind,
      name: media.filename,
      mimeType: media.mimeType,
      size: mediaByteSize(raw),
      url: kapsoString(raw, "mediaUrl", "media_url") ?? media.link,
      fetchMetadata: media.id
        ? {
            platform: "kapso",
            mediaId: media.id,
            phoneNumberId,
          }
        : undefined,
      fetchData: media.id
        ? async () => {
            const data = await this.client.media.download({
              mediaId: media.id as string,
              phoneNumberId,
            });
            return Buffer.from(data as ArrayBuffer);
          }
        : undefined,
    });

    return attachments;
  }

  private async postCard(
    thread: KapsoThreadId,
    threadId: string,
    card: CardElement,
  ): Promise<RawMessage<KapsoRawMessage>> {
    const text = fitInteractiveBody(
      this.formatConverter.fromMarkdown(
        cardToFallbackText(card, {
          boldFormat: "**",
          platform: "gchat",
        }),
      ),
    );
    const actions = collectActions(card);
    const buttons = actions.actionButtons.filter((button) => !button.disabled);
    const link = actions.linkButtons[0];
    this.logDiagnostic("postCard resolved", {
      threadId,
      buttons: buttons.length,
      linkButtons: actions.linkButtons.length,
      hasImage: Boolean(card.imageUrl),
    });

    if (buttons.length > 0) {
      if (buttons.length > 3) {
        throw new ValidationError(
          "kapso",
          "WhatsApp interactive button messages support at most 3 buttons.",
        );
      }

      const response = await this.client.messages.sendInteractiveButtons({
        phoneNumberId: thread.phoneNumberId,
        to: thread.waId,
        bodyText: text || "Choose an option",
        header: card.imageUrl
          ? { type: "image", image: { link: card.imageUrl } }
          : undefined,
        buttons: buttons.map((button) => ({
          id: encodeKapsoActionId(button.id, button.value),
          title: fitButtonLabel(button.label),
        })),
      });
      this.logDiagnostic("postCard buttons sent", {
        threadId,
        messageId: firstMessageId(response),
        buttons: buttons.length,
      });
      return this.rawSendResult(threadId, response);
    }

    if (link) {
      const response = await this.client.messages.sendInteractiveCtaUrl({
        phoneNumberId: thread.phoneNumberId,
        to: thread.waId,
        bodyText: text || link.label,
        header: card.imageUrl
          ? { type: "image", image: { link: card.imageUrl } }
          : undefined,
        parameters: {
          displayText: fitButtonLabel(link.label),
          url: link.url,
        },
      });
      this.logDiagnostic("postCard CTA sent", {
        threadId,
        messageId: firstMessageId(response),
      });
      return this.rawSendResult(threadId, response);
    }

    const response = await this.client.messages.sendText({
      phoneNumberId: thread.phoneNumberId,
      to: thread.waId,
      body: text || card.title || " ",
    });
    this.logDiagnostic("postCard fallback text sent", {
      threadId,
      messageId: firstMessageId(response),
    });
    return this.rawSendResult(threadId, response);
  }

  private async postMediaBatch(
    thread: KapsoThreadId,
    threadId: string,
    text: string,
    files: FileUpload[],
    attachments: Attachment[],
  ): Promise<RawMessage<KapsoRawMessage>> {
    const responses: SendMessageResponse[] = [];
    let captionUsed = false;
    this.logDiagnostic("postMediaBatch start", {
      threadId,
      files: files.length,
      attachments: attachments.length,
      hasCaptionText: Boolean(text),
    });

    for (const file of files) {
      const media = await this.mediaInputFromFile(thread.phoneNumberId, file);
      if (text && supportsCaption(media.kind) && !captionUsed) {
        media.caption = text;
        captionUsed = true;
      }
      responses.push(await this.sendMedia(thread, media));
      this.logDiagnostic("postMediaBatch file sent", {
        threadId,
        kind: media.kind,
        filename: file.filename,
      });
    }

    for (const attachment of attachments) {
      const media = await this.mediaInputFromAttachment(
        thread.phoneNumberId,
        attachment,
      );
      if (text && supportsCaption(media.kind) && !captionUsed) {
        media.caption = text;
        captionUsed = true;
      }
      responses.push(await this.sendMedia(thread, media));
      this.logDiagnostic("postMediaBatch attachment sent", {
        threadId,
        kind: media.kind,
        name: attachment.name,
        usedLink: Boolean(media.link),
      });
    }

    if (text && !captionUsed) {
      responses.unshift(
        await this.client.messages.sendText({
          phoneNumberId: thread.phoneNumberId,
          to: thread.waId,
          body: text,
        }),
      );
      this.logDiagnostic("postMediaBatch text fallback sent", {
        threadId,
      });
    }

    if (responses.length === 0) {
      throw new ValidationError("kapso", "No media payloads were provided.");
    }

    this.logDiagnostic("postMediaBatch complete", {
      threadId,
      sends: responses.length,
      firstMessageId: firstMessageId(responses[0]),
    });
    return {
      id: firstMessageId(responses[0]) ?? "kapso-media",
      threadId,
      raw: { responses },
    };
  }

  private async mediaInputFromFile(
    phoneNumberId: string,
    file: FileUpload,
  ): Promise<MediaSendInput> {
    const buffer = await toBuffer(file.data, {
      platform: "gchat",
      throwOnUnsupported: true,
    });
    if (!buffer) {
      throw new ValidationError("kapso", "Unsupported file upload payload.");
    }

    const kind = mediaKind(file.mimeType, file.filename);
    const mediaType = file.mimeType ?? kind;
    this.logDiagnostic("uploading file media", {
      phoneNumberId: redactId(phoneNumberId),
      kind,
      mediaType,
      filename: file.filename,
      bytes: buffer.byteLength,
    });
    const uploaded = await this.client.media.upload({
      phoneNumberId,
      type: mediaType,
      file: bufferToTypedBlob(buffer, mediaType),
      fileName: file.filename,
    });

    return {
      kind,
      id: uploaded.id,
      filename: file.filename,
      mimeType: file.mimeType,
    };
  }

  private async mediaInputFromAttachment(
    phoneNumberId: string,
    attachment: Attachment,
  ): Promise<MediaSendInput> {
    const kind =
      attachment.type === "file" ? "document" : mediaKind(attachment.mimeType);

    if (attachment.url && !attachment.data && !attachment.fetchData) {
      return {
        kind,
        link: attachment.url,
        filename: attachment.name,
        mimeType: attachment.mimeType,
      };
    }

    const data = attachment.data ?? (await attachment.fetchData?.());
    const buffer = await toBuffer(data, {
      platform: "gchat",
      throwOnUnsupported: true,
    });
    if (!buffer) {
      throw new ValidationError("kapso", "Unsupported attachment payload.");
    }

    const mediaType = attachment.mimeType ?? kind;
    this.logDiagnostic("uploading attachment media", {
      phoneNumberId: redactId(phoneNumberId),
      kind,
      mediaType,
      name: attachment.name,
      bytes: buffer.byteLength,
    });
    const uploaded = await this.client.media.upload({
      phoneNumberId,
      type: mediaType,
      file: bufferToTypedBlob(buffer, mediaType),
      fileName: attachment.name,
    });

    return {
      kind,
      id: uploaded.id,
      filename: attachment.name,
      mimeType: attachment.mimeType,
    };
  }

  private async sendMedia(
    thread: KapsoThreadId,
    media: MediaSendInput,
  ): Promise<SendMessageResponse> {
    const ref = media.id ? { id: media.id } : { link: media.link as string };
    this.logDiagnostic("sendMedia start", {
      kind: media.kind,
      phoneNumberId: redactId(thread.phoneNumberId),
      waId: redactId(thread.waId),
      hasMediaId: Boolean(media.id),
      hasLink: Boolean(media.link),
      hasCaption: Boolean(media.caption),
    });

    switch (media.kind) {
      case "image":
        return this.client.messages.sendImage({
          phoneNumberId: thread.phoneNumberId,
          to: thread.waId,
          image: { ...ref, caption: media.caption },
        });
      case "video":
        return this.client.messages.sendVideo({
          phoneNumberId: thread.phoneNumberId,
          to: thread.waId,
          video: { ...ref, caption: media.caption },
        });
      case "audio":
        return this.client.messages.sendAudio({
          phoneNumberId: thread.phoneNumberId,
          to: thread.waId,
          audio: ref,
        });
      case "sticker":
        return this.client.messages.sendSticker({
          phoneNumberId: thread.phoneNumberId,
          to: thread.waId,
          sticker: ref,
        });
      case "document":
        return this.client.messages.sendDocument({
          phoneNumberId: thread.phoneNumberId,
          to: thread.waId,
          document: {
            ...ref,
            caption: media.caption,
            filename: media.filename,
          },
        });
    }
  }

  private async resolveConversationId(
    thread: KapsoThreadId,
  ): Promise<string | undefined> {
    const conversations = await this.client.conversations.list({
      phoneNumberId: thread.phoneNumberId,
      phoneNumber: thread.waId,
      limit: 1,
    });
    return conversations.data[0]?.id;
  }

  private paginateCachedMessages(
    threadId: string,
    options: FetchOptions,
  ): FetchResult<KapsoRawMessage> {
    const limit = options.limit ?? 50;
    const all = [...(this.messageCache.get(threadId) ?? [])].sort(
      compareMessages,
    );

    if (options.direction === "forward") {
      const start = options.cursor
        ? all.findIndex((message) => message.id === options.cursor) + 1
        : 0;
      const page = all.slice(Math.max(0, start), Math.max(0, start) + limit);
      const next = all[Math.max(0, start) + limit];
      return { messages: page, nextCursor: next ? page.at(-1)?.id : undefined };
    }

    const end = options.cursor
      ? all.findIndex((message) => message.id === options.cursor)
      : all.length;
    const safeEnd = end < 0 ? all.length : end;
    const start = Math.max(0, safeEnd - limit);
    const page = all.slice(start, safeEnd);
    return { messages: page, nextCursor: start > 0 ? page[0]?.id : undefined };
  }

  private cacheMessage(message: Message<KapsoRawMessage>): void {
    const existing = this.messageCache.get(message.threadId) ?? [];
    const withoutDuplicate = existing.filter((item) => item.id !== message.id);
    withoutDuplicate.push(message);
    withoutDuplicate.sort(compareMessages);
    this.messageCache.set(
      message.threadId,
      withoutDuplicate.slice(-this.cacheSize),
    );
  }

  private findCachedMessage(
    messageId: string,
  ): Message<KapsoRawMessage> | undefined {
    for (const messages of this.messageCache.values()) {
      const found = messages.find((message) => message.id === messageId);
      if (found) return found;
    }
    return undefined;
  }

  private rawSendResult(
    threadId: string,
    response: SendMessageResponse,
  ): KapsoRawMessageResult {
    return {
      id: firstMessageId(response) ?? "kapso-message",
      threadId,
      raw: response,
    };
  }

  private logDiagnostic(
    message: string,
    details: Record<string, unknown> = {},
  ): void {
    if (!this.debugLogging) {
      return;
    }

    this.logger.info(`[debug] ${message}`, details);
  }
}

interface KapsoWebhookNormalizeOptions {
  defaultPhoneNumberId?: string;
  eventName?: string;
  batchHeader?: string;
}

function isKapsoWebhookRequest(request: Request): boolean {
  return (
    request.headers.has("x-webhook-signature") ||
    request.headers.has("x-webhook-event") ||
    request.headers.has("x-webhook-batch") ||
    request.headers.has("x-idempotency-key")
  );
}

function verifyKapsoWebhookSignature(input: {
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

function normalizeKapsoWebhook(
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

function bufferToTypedBlob(buffer: Buffer, type: string): Blob {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return new Blob([copy], { type });
}

function safeRequestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return request.url;
  }
}

function redactId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  if (value.length <= 4) {
    return "****";
  }

  return `...${value.slice(-4)}`;
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

function createWhatsAppClient(config: KapsoAdapterConfig): WhatsAppClient {
  const accessToken = config.accessToken ?? env("WHATSAPP_ACCESS_TOKEN");
  const kapsoApiKey = config.kapsoApiKey ?? env("KAPSO_API_KEY");
  const baseUrl =
    config.baseUrl ??
    env("KAPSO_BASE_URL") ??
    (kapsoApiKey ? DEFAULT_KAPSO_BASE_URL : undefined);

  if (!accessToken && !kapsoApiKey) {
    throw new ValidationError(
      "kapso",
      "Must provide either kapsoApiKey/KAPSO_API_KEY or accessToken/WHATSAPP_ACCESS_TOKEN.",
    );
  }

  return new WhatsAppClient({
    accessToken,
    kapsoApiKey,
    baseUrl,
    graphVersion: config.graphVersion,
    fetch: config.fetch,
  });
}

function env(key: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env[key];
  return value?.trim() ? value : undefined;
}

function encodePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePart(value: string | undefined): string {
  if (!value) return "";
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new ValidationError(
      "kapso",
      "Invalid base64url Kapso thread ID part.",
    );
  }
}

function isUnifiedMessage(raw: KapsoRawMessage): raw is UnifiedMessage {
  return Boolean(
    raw &&
    typeof raw === "object" &&
    "id" in raw &&
    typeof (raw as UnifiedMessage).id === "string" &&
    "type" in raw &&
    typeof (raw as UnifiedMessage).type === "string",
  );
}

function isOutbound(raw: UnifiedMessage): boolean {
  return kapsoString(raw, "direction") === "outbound";
}

function reactionMessageId(raw: UnifiedMessage): string | undefined {
  const reaction = raw.reaction as
    | { messageId?: unknown; message_id?: unknown }
    | undefined;
  const messageId = reaction?.messageId ?? reaction?.message_id;
  return typeof messageId === "string" && messageId.length > 0
    ? messageId
    : undefined;
}

function isReactionMessage(raw: UnifiedMessage): boolean {
  return raw.type === "reaction" && Boolean(reactionMessageId(raw));
}

function isInteractiveActionMessage(raw: UnifiedMessage): boolean {
  return Boolean(interactiveReply(raw)?.id);
}

function interactiveReply(
  raw: UnifiedMessage,
): { id?: unknown; title?: unknown } | undefined {
  const interactive = raw.interactive as
    | {
        buttonReply?: { id?: unknown; title?: unknown };
        button_reply?: { id?: unknown; title?: unknown };
        listReply?: { id?: unknown; title?: unknown };
        list_reply?: { id?: unknown; title?: unknown };
      }
    | undefined;
  return (
    interactive?.buttonReply ??
    interactive?.button_reply ??
    interactive?.listReply ??
    interactive?.list_reply
  );
}

function findContact(
  contacts: Array<Record<string, unknown>>,
  raw: UnifiedMessage,
): Record<string, unknown> | undefined {
  const waId = raw.from ?? raw.to;
  return contacts.find((contact) => contactWaId(contact) === waId);
}

function contactWaId(contact?: Record<string, unknown>): string | undefined {
  const waId = contact?.waId ?? contact?.wa_id;
  return typeof waId === "string" ? waId : undefined;
}

function contactName(contact?: Record<string, unknown>): string | undefined {
  const profile = contact?.profile as Record<string, unknown> | undefined;
  const name =
    contact?.displayName ??
    contact?.profileName ??
    profile?.name ??
    contact?.name;
  return typeof name === "string" ? name : undefined;
}

function kapsoString(
  raw: UnifiedMessage,
  ...keys: string[]
): string | undefined {
  const kapso = raw.kapso as Record<string, unknown> | undefined;
  for (const key of keys) {
    const value = kapso?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function kapsoMediaData(
  raw: UnifiedMessage,
): Record<string, unknown> | undefined {
  const kapso = raw.kapso as Record<string, unknown> | undefined;
  const mediaData = kapso?.mediaData ?? kapso?.media_data;
  return mediaData && typeof mediaData === "object"
    ? (mediaData as Record<string, unknown>)
    : undefined;
}

function mediaDataString(
  raw: UnifiedMessage,
  ...keys: string[]
): string | undefined {
  const mediaData = kapsoMediaData(raw);
  for (const key of keys) {
    const value = mediaData?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function mediaByteSize(raw: UnifiedMessage): number | undefined {
  const mediaData = kapsoMediaData(raw);
  const byteSize = mediaData?.byteSize ?? mediaData?.byte_size;
  return typeof byteSize === "number" ? byteSize : undefined;
}

function messageText(raw: UnifiedMessage): string {
  if (raw.text?.body) return raw.text.body;
  if (raw.image?.caption) return raw.image.caption;
  if (raw.video?.caption) return raw.video.caption;
  if (raw.document?.caption) return raw.document.caption;
  if (raw.location) {
    return [raw.location.name, raw.location.address].filter(Boolean).join("\n");
  }
  if (raw.reaction?.emoji) return raw.reaction.emoji;
  const reply = interactiveReply(raw);
  if (typeof reply?.title === "string") return reply.title;
  const orderText = kapsoString(raw, "orderText", "order_text");
  if (orderText) return orderText;
  const content = (raw.kapso as Record<string, unknown> | undefined)?.content;
  if (typeof content === "string") return content;
  return "";
}

function mediaFromMessage(raw: UnifiedMessage): MediaSendInput | undefined {
  if (raw.image) {
    return {
      kind: "image",
      id: raw.image.id,
      link: kapsoString(raw, "mediaUrl", "media_url") ?? raw.image.link,
      caption: raw.image.caption,
      mimeType: mediaDataString(raw, "contentType", "content_type"),
    };
  }
  if (raw.video) {
    return {
      kind: "video",
      id: raw.video.id,
      link: kapsoString(raw, "mediaUrl", "media_url") ?? raw.video.link,
      caption: raw.video.caption,
      mimeType: mediaDataString(raw, "contentType", "content_type"),
    };
  }
  if (raw.audio) {
    return {
      kind: "audio",
      id: raw.audio.id,
      link: kapsoString(raw, "mediaUrl", "media_url") ?? raw.audio.link,
      mimeType: mediaDataString(raw, "contentType", "content_type"),
    };
  }
  if (raw.document) {
    return {
      kind: "document",
      id: raw.document.id,
      link: kapsoString(raw, "mediaUrl", "media_url") ?? raw.document.link,
      caption: raw.document.caption,
      filename: raw.document.filename,
      mimeType: mediaDataString(raw, "contentType", "content_type"),
    };
  }
  if (raw.sticker) {
    return {
      kind: "sticker",
      id: raw.sticker.id,
      link: kapsoString(raw, "mediaUrl", "media_url") ?? raw.sticker.link,
      mimeType: raw.sticker.mimeType,
    };
  }
  return undefined;
}

function dateFromTimestamp(timestamp: string): Date {
  const numeric = Number(timestamp);
  if (Number.isFinite(numeric)) {
    return new Date(numeric * 1000);
  }
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function compareMessages(
  a: Message<KapsoRawMessage>,
  b: Message<KapsoRawMessage>,
): number {
  return a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime();
}

function collectActions(card: CardElement): {
  actionButtons: ButtonElement[];
  linkButtons: LinkButtonElement[];
} {
  const actionButtons: ButtonElement[] = [];
  const linkButtons: LinkButtonElement[] = [];
  const visit = (children: CardElement["children"]) => {
    for (const child of children) {
      if (child.type === "actions") {
        for (const action of child.children) {
          if (action.type === "button") actionButtons.push(action);
          if (action.type === "link-button") linkButtons.push(action);
        }
      } else if (child.type === "section") {
        visit(child.children);
      }
    }
  };
  visit(card.children);
  return { actionButtons, linkButtons };
}

function fitInteractiveBody(text: string): string {
  if (text.length > INTERACTIVE_BODY_MAX_LENGTH) {
    throw new ValidationError(
      "kapso",
      `WhatsApp interactive message body must be ${INTERACTIVE_BODY_MAX_LENGTH} characters or less.`,
    );
  }
  return text;
}

function fitButtonLabel(label: string): string {
  if (label.length < 1 || label.length > BUTTON_LABEL_MAX_LENGTH) {
    throw new ValidationError(
      "kapso",
      `WhatsApp button labels must be 1-${BUTTON_LABEL_MAX_LENGTH} characters.`,
    );
  }
  return label;
}

function mediaKind(
  mimeType?: string,
  filename?: string,
): MediaSendInput["kind"] {
  const source = `${mimeType ?? ""} ${filename ?? ""}`.toLowerCase();
  if (source.includes("image/webp") || source.endsWith(".webp"))
    return "sticker";
  if (source.startsWith("image/")) return "image";
  if (source.startsWith("video/")) return "video";
  if (source.startsWith("audio/")) return "audio";
  return "document";
}

function supportsCaption(kind: MediaSendInput["kind"]): boolean {
  return kind === "image" || kind === "video" || kind === "document";
}

function firstMessageId(
  response: SendMessageResponse | undefined,
): string | undefined {
  return response?.messages?.[0]?.id;
}

function emojiToWhatsApp(emoji: EmojiValue | string): string {
  if (typeof emoji === "string") return emoji;

  const name = emoji.name;
  const map: Record<string, string> = {
    thumbs_up: "👍",
    thumbsup: "👍",
    heart: "❤️",
    fire: "🔥",
    clap: "👏",
    joy: "😂",
    smile: "🙂",
    wave: "👋",
  };
  return map[name] ?? String(emoji);
}
