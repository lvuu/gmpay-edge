import {
	hasRequiredApiScope,
	parseApiScopes,
} from "#/features/api-keys/scopes";
import { claimApiRateLimit } from "#/features/api-keys/server/rate-limit";
import { constantTimeEqual } from "#/lib/crypto";
import { decryptSecret } from "#/lib/secrets";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import { loadRuntimeConfig } from "#/server/runtime-config";

export class DhruRateLimitError extends Error {}

/** The Dhru header contains the existing merchant PID and secret as PID.secret. */
export async function authenticateDhruKey(
	db: D1Database,
	header: string | null,
	scope: "orders:create" | "orders:read",
) {
	const match = /^(\d{12})\.(gms_[A-Za-z0-9_-]{40,60})$/.exec(header ?? "");
	if (!match) return null;
	const [, pid, supplied] = match;
	const now = Date.now();
	const failureBucket = `dhru-auth-fail:${pid}`;
	const windowStart = Math.floor(now / 60_000) * 60_000;
	const row = await db
		.prepare(
			`SELECT id, secret_encrypted, scopes, enabled, expires_at, revoked_at,
		 (SELECT count FROM rate_limit_counters WHERE bucket_key = ? AND window_start = ?) AS failures
		 FROM api_keys WHERE pid = ? LIMIT 1`,
		)
		.bind(failureBucket, windowStart, pid)
		.first<{
			id: string;
			secret_encrypted: string;
			scopes: string;
			enabled: number;
			expires_at: number | null;
			revoked_at: number | null;
			failures: number | null;
		}>();
	if ((row?.failures ?? 0) >= 20) throw new DhruRateLimitError();
	let valid = false;
	if (
		row?.enabled === 1 &&
		!row.revoked_at &&
		(row.expires_at === null || row.expires_at > now)
	) {
		const scopes = parseApiScopes(row.scopes);
		if (scopes && hasRequiredApiScope(scopes, scope)) {
			const runtime = await loadRuntimeConfig(db);
			if (runtime.apiKeyPepper) {
				const secret = await decryptSecret(
					row.secret_encrypted,
					runtime.apiKeyPepper,
				);
				valid = constantTimeEqual(secret, supplied ?? "");
			}
		}
	}
	if (!valid || !row) {
		const result = await claimFixedWindowRateLimit(db, {
			bucketKey: failureBucket,
			limit: 20,
			windowMs: 60_000,
			now,
		});
		if (!result.allowed) throw new DhruRateLimitError();
		return null;
	}
	const rate = await claimApiRateLimit(db, {
		apiKeyId: row.id,
		limit: 120,
		now,
	});
	if (!rate.allowed) throw new DhruRateLimitError();
	await db
		.prepare(
			`UPDATE api_keys SET last_used_at = ?, updated_at = ?
		 WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`,
		)
		.bind(now, now, row.id, now - 600_000)
		.run();
	return { apiKeyId: row.id };
}
