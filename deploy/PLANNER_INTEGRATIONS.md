# Planner integrations

## SMTP reminder delivery

The `planner-reminders` service is included in Compose but is safe by default:
it does not send until these deployment variables are configured:

```dotenv
EMAIL_BACKEND=smtp
SMTP_HOST=mail.example.com
SMTP_PORT=587
SMTP_USER=planner@example.com
SMTP_PASSWORD=<mailbox password or app password>
SMTP_FROM=planner@example.com
SMTP_TLS=true
PLANNER_REMINDER_DELIVERY_ENABLED=true
```

It checks once per minute by default. Every email attempt is recorded in
`achi_planner_reminder_delivery`, so service restarts do not duplicate sends.
Run a database snapshot before deploying because this adds a table.

## Browser push

Web Push requires a VAPID key pair and a signed-in browser subscription per
user. Do not enable or implement delivery with shared/placeholder keys. Supply
the VAPID public key, private key, subject address, and confirm the desired
consent text before this integration is enabled.

## Google Calendar / Outlook

Google Calendar requires a Google Cloud OAuth client; Outlook requires a
Microsoft Entra application registration. Before connecting either provider,
choose one-way or two-way sync, provide redirect URLs and client credentials,
and approve encrypted token storage. ACHI deliberately does not create a fake
"connected" state without those credentials.
