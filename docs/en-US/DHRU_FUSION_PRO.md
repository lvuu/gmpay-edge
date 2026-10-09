# Dhru Fusion Pro custom payment gateway

GMPay Edge can serve as the Custom gateway endpoint for Dhru Fusion Pro. The
integration uses GMPay's existing order, checkout, payment confirmation, and
durable Webhook outbox. It follows the [Dhru payment gateway development kit](https://github.com/dhru-com/payment-gateway-development-kit).

## Configure

1. In GMPay Edge, configure at least one ready receiving method and the required
   fiat currency. Use the payment provider's sandbox for the first end-to-end
   check.
2. Create a dedicated merchant API key with `orders:create` and `orders:read`
   scopes. In Dhru's Custom gateway API key field, enter `PID.SECRET` using the
   PID and one-time secret shown when the key is created. Keep it in
   server-side configuration.
3. In GMPay Edge **Settings → Security**, add the exact public hostname of your
   Dhru store to **Dhru callback hosts**, one hostname per line. Do not enter a
   URL or port. An empty list disables Dhru order creation. GMPay also checks
   the callback URL for public HTTPS at creation and again before delivery.
4. Set Dhru's Custom gateway POST URL to your GMPay deployment root, such as
   `https://pay.gsmsky.com/`. The deployment hostname must also be accepted by
   GMPay's **Allowed Hosts** setting.

Dhru calls `POST /?action=create_order` and `GET /?action=get_order&order_id=…`
with `X-Api-Key`. GMPay returns its hosted checkout URL, then uses its normal
provider and payment confirmation flow. The browser's success and failure URLs
do not change payment state. Provider notifications continue to use GMPay's
provider-specific endpoints; `/?action=ipn` does not accept payment status.

For one API key, repeated `create_order` calls with the same `custom_id`, amount,
currency, description, `ipn_url`, and `success_url` return the same Dhru order ID. Conflicting
replays fail. The Dhru ID is a numeric alias for GMPay's internal 20-digit order
ID. A `paid` or `overpaid` GMPay order whose confirmed transactions cover the locked payment quote is
reported as `Paid`; incomplete payments stay `Pending`, while terminal failures
are reported as `Failed`.

After confirmation, the existing durable outbox posts
`{"event":{"type":"charge:confirmed","data":{"order_id":123}}}` to the
saved, allowlisted Dhru `ipn_url`. Dhru then calls `get_order` with the API key to
verify the amount, currency, `custom_id`, transaction ID, and `Paid` status. The
outbox retries failed deliveries and records attempts. A sandbox test should
cover the actual receiving method, confirmation delay, Dhru's invoice update,
and callback retries before any production use.
