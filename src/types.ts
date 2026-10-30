/**
 * Type definitions for the Zalo adapter.
 *
 * Based on the Zalo Bot Platform API.
 * @see https://bot.zapps.me/docs
 */

import type { Logger } from "chat";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Zalo adapter configuration.
 */
export interface ZaloAdapterConfig {
  /** Bot token in format: 12345689:abc-xyz */
  botToken: string;
  /** Logger instance for error reporting */
  logger: Logger;
  /** Bot display name used for identification */
  userName: string;
  /** Secret token for webhook verification (8-256 chars) */
  webhookSecret: string;
}

// =============================================================================
// Thread ID
// =============================================================================

/**
 * Decoded thread ID for Zalo.
 *
 * Zalo has no threading concept. Each conversation is identified by chat.id.
 *
 * Format: zalo:{chatId}
 */
export interface ZaloThreadId {
  /** Conversation/chat ID */
  chatId: string;
}

// =============================================================================
// Webhook Payloads
// =============================================================================

/**
 * Event names delivered by the Zalo webhook (and `getUpdates`).
 *
 * `message.unsupported.received` is sent instead of the message content when
 * the sender belongs to a protected group (children, people with
 * disabilities, ...), so the content is never available to the bot.
 */
export type ZaloEventName =
  | "message.text.received"
  | "message.image.received"
  | "message.sticker.received"
  | "message.voice.received"
  | "message.unsupported.received";

/**
 * Webhook notification body (same shape as the `getUpdates` result).
 */
export interface ZaloWebhookResult {
  event_name: ZaloEventName | (string & {});
  message?: ZaloInboundMessage;
}

/** Chat type of a conversation. GROUP support is in beta on the platform. */
export type ZaloChatType = "PRIVATE" | "GROUP";

/** Inbound message type reported in `message_type`. */
export type ZaloMessageType =
  | "CHAT_TEXT"
  | "CHAT_PHOTO"
  | "CHAT_STICKER"
  | "CHAT_VOICE";

/**
 * Inbound message from a user via Zalo webhook.
 */
export interface ZaloInboundMessage {
  /** Optional caption for image messages */
  caption?: string;
  /** Chat context. Use `chat.id` as the target when replying. */
  chat: {
    chat_type: ZaloChatType;
    id: string;
  };
  /** Unix timestamp in milliseconds */
  date: number;
  /** Message sender */
  from: {
    display_name: string;
    id: string;
    is_bot: boolean;
  };
  /** Unique message ID */
  message_id: string;
  /** Message type */
  message_type?: ZaloMessageType;
  /**
   * @deprecated Older payloads used `photo`; the current API sends `photo_url`.
   */
  photo?: string;
  /** Photo URL (image messages) */
  photo_url?: string;
  /** Sticker ID */
  sticker?: string;
  /** Text content (text messages) */
  text?: string;
  /** Sticker image URL (sticker messages) */
  url?: string;
  /** Audio file URL (voice messages) */
  voice_url?: string;
}

// =============================================================================
// Raw Message Type
// =============================================================================

/**
 * Platform-specific raw message type for Zalo.
 */
export interface ZaloRawMessage {
  /** The raw inbound message data */
  message: ZaloInboundMessage;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Generic Zalo Bot API response envelope.
 */
export interface ZaloApiResponse<T = unknown> {
  description?: string;
  error_code?: number;
  ok: boolean;
  result?: T;
}

/**
 * Response from sendMessage / sendPhoto / sendSticker / sendVoice.
 */
export interface ZaloSendResponse {
  date: number;
  message_id: string;
}

/**
 * A formatting run applied to the raw `text` of `sendMessage`.
 *
 * `start` and `len` are measured in UTF-16 code units.
 * Supported codes: `b`, `i`, `u`, `s`, `f_13|15|18|20`, `c_050a19|15a85f|f7b503|f27806|db342e`,
 * `lst_1|2`, `ind_1..5`.
 */
export interface ZaloTextStyle {
  len: number;
  st: string[];
  start: number;
}

/**
 * Response from getMe.
 */
export interface ZaloGetMeResponse {
  account_name: string;
  account_type: string;
  can_join_groups: boolean;
  id: string;
}
