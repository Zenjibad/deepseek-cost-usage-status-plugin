
//#region src/index.ts
const name = "deepseek-cost-usage-status-plugin";
const inject = [
	"webServer",
	"timer",
	"subprocess",
	"llm"
];
const Config = { "~standard": {
	version: 1,
	vendor: "deepseek-cost-usage-status-plugin",
	validate(value) {
		const raw = value && typeof value === "object" ? value : {};
		const out = {};
		if (typeof raw.fallbackFxRate === "number" && Number.isFinite(raw.fallbackFxRate) && raw.fallbackFxRate > 0) out.fallbackFxRate = raw.fallbackFxRate;
		if (typeof raw.fxRefreshMs === "number" && Number.isFinite(raw.fxRefreshMs) && raw.fxRefreshMs >= 6e4) out.fxRefreshMs = Math.round(raw.fxRefreshMs);
		return { value: out };
	}
} };
function computePeakState(date) {
	const bjMs = date.getTime() + 288e5;
	const bj = new Date(bjMs);
	const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
	const isPeak = minutes >= 540 && minutes < 720 || minutes >= 840 && minutes < 1080;
	const isOffPeak = !isPeak;
	const localTime = date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit"
	});
	return {
		isOffPeak,
		isPeak,
		offPeakDiscount: isOffPeak ? .5 : 0,
		localTime,
		beijingMinutes: minutes,
		beijingTime: String(bj.getUTCHours()).padStart(2, "0") + ":" + String(bj.getUTCMinutes()).padStart(2, "0")
	};
}
const PRICING = {
	"deepseek-v4-flash": {
		input: 3,
		cacheRead: .1,
		output: 9,
		reasoning: 9,
		currency: "CNY"
	},
	"deepseek-v4-pro": {
		input: 9,
		cacheRead: .3,
		output: 27,
		reasoning: 27,
		currency: "CNY"
	}
};
function estimateCallCost(usage, model, isOffPeak, offPeakDiscount) {
	const p = PRICING[model ?? ""];
	if (!p) return null;
	const f = isOffPeak ? 1 - (offPeakDiscount || 0) : 1;
	const perTok = (perM) => perM / 1e6;
	const input = (usage?.inputTokens ?? 0) * perTok(p.input);
	const cache = (usage?.cacheReadTokens ?? 0) * perTok(p.cacheRead);
	let output = (usage?.outputTokens ?? 0) * perTok(p.output);
	const reasoning = (usage?.reasoningTokens ?? 0) * perTok(Math.max(p.reasoning - p.output, 0));
	output = output + reasoning;
	return (input + cache + output) * f;
}
function sessionCost(calls) {
	let total = 0;
	let unknown = false;
	for (const c of calls) {
		if (!c) continue;
		const cost = estimateCallCost(c.usage, c.model, c.isOffPeak, c.offPeakDiscount);
		if (cost === null) unknown = true;
else total += cost;
	}
	return {
		total,
		unknown
	};
}
function splitCurlOutput(text) {
	const s = String(text == null ? "" : text);
	const nl = s.lastIndexOf("\n");
	if (nl < 0) return {
		code: s.trim(),
		body: ""
	};
	return {
		code: s.slice(nl + 1).trim(),
		body: s.slice(0, nl)
	};
}
function parseKeyFromYaml(text) {
	const m = /(?:^|\n)[ \t]*DEEPSEEK_API_KEY[ \t]*:[ \t]*([^\s\r\n]+)/.exec(text || "");
	if (!m || !m[1]) return null;
	return m[1].replace(/^["']+|["']+$/g, "");
}
function parseBalance(text) {
	try {
		const j = JSON.parse(text);
		const first = j.balance_infos && j.balance_infos[0] || {};
		return {
			isAvailable: !!j.is_available,
			balance: first.total_balance != null ? Number(first.total_balance) : null,
			currency: first.currency || "USD"
		};
	} catch {
		return {
			isAvailable: false,
			balance: null,
			currency: "USD"
		};
	}
}
function buildBalanceArgs(apiKey) {
	return [
		"curl.exe",
		"-sS",
		"-H",
		"Authorization: Bearer " + apiKey,
		"-w",
		"\n%{http_code}",
		"https://api.deepseek.com/user/balance"
	];
}
const FX_API = "https://open.er-api.com/v6/latest/CNY";
function buildFxArgs() {
	return [
		"curl.exe",
		"-sS",
		"-w",
		"\n%{http_code}",
		FX_API
	];
}
function parseFxRates(text) {
	try {
		const j = JSON.parse(text);
		if (j.result !== "success" || !j.rates) return {
			ok: false,
			rates: {}
		};
		const rates = {};
		for (const [code, v] of Object.entries(j.rates)) {
			const n = typeof v === "number" ? v : Number(v);
			if (Number.isFinite(n) && n > 0) rates[code] = n;
		}
		return {
			ok: typeof rates["CNY"] === "number",
			rates
		};
	} catch {
		return {
			ok: false,
			rates: {}
		};
	}
}
function resolveFxRate(targetCurrency, liveRates, config) {
	if (!targetCurrency || targetCurrency === "CNY") return {
		rate: 1,
		source: "none"
	};
	const live = liveRates[targetCurrency];
	if (typeof live === "number" && Number.isFinite(live) && live > 0) return {
		rate: live,
		source: "live"
	};
	if (typeof config.fallbackFxRate === "number" && Number.isFinite(config.fallbackFxRate) && config.fallbackFxRate > 0) return {
		rate: 1 / config.fallbackFxRate,
		source: "fallback"
	};
	return null;
}
function recordUsage(sessions, sessionId, options, usage, now) {
	const s = sessions.get(sessionId);
	if (!s) return false;
	const peak = computePeakState(now);
	s.calls.push({
		usage: usage && typeof usage === "object" ? { ...usage } : null,
		model: options.model,
		isOffPeak: peak.isOffPeak,
		offPeakDiscount: peak.offPeakDiscount,
		at: now.toISOString()
	});
	s.model = options.model ?? null;
	if (s.calls.length === 1) s.startedMs = now.getTime();
	if (options.reasoningEffort) s.effort = options.reasoningEffort;
	return true;
}
async function* accumulateStream(stream, onUsage) {
	let usage;
	for await (const chunk of stream) {
		if (chunk && typeof chunk === "object" && chunk.type === "usage") usage = chunk.usage;
		yield chunk;
	}
	if (usage && typeof onUsage === "function") try {
		onUsage(usage);
	} catch {}
}
function pruneSessions(sessions, keepId) {
	for (const key of Array.from(sessions.keys())) if (key !== keepId) sessions.delete(key);
}
const EMPTY_COST = {
	ok: true,
	isOffPeak: true,
	isPeak: false,
	localTime: "",
	offPeakDiscount: .5,
	beijingTime: "",
	sessionCost: 0,
	unknownPricing: false,
	burnPerMin: null,
	costCurrency: "CNY",
	fxRate: null,
	fxSource: "none",
	model: null,
	reasoningEffort: null,
	calls: 0,
	balance: {
		balance: null,
		currency: "USD",
		isAvailable: false,
		lastFetch: null
	}
};
function apply(ctx, cfg) {
	const c = ctx;
	const fsRef = ctx.get("fs");
	const config = cfg ?? {};
	const sessions = new Map();
	const balanceState = {
		balance: null,
		currency: "USD",
		isAvailable: false,
		lastFetch: null
	};
	const fxState = {
		rates: {},
		lastFetch: null
	};
	let currentSessionId = null;
	async function resolveKey() {
		const fromEnv = process.env.DEEPSEEK_API_KEY;
		if (fromEnv) return fromEnv;
		if (fsRef === undefined) return null;
		const home = process.env.DSH_HOME || (process.env.USERPROFILE ? process.env.USERPROFILE + "/.dsh" : "");
		const candidates = [];
		if (home) candidates.push(home + "/.credentials.yaml");
		if (process.env.USERPROFILE) candidates.push(process.env.USERPROFILE + "/.dsh/.credentials.yaml");
		candidates.push(".dsh/.credentials.yaml");
		for (const cand of candidates) try {
			const target = await fsRef.resolve(cand);
			const key = parseKeyFromYaml(await fsRef.readText(target));
			if (key) return key;
		} catch {}
		return null;
	}
	let polling = false;
	async function pollBalance() {
		if (polling) return;
		polling = true;
		try {
			const apiKey = await resolveKey();
			if (!apiKey) {
				balanceState.isAvailable = false;
				return;
			}
			const sub = ctx.get("subprocess");
			if (sub === undefined) return;
			const handle = sub.spawn({
				argv: buildBalanceArgs(apiKey),
				cwd: ".",
				stdio: {
					stdin: "ignore",
					stdout: { maxBytes: 131072 },
					stderr: { maxBytes: 4096 }
				},
				graceMs: 1e4
			});
			await handle.done;
			const text = handle.collected.stdout.readFrom(0).text;
			const split = splitCurlOutput(text);
			if (split.code !== "200") {
				balanceState.isAvailable = false;
				return;
			}
			const parsed = parseBalance(split.body);
			balanceState.balance = parsed.balance;
			balanceState.currency = parsed.currency;
			balanceState.isAvailable = parsed.isAvailable;
			balanceState.lastFetch = Date.now();
		} catch {
			balanceState.isAvailable = false;
		} finally {
			polling = false;
		}
	}
	let fxPolling = false;
	async function refreshFxRates() {
		if (fxPolling) return;
		fxPolling = true;
		try {
			const sub = ctx.get("subprocess");
			if (sub === undefined) return;
			const handle = sub.spawn({
				argv: buildFxArgs(),
				cwd: ".",
				stdio: {
					stdin: "ignore",
					stdout: { maxBytes: 131072 },
					stderr: { maxBytes: 4096 }
				},
				graceMs: 1e4
			});
			await handle.done;
			const text = handle.collected.stdout.readFrom(0).text;
			const split = splitCurlOutput(text);
			if (split.code !== "200") return;
			const parsed = parseFxRates(split.body);
			if (parsed.ok) {
				fxState.rates = parsed.rates;
				fxState.lastFetch = Date.now();
			}
		} catch {} finally {
			fxPolling = false;
		}
	}
	function buildSnapshot() {
		const s = currentSessionId ? sessions.get(currentSessionId) : undefined;
		const peak = computePeakState(new Date());
		const cost = s ? sessionCost(s.calls) : {
			total: 0,
			unknown: false
		};
		let displayCurrency = "CNY";
		let fx = null;
		const balanceCurrency = balanceState.isAvailable ? balanceState.currency : "";
		if (balanceCurrency && balanceCurrency !== "CNY") {
			fx = resolveFxRate(balanceCurrency, fxState.rates, config);
			if (fx) displayCurrency = balanceCurrency;
		}
		const factor = fx ? fx.rate : 1;
		const displayCost = cost.total * factor;
		let burnPerMin = null;
		if (s && s.startedMs) {
			const elapsedMin = (Date.now() - s.startedMs) / 6e4;
			if (elapsedMin > 0 && displayCost > 0) burnPerMin = displayCost / elapsedMin;
		}
		return {
			ok: true,
			isOffPeak: peak.isOffPeak,
			isPeak: peak.isPeak,
			localTime: peak.localTime,
			offPeakDiscount: peak.offPeakDiscount,
			beijingTime: peak.beijingTime,
			sessionCost: displayCost,
			unknownPricing: cost.unknown,
			burnPerMin,
			costCurrency: displayCurrency,
			fxRate: fx ? fx.rate : null,
			fxSource: fx ? fx.source : "none",
			model: s ? s.model : null,
			reasoningEffort: s ? s.effort : null,
			calls: s ? s.calls.length : 0,
			balance: {
				balance: balanceState.balance,
				currency: balanceState.currency,
				isAvailable: balanceState.isAvailable,
				lastFetch: balanceState.lastFetch
			}
		};
	}
	ctx.effect(() => {
		const disposers = [];
		disposers.push(c.on("llm/stream", (options, next) => {
			const stream = next();
			if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return stream;
			return accumulateStream(stream, (usage) => {
				if (!currentSessionId) return;
				recordUsage(sessions, currentSessionId, options, usage, new Date());
			});
		}));
		disposers.push(c.on("agent/session-start", ({ agent }) => {
			if (!agent || !agent.id) return;
			currentSessionId = agent.id;
			if (!sessions.has(agent.id)) sessions.set(agent.id, {
				calls: [],
				startedMs: null,
				model: null,
				effort: null
			});
			pruneSessions(sessions, agent.id);
		}));
		disposers.push(c.interval(() => void pollBalance(), 6e4));
		void pollBalance();
		disposers.push(c.interval(() => void refreshFxRates(), config.fxRefreshMs ?? 36e5));
		void refreshFxRates();
		disposers.push(c.webServer.register({
			kind: "exact",
			path: "/deepseek-cost/api",
			handler: async (_req, res) => {
				try {
					const body = JSON.stringify(buildSnapshot());
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					res.end(body);
				} catch (e) {
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						...EMPTY_COST,
						ok: false,
						error: String(e?.message ?? e)
					}));
				}
			}
		}));
		return () => {
			for (const d of disposers) try {
				d();
			} catch {}
		};
	});
}

//#endregion
export { Config, FX_API, PRICING, accumulateStream, apply, buildBalanceArgs, buildFxArgs, computePeakState, estimateCallCost, inject, name, parseBalance, parseFxRates, parseKeyFromYaml, pruneSessions, recordUsage, resolveFxRate, sessionCost, splitCurlOutput };