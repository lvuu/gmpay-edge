import type { OrderStatus } from "#/features/orders/schema";
import {
	displayOrderAmounts,
	type StoredOrderAmounts,
} from "#/features/payments/server/order-amounts";
import {
	dispatchPaymentNotifications,
	matchingWebhookEndpoints,
	type PaymentRuntime,
	paymentWebhookInstance,
} from "#/features/payments/server/payment-events";
import type { OrderWebhookPayload } from "#/features/webhooks/types";
import { DomainError } from "#/lib/domain-error";

export async function emitOrderStatusEvent(
	env: PaymentRuntime,
	orderId: string,
	status: OrderStatus,
	deduplicationKey: string,
): Promise<boolean> {
	const event = await prepareOrderStatusEvent(
		env,
		orderId,
		status,
		deduplicationKey,
	);
	const results = await env.DB.batch(event.statements);
	if ((results[0]?.meta.changes ?? 0) !== 1) return false;
	await event.dispatch();
	return true;
}

/** Prepare the outbox before mutation so callers can commit it with the order transition. */
export async function prepareOrderStatusEvent(
	env: PaymentRuntime,
	orderId: string,
	status: OrderStatus,
	deduplicationKey: string,
) {
	const storedOrder = await env.DB.prepare(
		`SELECT o.external_order_id, o.amount_minor, o.currency, o.currency_decimals,
		 o.received_amount_units, ops.expected_amount_units, ops.decimals,
		 ops.asset_code AS code, ops.rail_code AS network
		 FROM orders o LEFT JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 WHERE o.id = ? LIMIT 1`,
	)
		.bind(orderId)
		.first<
			StoredOrderAmounts & {
				external_order_id: string;
				currency: string;
				received_amount_units: string;
				code: string | null;
				network: string | null;
			}
		>();
	if (!storedOrder) {
		throw new DomainError(
			"payment_order_not_found",
			404,
			"Payment order not found",
		);
	}
	const order = displayOrderAmounts(storedOrder);
	const now = Date.now();
	const eventId = crypto.randomUUID();
	const eventType = `order.${status}` as const;
	const payload: OrderWebhookPayload = {
		event: eventType,
		eventId,
		createdAt: new Date(now).toISOString(),
		instance: await paymentWebhookInstance(env.DB),
		orderId,
		externalOrderId: order.external_order_id,
		status,
		amount: order.amount,
		currency: order.currency,
		payment: {
			amount: order.paymentAmount,
			asset: order.code,
			network: order.network,
			receivedAmountUnits: order.received_amount_units,
		},
		transaction: null,
	};
	const endpoints = await matchingWebhookEndpoints(env.DB, orderId, eventType);
	const deliveries = endpoints.map((endpoint) => ({
		id: crypto.randomUUID(),
		endpoint,
	}));
	const statements = [
		env.DB.prepare(
			"INSERT OR IGNORE INTO webhook_events (id, order_id, type, deduplication_key, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind(
			eventId,
			orderId,
			eventType,
			deduplicationKey,
			JSON.stringify(payload),
			now,
			now,
		),
		...deliveries.map(({ id, endpoint }) =>
			env.DB.prepare(
				`INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at)
				 SELECT ?, ?, ?, ?, 'queued', 0, ?, ? WHERE EXISTS (SELECT 1 FROM webhook_events WHERE id = ?)`,
			).bind(id, eventId, orderId, endpoint.api_key_id, now, now, eventId),
		),
	];
	return {
		statements,
		dispatch: () =>
			dispatchPaymentNotifications(
				env,
				eventId,
				payload,
				deliveries,
				eventType,
			),
	};
}
