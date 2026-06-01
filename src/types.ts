import type {
  LogLevel,
  Logger,
  RawMessage,
} from "chat";
import type {
  SendMessageResponse,
  UnifiedMessage,
  WhatsAppClient,
  WhatsAppClientConfig,
} from "@kapso/whatsapp-cloud-api";

/** Decoded Kapso/WhatsApp thread ID components. */
export interface KapsoThreadId {
  /** WhatsApp Business phone number ID used to send/receive the conversation. */
  phoneNumberId: string;
  /** Customer WhatsApp ID or phone number. */
  waId: string;
  /** Kapso conversation ID when loaded from Kapso history APIs. */
  conversationId?: string;
}

/** Configuration for the Kapso Chat SDK adapter. */
export interface KapsoAdapterConfig extends WhatsAppClientConfig {
  /** Existing Kapso WhatsApp SDK client. When set, credential fields are not used to construct a client. */
  client?: WhatsAppClient;
  /** Kapso webhook secret used to verify X-Webhook-Signature deliveries. */
  webhookSecret?: string;
  /** Meta app secret used to verify X-Hub-Signature-256 webhook POST requests. */
  appSecret?: string;
  /** Meta webhook verify token used for webhook subscription challenge requests. */
  webhookVerifyToken?: string;
  /** Whether POST webhook signatures must verify. Defaults to true for Kapso and Meta webhook modes. */
  verifyWebhookSignatures?: boolean;
  /** Kapso/WhatsApp Business phone number ID for openDM and fallback parsing. */
  phoneNumberId?: string;
  /** Bot display name used by Chat SDK message display. Defaults to "kapso". */
  userName?: string;
  /** Logger instance. Defaults to Chat SDK's ConsoleLogger until initialized. */
  logger?: Logger;
  /**
   * Emit verbose adapter diagnostics to the configured logger at info level.
   * Useful while testing webhook tunnels and production-like flows.
   */
  debug?: boolean;
  /** Console logger level used when no custom logger is supplied. Defaults to "debug" when debug is true, otherwise "info". */
  logLevel?: LogLevel;
  /** Kapso message history fields selector. Defaults to common content/media fields. */
  historyFields?: string;
  /** Maximum messages kept in adapter memory for fallback history. Defaults to 200. */
  cacheSize?: number;
}

/** Raw webhook payload after Kapso SDK normalization. */
export type KapsoWebhookMessage = UnifiedMessage;

/** Raw payloads returned by adapter methods. */
export type KapsoRawMessage =
  | UnifiedMessage
  | SendMessageResponse
  | KapsoMultiSendResponse
  | Record<string, unknown>;

/** Raw response returned when one Chat SDK post maps to multiple WhatsApp sends. */
export interface KapsoMultiSendResponse {
  responses: SendMessageResponse[];
}

/** Raw message envelope returned by Kapso adapter send methods. */
export type KapsoRawMessageResult = RawMessage<KapsoRawMessage>;
