import { notifyTelegram } from "#/features/telegram/server/telegram";
import type { WebhookQueueMessage } from "#/features/webhooks/types";
import { loadRuntimeConfig, type RuntimeConfig } from "#/server/runtime-config";

export type WebhookEndpoint = {
	id: string;
	api_key_id: string;
	url: string;
	secret_encrypted: string;
};

export type WebhookDelivery = {
	id: string;
	endpoint: WebhookEndpoint;
};

export type PaymentRuntime = Pick<Env, "DB" | "WEBHOOK_QUEUE"> & {
	waitUntil?: (promise: Promise<unknown>) => void;
};

export async function matchingWebhookEndpoints(
	db: D1Database,
	orderId: string,
	eventType: string,
) {
	const endpoint = await db
		.prepare(
			`SELECT o.id, o.notify_url AS url, k.id AS api_key_id, k.secret_encrypted
		 FROM orders o JOIN api_keys k ON k.id = o.api_key_id
		 WHERE o.id = ? AND o.notify_url IS NOT NULL
			 AND (o.api_protocol IS NULL OR o.api_protocol != 'dhru'
			      OR ? IN ('order.paid', 'order.overpaid'))
		 LIMIT 1`,
		)
		.bind(orderId, eventType)
		.first<WebhookEndpoint>();
	return endpoint ? [endpoint] : [];
}

export async function dispatchPaymentNotifications(
	env: PaymentRuntime,
	eventId: string,
	payload: Record<string, unknown>,
	deliveries: WebhookDelivery[],
	eventType: string,
) {
	const webhooks = enqueueWebhookDeliveries(env, eventId, deliveries).catch(
		() => {
			console.warn("A persisted order notification could not be dispatched");
		},
	);
	const telegram = notifyTelegram(env.DB, eventType, payload).catch(() => {
		console.warn("A persisted order Telegram notification could not be sent");
	});
	// Telegram fan-out is best-effort and must not hold the caller's response;
	// queue consumers and Cron have no waitUntil and keep awaiting it inline.
	if (env.waitUntil) env.waitUntil(telegram);
	else await telegram;
	await webhooks;
}

export async function paymentWebhookInstance(
	db: D1Database,
	configured?: RuntimeConfig,
) {
	const runtime = configured ?? (await loadRuntimeConfig(db));
	return { name: "GMPay Edge" as const, url: runtime.betterAuthUrl };
}

async function enqueueWebhookDeliveries(
	env: Pick<PaymentRuntime, "WEBHOOK_QUEUE">,
	eventId: string,
	deliveries: WebhookDelivery[],
) {
	await Promise.all(
		deliveries.map(async ({ id }) => {
			const message: WebhookQueueMessage = {
				kind: "webhook.delivery",
				version: 1,
				deliveryId: id,
				eventId,
				attempt: 1,
			};
			await env.WEBHOOK_QUEUE.send(message);
		}),
	);
}
