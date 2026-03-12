// Maps known GramJS / MTProto / internal error strings to messages safe to
// show end users and admins. Never exposes raw error codes, phone numbers,
// or stack traces. Falls back to a generic message for anything unrecognised.

const GENERIC = "❌ Something went wrong. Please try again later.";

const ERROR_MAP: Array<{ pattern: RegExp; message: string }> = [
  // Session / auth key revoked
  { pattern: /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED/i, message: GENERIC },

  // Phone number problems (addsession flow)
  { pattern: /PHONE_NUMBER_INVALID/i,      message: "❌ Invalid phone number format." },
  { pattern: /PHONE_NUMBER_BANNED/i,       message: "❌ This phone number is banned by Telegram." },
  { pattern: /PHONE_NUMBER_UNOCCUPIED/i,   message: "❌ This phone number is not registered on Telegram." },

  // Login code problems (addsession flow)
  { pattern: /PHONE_CODE_INVALID/i,        message: "❌ Invalid login code. Please try again." },
  { pattern: /PHONE_CODE_EXPIRED/i,        message: "❌ Login code expired. Please restart /addsession." },

  // 2FA password (addsession flow)
  { pattern: /PASSWORD_HASH_INVALID/i,     message: "❌ Incorrect 2FA password." },

  // Flood / rate limiting
  { pattern: /FLOOD_WAIT/i,               message: "❌ Too many requests. Please wait a few minutes and try again." },

  // Target account not found or deactivated
  { pattern: /PEER_ID_INVALID|USERNAME_INVALID|USERNAME_NOT_OCCUPIED|INPUT_USER_DEACTIVATED/i,
                                           message: "❌ That account could not be found." },

  // Access / privacy restrictions
  { pattern: /CHAT_RESTRICTED|USER_PRIVACY_RESTRICTED/i,
                                           message: "❌ Stories for this account are not accessible." },

  // File reference expired (stale media reference — transient, retrying helps)
  { pattern: /FILE_REFERENCE_EXPIRED|FILE_REFERENCE_INVALID/i, message: GENERIC },

  // Download / network timeouts
  { pattern: /timeout/i,                   message: "❌ The request timed out. Please try again." },

  // Session pool exhausted (shown to end user)
  { pattern: /All sessions are busy/,      message: "⏳ Service is busy. Please try again in a moment." },

  // Interrupted addsession state (auth client lost on restart)
  { pattern: /Auth client not found/,      message: "❌ Session setup was interrupted. Please restart /addsession." },
];

export function toUserMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  for (const { pattern, message } of ERROR_MAP) {
    if (pattern.test(msg)) return message;
  }
  return GENERIC;
}
