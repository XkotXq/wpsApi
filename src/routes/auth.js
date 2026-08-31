import { Router } from "express";
import http from "node:http";
import { URL } from "node:url";

const router = Router();

// Loguje przez OAuth2 password grant starej aplikacji (framework pig4cloud).
// Na razie bez captchy - randomStr/code wysyłane puste, tak jak w przykładzie
// z konta testowego. Jeśli backend zacznie wymagać captchy, będzie trzeba
// dodać krok pobrania obrazków puzzli i sliderowe UI przed tym wywołaniem.
async function loginToOldApp({ username, password, randomStr, code }) {
	const query = new URLSearchParams({
		grant_type: "password",
		randomStr: randomStr || "blockPuzzle",
		code: code || "",
	});

	const basicAuth = Buffer.from(
		`${process.env.OLD_APP_CLIENT_ID}:${process.env.OLD_APP_CLIENT_SECRET}`
	).toString("base64");

	const res = await fetch(`${process.env.OLD_APP_BASE_URL}/auth/oauth/token?${query.toString()}`, {
		method: "POST",
		headers: {
			accept: "application/json, text/plain, */*",
			"content-type": "application/x-www-form-urlencoded",
			authorization: `Basic ${basicAuth}`,
			"tenant-id": process.env.OLD_APP_TENANT_ID ?? "1",
			istoken: "false",
		},
		body: new URLSearchParams({ username, password }).toString(),
	});

	const data = await res.json().catch(() => null);

	if (!res.ok || !data?.access_token) {
		throw new Error(data?.msg || data?.error_description || "Nieprawidłowy login lub hasło");
	}

	return data;
}

router.post("/login", async (req, res) => {
	try {
		const data = await loginToOldApp(req.body ?? {});
		res.json({
			token: data.access_token,
			refreshToken: data.refresh_token,
			expiresIn: data.expires_in,
			userId: data.user_info?.username ?? req.body?.username,
			name: data.user_info?.employee ?? req.body?.username,
		});
	} catch (err) {
		res.status(401).json({ error: err.message || "Nieprawidłowy login lub hasło" });
	}
});

// OAuth2 refresh_token grant, captured live from the old app's own UI —
// unlike the password grant above, refresh_token/grant_type/scope all go
// in the query string and there's no body at all (no content-type header
// either). Same client Basic auth and tenant/istoken headers.
//
// Uses Node's http module (not fetch/undici) with insecureHTTPParser —
// confirmed live that this endpoint's response has a few stray bytes
// before the real HTTP headers (undici's strict parser rejects it with
// "Invalid header value char" and the whole request fails as "fetch
// failed"; curl and a relaxed parser both read past it fine to the real
// chunked JSON body underneath).
function refreshOldAppToken(refreshToken) {
	const query = new URLSearchParams({
		refresh_token: refreshToken,
		grant_type: "refresh_token",
		scope: "server",
	});
	const basicAuth = Buffer.from(
		`${process.env.OLD_APP_CLIENT_ID}:${process.env.OLD_APP_CLIENT_SECRET}`
	).toString("base64");
	const target = new URL(`${process.env.OLD_APP_BASE_URL}/auth/oauth/token?${query.toString()}`);

	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: target.hostname,
				port: target.port || 80,
				path: `${target.pathname}${target.search}`,
				method: "POST",
				insecureHTTPParser: true,
				headers: {
					accept: "application/json, text/plain, */*",
					"accept-language": "pl",
					authorization: `Basic ${basicAuth}`,
					"cip-cache": String(Math.floor(Date.now() / 1000)),
					"tenant-id": process.env.OLD_APP_TENANT_ID ?? "1",
					istoken: "false",
				},
			},
			(res) => {
				let body = "";
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => {
					let data = null;
					try {
						data = JSON.parse(body);
					} catch {
						data = null;
					}
					if (!res.statusCode || res.statusCode >= 400 || !data?.access_token) {
						reject(new Error(data?.msg || data?.error_description || "Nie udało się odświeżyć sesji."));
						return;
					}
					resolve(data);
				});
			}
		);
		req.on("error", () => reject(new Error("Nie udało się połączyć z systemem CIP.")));
		req.end();
	});
}

router.post("/refresh", async (req, res) => {
	const refreshToken = req.body?.refreshToken;
	if (!refreshToken) return res.status(400).json({ error: 'Wymagane pole "refreshToken".' });
	try {
		const data = await refreshOldAppToken(refreshToken);
		res.json({
			token: data.access_token,
			// Some OAuth2 servers rotate the refresh token on use, others
			// don't return a new one — fall back to the one we sent.
			refreshToken: data.refresh_token ?? refreshToken,
			expiresIn: data.expires_in,
			userId: data.user_info?.username,
			name: data.user_info?.employee,
		});
	} catch (err) {
		res.status(401).json({ error: err.message || "Nie udało się odświeżyć sesji." });
	}
});

export default router;
