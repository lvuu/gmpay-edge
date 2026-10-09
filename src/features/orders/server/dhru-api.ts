import { z } from "zod";
import { orderAmountSchema } from "#/features/orders/schema";
import {
	createOrder,
	OrderServiceError,
} from "#/features/orders/server/create";
import {
	authenticateDhruKey,
	DhruRateLimitError,
} from "#/features/orders/server/dhru-auth";
import { settledDhruTransaction } from "#/features/orders/server/dhru-settlement";
import { getOrder } from "#/features/orders/server/query";
import { isFiatCurrencyCode } from "#/lib/fiat-currencies";
import { currencyDecimals, decimalToMinor, minorToDecimal } from "#/lib/units";
import { isSafeWebhookUrl } from "#/lib/webhook-url";
import {
	RequestBodyTooLargeError,
	readLimitedRequestText,
} from "#/server/request-body";

const httpsUrl = z
	.url()
	.max(2_048)
	.refine((value) => new URL(value).protocol === "https:");
// Dhru's PGDK accepts amount as a JSON string, int, or float and custom_id as
// a string or int (Fusion's PHP client sends both as JSON numbers).
const dhruAmountSchema = z
	.union([orderAmountSchema, z.number().finite().positive().transform(String)])
	.pipe(orderAmountSchema);
const dhruCustomIdSchema = z
	.union([z.string(), z.number().int().transform(String)])
	.pipe(z.string().min(1).max(128));
const createSchema = z.object({
	amount: dhruAmountSchema,
	currency_code: z.string().trim().toUpperCase().refine(isFiatCurrencyCode),
	description: z.string().min(1).max(500),
	customer_name: z.string().min(1).max(200),
	customer_email: z.email().max(320),
	custom_id: dhruCustomIdSchema,
	ipn_url: httpsUrl,
	success_url: httpsUrl,
	fail_url: httpsUrl,
});
type CreateInput = z.infer<typeof createSchema>;

const orderIdSchema = z.string().regex(/^[1-9]\d{0,14}$/);
const ipnHostsSchema = z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(20);

function reply(
	status: "success" | "error",
	message: string,
	data: unknown,
	httpStatus: number,
) {
	return Response.json(
		{ status, message, data },
		{
			status: httpStatus,
			headers: { "cache-control": "no-store" },
		},
	);
}

async function allowedIpnHosts(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'dhru.ipn_hosts' LIMIT 1",
		)
		.first<{ value: string }>();
	if (!row) return [];
	try {
		return ipnHostsSchema.parse(JSON.parse(row.value));
	} catch {
		return [];
	}
}

export async function isAllowedDhruIpnUrl(db: D1Database, value: string) {
	if (!isSafeWebhookUrl(value)) return false;
	const url = new URL(value);
	if (url.port || url.hostname.endsWith(".")) return false;
	const hosts = await allowedIpnHosts(db);
	return hosts.includes(url.hostname.toLowerCase());
}

/** Dhru's Custom gateway POST URL points at the site's root. */
export async function handleDhruGatewayRequest(
	request: Request,
	env: Pick<Env, "DB">,
) {
	const url = new URL(request.url);
	if (url.pathname !== "/" || !url.searchParams.has("action")) return null;
	const action = url.searchParams.get("action");
	if (action === "create_order" && request.method === "POST")
		return handleDhruCreateRequest(request, env);
	if (action === "get_order" && request.method === "GET")
		return handleDhruGetRequest(request, env);
	return reply(
		"error",
		"Unknown action.",
		null,
		action === "create_order" || action === "get_order" ? 405 : 404,
	);
}

