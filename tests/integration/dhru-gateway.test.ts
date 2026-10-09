import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	handleDhruGatewayRequest,
	handleDhruGetRequest,
	isAllowedDhruIpnUrl,
} from "#/features/orders/server/dhru-api";
import { matchingWebhookEndpoints } from "#/features/payments/server/payment-events";
import { processWebhookMessage } from "#/features/webhooks/server/consumer";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

describe("Dhru Fusion gateway", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const pid = "100000000001";
	const secret = "gms_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
	const key = `${pid}.${secret}`;
	const ipnUrl = "https://store.example.com/payment/callback";
	const base = {
		amount: "25.00",
		currency_code: "USD",
		description: "Invoice 1048",
		customer_name: "Maya R.",
		customer_email: "maya@example.com",
		custom_id: "1048",
		ipn_url: ipnUrl,
		success_url: "https://store.example.com/success",
		fail_url: "https://store.example.com/fail",
	};

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-dhru-gateway" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('dhru-method', 'Dhru test', 'tron', 'address', 'TTarget11111111111111111111111111', 'TTarget11111111111111111111111111', 1, ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.api_key_pepper', ?, 1, ?, ?)",
				)
				.bind(JSON.stringify("dhru-test-pepper"), now, now),
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('dhru.ipn_hosts', ?, 0, ?, ?)",
				)
				.bind(JSON.stringify(["store.example.com"]), now, now),
			db
				.prepare(
					"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, created_at, updated_at) VALUES ('dhru-key', 'Dhru', ?, ?, '[\"orders:create\",\"orders:read\"]', ?, ?)",
				)
				.bind(pid, await encryptSecret(secret, "dhru-test-pepper"), now, now),
		]);
	});

	afterAll(async () => miniflare.dispose());

	async function create(input: Partial<typeof base> = base, apiKey = key) {
		const response = await handleDhruGatewayRequest(
			new Request("https://pay.example/?action=create_order", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": apiKey },
				body: JSON.stringify(input),
			}),
			{ DB: db },
		);
		if (!response) throw new Error("Dhru root route was not handled");
		return response;
	}

	it("requires X-Api-Key and an exact public callback host", async () => {
		expect(
			await handleDhruGatewayRequest(new Request("https://pay.example/"), {
				DB: db,
			}),
		).toBeNull();
		expect(
			(
				await handleDhruGatewayRequest(
					new Request("https://pay.example/?action=ipn"),
					{ DB: db },
				)
			)?.status,
		).toBe(404);
		expect((await create(base, "wrong")).status).toBe(401);
		expect(
			(await create({ ...base, ipn_url: "https://127.0.0.1/ipn" })).status,
		).toBe(400);
		expect(
			(
				await create({
					...base,
					ipn_url: "https://store.example.com.evil.test/ipn",
				})
			).status,
		).toBe(400);
		expect((await create({ ...base, amount: "1.001" })).status).toBe(400);
		const { currency_code: _currency, ...withoutCurrency } = base;
		expect((await create(withoutCurrency)).status).toBe(400);
		expect(await isAllowedDhruIpnUrl(db, ipnUrl)).toBe(true);
	});

	it("creates one checkout, rejects conflicting replay, and keeps pending unpaid", async () => {
		const first = await create();
		expect(first.status).toBe(200);
		const body = (await first.json()) as {
			data: { order_id: number; order_url: string };
		};
		expect(Number.isSafeInteger(body.data.order_id)).toBe(true);
		expect(body.data.order_url).toMatch(
			/^https:\/\/pay\.example\/checkout\/\d{20}$/,
		);
		const replay = await create();
		expect(
			((await replay.json()) as { data: { order_id: number } }).data.order_id,
		).toBe(body.data.order_id);
		expect((await create({ ...base, amount: "26.00" })).status).toBe(409);

		const pending = await handleDhruGetRequest(
			new Request(
				`https://pay.example/?action=get_order&order_id=${body.data.order_id}`,
				{ headers: { "x-api-key": key } },
			),
			{ DB: db },
		);
		expect(
			((await pending.json()) as { data: { status: string } }).data.status,
		).toBe("Pending");
	});

	it("notifies only after a confirmed payment and returns verifiable details", async () => {
		const created = await create();
		const dhruId = ((await created.json()) as { data: { order_id: number } })
			.data.order_id;
		const mapping = await db
			.prepare("SELECT gmpay_order_id FROM dhru_orders WHERE id = ?")
			.bind(dhruId)
			.first<{ gmpay_order_id: string }>();
		if (!mapping) throw new Error("Dhru order mapping missing");
		const orderId = mapping.gmpay_order_id;
		const now = Date.now();
		await db
			.prepare(
				`INSERT INTO order_payment_snapshots
				 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
				 asset_id, asset_code, decimals, target_value, adapter,
				 required_confirmations, expected_amount_units, created_at)
				 VALUES (?, 'dhru-method', 'Dhru test', 'tron', 'chain', 'asset-usdt',
				 'USDT', 0, 'TTarget11111111111111111111111111', 'tron', 1, '25', ?)`,
			)
			.bind(orderId, now)
			.run();
		await db
			.prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?")
			.bind(now, orderId)
			.run();
		const getUrl = `https://pay.example/?action=get_order&order_id=${dhruId}`;
		const before = await handleDhruGetRequest(
			new Request(getUrl, {
				headers: { "x-api-key": key },
			}),
			{ DB: db },
		);
		expect(
			((await before.json()) as { data: { status: string } }).data.status,
		).toBe("Pending");
		expect(
			await matchingWebhookEndpoints(db, orderId, "order.pending"),
		).toEqual([]);

		await db
			.prepare(
				`INSERT INTO order_payments (id, order_id, transaction_id, amount_units, confirmations,
			 status, detected_at, confirmed_at, created_at, updated_at)
				 VALUES ('payment-dhru', ?, 'tx-dhru-confirmed', '24', 1, 'confirmed', ?, ?, ?, ?)`,
			)
			.bind(orderId, now, now, now, now)
			.run();
		const partial = await handleDhruGetRequest(
			new Request(getUrl, { headers: { "x-api-key": key } }),
			{ DB: db },
		);
		expect(
			((await partial.json()) as { data: { status: string } }).data.status,
		).toBe("Pending");
		await db
			.prepare(
				`INSERT INTO order_payments (id, order_id, transaction_id, amount_units, confirmations,
				 status, detected_at, confirmed_at, created_at, updated_at)
				 VALUES ('payment-dhru-remaining', ?, 'tx-dhru-remaining', '1', 1, 'confirmed', ?, ?, ?, ?)`,
			)
			.bind(orderId, now, now, now, now)
			.run();
		const after = await handleDhruGetRequest(
			new Request(getUrl, {
				headers: { "x-api-key": key },
			}),
			{ DB: db },
		);
		expect(await after.json()).toMatchObject({
			status: "success",
			data: {
				order_id: String(dhruId),
				amount: "25",
				custom_id: "1048",
				currency_code: "USD",
				status: "Paid",
				received_amount: "25",
				transaction_id: "tx-dhru-confirmed",
			},
		});
		expect(
			await matchingWebhookEndpoints(db, orderId, "order.paid"),
		).toHaveLength(1);
		await db.batch([
			db
				.prepare(
					"INSERT INTO webhook_events (id, order_id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-dhru', ?, 'order.paid', 'dhru-test-paid', ?, ?, ?)",
				)
				.bind(
					orderId,
					JSON.stringify({
						status: "paid",
						amount: "25",
						payment: { amount: null, asset: null },
					}),
					now,
					now,
				),
			db
				.prepare(
					"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-dhru', 'event-dhru', ?, 'dhru-key', 'queued', 0, ?, ?)",
				)
				.bind(orderId, now, now),
		]);
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 204 }));
		const ack = vi.fn();
		await processWebhookMessage(
			db,
			{
				body: {
					kind: "webhook.delivery",
					version: 1,
					deliveryId: "delivery-dhru",
					eventId: "event-dhru",
					attempt: 1,
				},
				attempts: 1,
				id: "queue-dhru",
				ack,
				retry: vi.fn(),
			},
			fetcher,
			undefined,
			{ resolveHostname: async () => ["8.8.8.8"] },
		);
		expect(ack).toHaveBeenCalledOnce();
		expect(fetcher).toHaveBeenCalledOnce();
		const call = fetcher.mock.calls[0];
		if (!call) throw new Error("Dhru callback was not sent");
		const [url, init] = call;
		expect(url).toBe(ipnUrl);
		expect(JSON.parse(String(init?.body))).toEqual({
			event: { type: "charge:confirmed", data: { order_id: dhruId } },
		});
	});
});
