import { LOG_CHANNEL_IDS } from "../config";

let counter = 0;

// Round-robin picker across configured log channels. Each call returns the next
// channel ID in sequence, wrapping around after the last one.
export function pickLogChannel(): number {
  const channelId = LOG_CHANNEL_IDS[counter % LOG_CHANNEL_IDS.length];
  counter++;
  return channelId;
}
