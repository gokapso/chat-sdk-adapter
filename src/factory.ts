import { KapsoAdapter } from "./adapter";
import type { KapsoAdapterConfig } from "./types";

/** Create a Kapso WhatsApp adapter for Chat SDK. */
export function createKapsoAdapter(
  config: KapsoAdapterConfig = {},
): KapsoAdapter {
  return new KapsoAdapter(config);
}