export async function handleDhruCreateRequest(
	request: Request,
	env: Pick<Env, "DB">,
) {
	try {
		const principal = await authenticateDhruKey(
			env.DB,
			request.headers.get("x-api-key"),
			"orders:create",
		);
		if (!principal) return reply("error", "Invalid API key.", null, 401);
		if (
			!request.headers
				.get("content-type")
				?.toLowerCase()
				.includes("application/json")
		)
			return reply("error", "JSON body required.", null, 415);
		const raw = await readLimitedRequestText(request, 64 * 1024);
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			return reply("error", "Invalid JSON.", null, 400);
		}
		const parsed = createSchema.safeParse(value);
		if (!parsed.success)
			return reply("error", "Invalid order parameters.", null, 400);
		const input = parsed.data;
		if (!(await isAllowedDhruIpnUrl(env.DB, input.ipn_url)))
			return reply("error", "IPN host is not allowed.", null, 400);
		let amountMinor: string;
		try {
			amountMinor = decimalToMinor(
				input.amount,
				currencyDecimals(input.currency_code),
			).toString();
		} catch {
			return reply("error", "Invalid currency precision.", null, 400);
		}
		let existing = await findExistingDhruOrder(
			env.DB,
			principal.apiKeyId,
			input.custom_id,
		);
		if (!existing) {
			try {
				await createOrder(
					env.DB,
					{
						externalOrderId: input.custom_id,
						amount: input.amount,
						currency: input.currency_code,
						description: input.description,
						returnUrl: input.success_url,
						notifyUrl: input.ipn_url,
						metadata: { integration: "dhru" },
					},
					request.url,
					{ apiKeyId: principal.apiKeyId, apiProtocol: "dhru" },
				);
			} catch (error) {
				if (
					!(
						error instanceof OrderServiceError &&
						error.code === "external_order_exists"
					)
				)
					throw error;
			}
			existing = await findExistingDhruOrder(
				env.DB,
				principal.apiKeyId,
				input.custom_id,
			);
		}
		if (!existing || !sameOrder(existing, input, amountMinor))
			return reply(
				"error",
				"Custom ID already has different order details.",
				null,
				409,
			);
		await env.DB.prepare(
			"INSERT OR IGNORE INTO dhru_orders (gmpay_order_id) VALUES (?)",
		)
			.bind(existing.id)
			.run();
		const mapping = await env.DB.prepare(
			"SELECT id FROM dhru_orders WHERE gmpay_order_id = ? LIMIT 1",
		)
			.bind(existing.id)
			.first<{ id: number }>();
		if (!mapping || !Number.isSafeInteger(mapping.id))
			throw new Error("Dhru ID unavailable");
		const order = await getOrder(
			env.DB,
			{ id: existing.id, apiKeyId: principal.apiKeyId },
			request.url,
		);
		if (!order) throw new Error("Order unavailable");
		return reply(
			"success",
			"Order created.",
			{
				order_id: mapping.id,
				order_url: order.checkoutUrl,
			},
			200,
		);
	} catch (error) {
		if (error instanceof DhruRateLimitError)
			return reply("error", "Rate limit exceeded.", null, 429);
		if (error instanceof RequestBodyTooLargeError)
			return reply("error", "Payload too large.", null, 413);
		if (error instanceof OrderServiceError)
			return reply(
				"error",
				"Order could not be created.",
				null,
				error.status >= 500 ? 503 : 400,
			);
		console.error("dhru_create_failed");
		return reply("error", "System error.", null, 500);
	}
}

type ExistingOrder = {
	id: string;
	api_protocol: string | null;
	amount_minor: string;
	currency: string;
	notify_url: string | null;
	return_url: string | null;
	description: string | null;
};

async function findExistingDhruOrder(
	db: D1Database,
	apiKeyId: string,
	customId: string,
) {
	return db
		.prepare(
			`SELECT id, api_protocol, amount_minor, currency, notify_url, return_url, description
		 FROM orders WHERE api_key_id = ? AND external_order_id = ? LIMIT 1`,
		)
		.bind(apiKeyId, customId)
		.first<ExistingOrder>();
}

function sameOrder(
	row: ExistingOrder,
	input: CreateInput,
	amountMinor: string,
) {
	return (
		row.api_protocol === "dhru" &&
		row.amount_minor === amountMinor &&
		row.currency === input.currency_code &&
		row.notify_url === input.ipn_url &&
		row.return_url === input.success_url &&
		row.description === input.description
	);
}

export async function handleDhruGetRequest(
	request: Request,
	env: Pick<Env, "DB">,
) {
	try {
		const principal = await authenticateDhruKey(
			env.DB,
			request.headers.get("x-api-key"),
			"orders:read",
		);
		if (!principal) return reply("error", "Invalid API key.", null, 401);
		const id = new URL(request.url).searchParams.get("order_id");
		if (!orderIdSchema.safeParse(id).success)
			return reply("error", "Valid order_id is required.", null, 400);
		const row = await env.DB.prepare(
			`SELECT d.id, o.id AS gmpay_order_id, o.external_order_id, o.amount_minor,
			 o.currency_decimals, o.currency, o.description, o.status
			 FROM dhru_orders d JOIN orders o ON o.id = d.gmpay_order_id
			 WHERE d.id = ? AND o.api_key_id = ? AND o.api_protocol = 'dhru' LIMIT 1`,
		)
			.bind(id, principal.apiKeyId)
			.first<{
				id: number;
				gmpay_order_id: string;
				external_order_id: string;
				amount_minor: string;
				currency_decimals: number;
				currency: string;
				description: string | null;
				status: string;
			}>();
		if (!row) return reply("error", "Order not found.", null, 404);
		const amount = minorToDecimal(row.amount_minor, row.currency_decimals);
		const transactionId =
			row.status === "paid" || row.status === "overpaid"
				? await settledDhruTransaction(env.DB, row.gmpay_order_id)
				: null;
		const paid = Boolean(transactionId);
		const status = paid
			? "Paid"
			: ["expired", "cancelled", "failed", "refunded"].includes(row.status)
				? "Failed"
				: "Pending";
		return Response.json(
			{
				status: "success",
				message: "Order details fetched successfully!",
				data: {
					order_id: String(row.id),
					amount,
					description: row.description ?? "",
					currency_code: row.currency,
					custom_id: row.external_order_id,
					status,
					received_amount: paid ? amount : "0",
					transaction_id: paid ? transactionId : "",
				},
				timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (error) {
		if (error instanceof DhruRateLimitError)
			return reply("error", "Rate limit exceeded.", null, 429);
		console.error("dhru_get_failed");
		return reply("error", "System error.", null, 500);
	}
}
