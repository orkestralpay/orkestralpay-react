# Demo store

A small merchant integration used for sandbox tests and presentations. It shows the flow a real merchant implements:

1. The buyer fills in the checkout page (items, personal data, billing address). Credit card is the only payment method.
2. The **store backend** validates the data, computes the total, logs in to the Orkestral API with the merchant credentials and creates a PaymentIntent (`POST /v1/payment-intents/{merchantId}`, `payment_method: CREDIT_CARD`).
3. The buyer is redirected to the Orkestral checkout (`{CHECKOUT_URL}/{paymentIntentId}`), where the card is typed in the Hosted Fields.

The merchant secret and the order total never reach the browser. This is example code: no persistence, no real catalog, not for production.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `ORKESTRAL_API_URL` | yes | Orkestral API base URL (creates the PaymentIntent), e.g. `https://api-dev.orkestralpay.com.br` |
| `ORKESTRAL_AUTH_URL` | no | OAuth base URL when it differs from the API (`/oauth2/token`). Defaults to `ORKESTRAL_API_URL` |
| `CHECKOUT_URL` | yes | Orkestral checkout base URL, e.g. `https://checkout-dev.orkestralpay.com.br` |
| `MERCHANT_ID` | yes | Sandbox merchant id |
| `MERCHANT_CLIENT_ID` | no | OAuth client id. Defaults to `MERCHANT_ID` (merchants are OAuth clients) |
| `MERCHANT_CLIENT_SECRET` | yes | Merchant secret (keep it in a secret store) |
| `MERCHANT_API_USERNAME` / `MERCHANT_API_PASSWORD` | yes | An API user of that merchant |
| `PUBLIC_URL` | no | Public URL of this store (used in `ok_url`/`error_url`). Defaults to `http://localhost:{PORT}` |
| `PSP_MOCK_URL` | no | Local only: PSP mock control URL. Enables the scenario shortcuts (approved, declined, PSP timeout) |
| `DEMO_PANEL` | no | Local only: `1` enables `/painel`, a live view of how each order went through the merchant payment flow (PSP attempts, fallback, and the request/response sent to each PSP, masked). It reads the local Postgres containers through `docker exec` and records PSP calls when the services point their PSP URLs to `/psp/<psp>` on this store. Not for shared environments as is. |
| `PORT` | no | Defaults to `4030` |

The sandbox merchant needs, in the Orkestral portal: an active agreement with a PSP that accepts credit card in Brazil (sandbox credentials), a credit card fee, an active payment flow for `CREDIT_CARD`, and its public key (generated at sign-up).

```bash
docker build -t demo-store examples/demo-store
docker run -p 4030:4030 --env-file demo-store.env demo-store
```

Tests: `npx vitest run examples/demo-store`.
