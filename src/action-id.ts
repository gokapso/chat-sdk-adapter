import { ValidationError } from "@chat-adapter/shared";

const KAPSO_ACTION_ID_DELIMITER = "\n";
const WHATSAPP_INTERACTIVE_ID_MAX_LENGTH = 256;

export function encodeKapsoActionId(actionId: string, value?: string): string {
  if (value == null || value === "") {
    validateActionIdLength(actionId);
    return actionId;
  }

  const encoded = `${actionId}${KAPSO_ACTION_ID_DELIMITER}${value}`;
  validateActionIdLength(encoded);
  return encoded;
}

export function decodeKapsoActionId(id: string): {
  actionId: string;
  value: string | undefined;
} {
  const index = id.indexOf(KAPSO_ACTION_ID_DELIMITER);
  if (index === -1) {
    return { actionId: id, value: undefined };
  }

  return {
    actionId: id.slice(0, index),
    value: id.slice(index + KAPSO_ACTION_ID_DELIMITER.length),
  };
}

function validateActionIdLength(value: string): void {
  if (value.length < 1 || value.length > WHATSAPP_INTERACTIVE_ID_MAX_LENGTH) {
    throw new ValidationError(
      "kapso",
      `WhatsApp interactive reply id must be 1-${WHATSAPP_INTERACTIVE_ID_MAX_LENGTH} characters. Shorten the button id or value.`,
    );
  }
}
