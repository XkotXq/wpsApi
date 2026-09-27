import { Router } from "express";
import http from "node:http";
import { URL } from "node:url";
import rateLimit from "express-rate-limit";

const router = Router();

// CIP words its own errors in Chinese (e.g. a wrong password), which is no
// use to the warehouse. So a failure carries a stable `code` for the client
// to show in the language its user picked, plus a Polish `error` fallback;
// what CIP actually said only goes to the server log.
//   invalid_credentials   CIP refused the login
//   cip_unreachable       CIP couldn't be reached
//   session_expired       CIP refused the token refresh
function authError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Throttles credential-guessing against the old app's login (this route
// proxies whatever it's given straight through to CIP, so nothing else
// stops repeated attempts). Keyed by IP; the whole app is used from one
// warehouse location, so this comfortably covers real typos without
// needing a per-account counter.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zbyt wiele prób logowania. Spróbuj ponownie za kilka minut.", code: "too_many_attempts" },
});

// Same env var/behavior as wps's own SKIP_CIP_AUTH (lib/cipSession.js) -
// accepts any non-empty username/password locally instead of reaching
// CIP, for when CIP itself isn't reachable (e.g. working from home, off
// the company network/VPN). wps bypasses client-side and never calls
// this route at all under its own flag; smpda has no server side of its
// own, so the bypass has to live here instead, at the one place every
// caller's login actually goes through. Hard-disabled outside
// NODE_ENV=production builds so a leftover/misconfigured env var can
// never let every login through on a real deployment.
const SKIP_CIP_AUTH = process.env.NODE_ENV !== "production" && process.env.SKIP_CIP_AUTH === "true";

function bypassSession(username) {
  const trimmed = String(username ?? "").trim();
  return {
    access_token: "local-bypass",
    refresh_token: "local-bypass",
    expires_in: 60 * 60 * 24,
    user_info: { username: trimmed, employee: trimmed },
  };
}

// Loguje przez OAuth2 password grant starej aplikacji (framework pig4cloud).
// Na razie bez captchy - randomStr/code wysyłane puste, tak jak w przykładzie
// z konta testowego. Jeśli backend zacznie wymagać captchy, będzie trzeba
// dodać krok pobrania obrazków puzzli i sliderowe UI przed tym wywołaniem.
//
// Uses Node's http module (not fetch/undici) with insecureHTTPParser, same
// as refreshOldAppToken below and for the same reason: CIP's response has a
// few stray bytes before the real HTTP headers, which undici's strict
// parser rejects outright as "fetch failed" - curl and a relaxed parser
// both read past it fine to the real chunked JSON body underneath.
function loginToOldApp({ username, password, randomStr, code }) {
	const query = new URLSearchParams({
		grant_type: "password",
		randomStr: randomStr || "blockPuzzle",
		code: code || "",
	});
	const basicAuth = Buffer.from(
		`${process.env.OLD_APP_CLIENT_ID}:${process.env.OLD_APP_CLIENT_SECRET}`
	).toString("base64");
	const target = new URL(`${process.env.OLD_APP_BASE_URL}/auth/oauth/token?${query.toString()}`);
	const body = new URLSearchParams({ username, password }).toString();

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
					"content-type": "application/x-www-form-urlencoded",
					"content-length": Buffer.byteLength(body),
					authorization: `Basic ${basicAuth}`,
					"tenant-id": process.env.OLD_APP_TENANT_ID ?? "1",
					istoken: "false",
				},
			},
			(res) => {
				let responseBody = "";
				res.on("data", (chunk) => (responseBody += chunk));
				res.on("end", () => {
					let data = null;
					try {
						data = JSON.parse(responseBody);
					} catch {
						data = null;
					}
					if (!res.statusCode || res.statusCode >= 400 || !data?.access_token) {
						console.warn("[auth] CIP rejected the login:", data?.msg || data?.error_description || res.statusCode);
						reject(authError("invalid_credentials", "Nieprawidłowy login lub hasło"));
						return;
					}
					resolve(data);
				});
			}
		);
		req.on("error", () => reject(authError("cip_unreachable", "Nie udało się połączyć z systemem CIP.")));
		req.write(body);
		req.end();
	});
}

// What CIP says this person may do: the names in user_info.authorities (each
// entry is { authority: "..." }). Passed to the clients, which decide what to
// show - e.g. smpda hides a module its user has no access to.
function authoritiesOf(data) {
	return (data.user_info?.authorities ?? []).map((entry) => (typeof entry === "string" ? entry : entry?.authority)).filter(Boolean);
}

router.post("/login", loginLimiter, async (req, res) => {
	if (SKIP_CIP_AUTH) {
		const username = String(req.body?.username ?? "").trim();
		if (!username || !req.body?.password) {
			return res.status(400).json({ error: "Podaj login i hasło." });
		}
		const data = bypassSession(username);
		return res.json({
			token: data.access_token,
			refreshToken: data.refresh_token,
			expiresIn: data.expires_in,
			userId: data.user_info.username,
			name: data.user_info.employee,
			authorities: [],
		});
	}
	try {
		const data = await loginToOldApp(req.body ?? {});
		res.json({
			token: data.access_token,
			refreshToken: data.refresh_token,
			expiresIn: data.expires_in,
			userId: data.user_info?.username ?? req.body?.username,
			name: data.user_info?.employee ?? req.body?.username,
			authorities: authoritiesOf(data),
		});
	} catch (err) {
		res.status(401).json({ error: err.message || "Nieprawidłowy login lub hasło", code: err.code || "invalid_credentials" });
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
						console.warn("[auth] CIP rejected the token refresh:", data?.msg || data?.error_description || res.statusCode);
						reject(authError("session_expired", "Nie udało się odświeżyć sesji."));
						return;
					}
					resolve(data);
				});
			}
		);
		req.on("error", () => reject(authError("cip_unreachable", "Nie udało się połączyć z systemem CIP.")));
		req.end();
	});
}

router.post("/refresh", loginLimiter, async (req, res) => {
	const refreshToken = req.body?.refreshToken;
	if (!refreshToken) return res.status(400).json({ error: 'Wymagane pole "refreshToken".' });
	if (SKIP_CIP_AUTH && refreshToken === "local-bypass") {
		const data = bypassSession(req.body?.username ?? "bypass");
		return res.json({
			token: data.access_token,
			refreshToken: data.refresh_token,
			expiresIn: data.expires_in,
			userId: data.user_info.username,
			name: data.user_info.employee,
			authorities: [],
		});
	}
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
			authorities: authoritiesOf(data),
		});
	} catch (err) {
		res.status(401).json({ error: err.message || "Nie udało się odświeżyć sesji.", code: err.code || "session_expired" });
	}
});

export default router;
