/** Only confirmed payments covering the locked quote can settle a Dhru order. */
export async function settledDhruTransaction(db: D1Database, orderId: string) {
	const snapshot = await db
		.prepare(
			"SELECT expected_amount_units FROM order_payment_snapshots WHERE order_id = ? LIMIT 1",
		)
		.bind(orderId)
		.first<{ expected_amount_units: string }>();
	if (!snapshot || !/^[1-9]\d*$/.test(snapshot.expected_amount_units))
		return null;
	const payments = await db
		.prepare(
			`SELECT transaction_id, amount_units FROM order_payments
			 WHERE order_id = ? AND status = 'confirmed'
			 ORDER BY confirmed_at, id`,
		)
		.bind(orderId)
		.all<{ transaction_id: string; amount_units: string }>();
	let received = 0n;
	let transactionId: string | null = null;
	for (const payment of payments.results) {
		if (!/^[1-9]\d*$/.test(payment.amount_units)) continue;
		received += BigInt(payment.amount_units);
		transactionId ??= payment.transaction_id;
	}
	return received >= BigInt(snapshot.expected_amount_units)
		? transactionId
		: null;
}
