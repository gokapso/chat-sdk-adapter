# Kapso WhatsApp Webhook Samples

These samples mirror the payload shape received from Meta before the adapter calls `normalizeWebhook()`.

## Text Message

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_ID",
      "changes": [
        {
          "field": "messages",
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "+1 631-555-8151",
              "phone_number_id": "16315558151"
            },
            "contacts": [
              {
                "profile": { "name": "Jane Doe" },
                "wa_id": "15551234567"
              }
            ],
            "messages": [
              {
                "from": "15551234567",
                "id": "wamid.text",
                "timestamp": "1735689600",
                "type": "text",
                "text": { "body": "Hello Kapso" }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## Media Message

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_ID",
      "changes": [
        {
          "field": "messages",
          "value": {
            "metadata": { "phone_number_id": "16315558151" },
            "messages": [
              {
                "from": "15551234567",
                "id": "wamid.image",
                "timestamp": "1735689610",
                "type": "image",
                "image": {
                  "id": "MEDIA_ID",
                  "mime_type": "image/jpeg",
                  "caption": "Receipt"
                }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## Button Reply

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_ID",
      "changes": [
        {
          "field": "messages",
          "value": {
            "metadata": { "phone_number_id": "16315558151" },
            "messages": [
              {
                "from": "15551234567",
                "id": "wamid.button",
                "timestamp": "1735689620",
                "type": "interactive",
                "context": { "id": "wamid.original" },
                "interactive": {
                  "type": "button_reply",
                  "button_reply": {
                    "id": "approve\nrefund-123",
                    "title": "Approve"
                  }
                }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## List Reply

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_ID",
      "changes": [
        {
          "field": "messages",
          "value": {
            "metadata": { "phone_number_id": "16315558151" },
            "messages": [
              {
                "from": "15551234567",
                "id": "wamid.list",
                "timestamp": "1735689630",
                "type": "interactive",
                "context": { "id": "wamid.original" },
                "interactive": {
                  "type": "list_reply",
                  "list_reply": {
                    "id": "pick\nsku-1",
                    "title": "SKU 1"
                  }
                }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## Reaction

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_ID",
      "changes": [
        {
          "field": "messages",
          "value": {
            "metadata": { "phone_number_id": "16315558151" },
            "messages": [
              {
                "from": "15551234567",
                "id": "wamid.reaction",
                "timestamp": "1735689640",
                "type": "reaction",
                "reaction": {
                  "message_id": "wamid.original",
                  "emoji": "👍"
                }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## Outbound Echo

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_ID",
      "changes": [
        {
          "field": "messages",
          "value": {
            "metadata": { "phone_number_id": "16315558151" },
            "message_echoes": [
              {
                "from": "16315558151",
                "to": "15551234567",
                "id": "wamid.echo",
                "timestamp": "1735689650",
                "type": "text",
                "text": { "body": "Outbound echo" }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## Status Update

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_ID",
      "changes": [
        {
          "field": "messages",
          "value": {
            "metadata": { "phone_number_id": "16315558151" },
            "statuses": [
              {
                "id": "wamid.original",
                "status": "delivered",
                "timestamp": "1735689660",
                "recipient_id": "15551234567"
              }
            ]
          }
        }
      ]
    }
  ]
}
```
