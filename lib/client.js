window.__ModuleLoader__.load({ id: "deepseek-cost-usage-status-plugin", factory: (require) => {
"use strict";
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
const react = __toESM(require("react"));

//#region src/client/index.tsx
const inject = ["slots"];
const POLL_MS = 2e3;
const API = "/deepseek-cost/api";
/** Port of the dynamic plugin's renderSnapshot; burn rate now uses the cost currency. */
function renderSnapshot(snap) {
	if (snap === null || snap.ok !== true) return {
		peakChip: {
			text: "…",
			color: "#808080"
		},
		costText: "Cost …",
		burnText: "~—/min",
		balanceText: "Balance —",
		modelText: ""
	};
	const localTime = snap.localTime == null ? "" : snap.localTime;
	const pct = Math.round((snap.offPeakDiscount || 0) * 100);
	const peakChip = snap.isOffPeak === true ? {
		text: "● Off-peak " + localTime + " · −" + pct + "%",
		color: "#2e7d32"
	} : {
		text: "● Peak " + localTime,
		color: "#c62828"
	};
	const cost = typeof snap.sessionCost === "number" && Number.isFinite(snap.sessionCost) ? snap.sessionCost : 0;
	const costSymbol = snap.costCurrency === "CNY" ? "¥" : "$";
	const costText = "Cost " + costSymbol + cost.toFixed(4);
	let burnText = "~—/min";
	if (snap.burnPerMin != null) {
		const burn = Number(snap.burnPerMin);
		if (Number.isFinite(burn)) burnText = "~" + costSymbol + burn.toFixed(2) + "/min";
	}
	let balanceText = "Balance —";
	const b = snap.balance;
	if (b && b.isAvailable && b.balance != null) {
		const bal = Number(b.balance);
		if (Number.isFinite(bal)) {
			const currency = b.currency;
			balanceText = currency && currency !== "USD" ? "Balance " + bal.toFixed(2) + " " + currency : "Balance $" + bal.toFixed(2);
		}
	}
	const modelText = snap.model ? "Model " + snap.model : "";
	return {
		peakChip,
		costText,
		burnText,
		balanceText,
		modelText
	};
}
function apply(ctx) {
	const slots = ctx.get("slots");
	if (slots === undefined) return;
	let snapshot = null;
	let lastGood = null;
	const listeners = new Set();
	async function poll() {
		try {
			const res = await fetch(API, { cache: "no-store" });
			if (!res.ok) throw new Error("HTTP " + res.status);
			snapshot = await res.json();
			if (snapshot.ok) lastGood = snapshot;
		} catch (e) {
			snapshot = {
				ok: false,
				error: String(e?.message ?? e)
			};
		}
		for (const fn of listeners) fn();
	}
	void poll();
	const timer = setInterval(() => void poll(), POLL_MS);
	ctx.effect(() => () => {
		clearInterval(timer);
		listeners.clear();
	});
	function useSnapshot() {
		const [state, setState] = react.default.useState(snapshot);
		react.default.useEffect(() => {
			const fn = () => {
				let out = snapshot;
				if (snapshot && !snapshot.ok && lastGood !== null) out = {
					...lastGood,
					stale: true
				};
				setState(out);
			};
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		}, []);
		return state;
	}
	function DockLine() {
		const snap = useSnapshot();
		const r = renderSnapshot(snap);
		return react.default.createElement("span", {
			className: "dsb-line",
			style: {
				fontSize: 12,
				lineHeight: "20px",
				color: "var(--dsw-alias-label-tertiary)",
				textAlign: "center",
				whiteSpace: "nowrap",
				display: "block",
				width: "100%",
				paddingTop: 2
			}
		}, react.default.createElement("span", { style: {
			color: r.peakChip.color,
			fontWeight: 600
		} }, r.peakChip.text), react.default.createElement("span", { style: {
			color: "var(--dsw-alias-separator-primary)",
			margin: "0 10px"
		} }, "·"), react.default.createElement("span", null, r.costText), react.default.createElement("span", { style: {
			color: "var(--dsw-alias-separator-primary)",
			margin: "0 10px"
		} }, "·"), react.default.createElement("span", null, r.burnText), react.default.createElement("span", { style: {
			color: "var(--dsw-alias-separator-primary)",
			margin: "0 10px"
		} }, "·"), react.default.createElement("span", null, r.balanceText), r.modelText ? react.default.createElement("span", { style: {
			color: "var(--dsw-alias-separator-primary)",
			margin: "0 10px"
		} }, "·") : null, r.modelText ? react.default.createElement("span", null, r.modelText) : null);
	}
	slots.inject("conversation.composer.dock", () => slots.register({
		name: "conversation.composer.dock",
		id: "deepseek-cost-status",
		order: 1
	}, () => react.default.createElement(DockLine)));
}

//#endregion
exports.apply = apply
exports.inject = inject
return module.exports; } });
//# sourceMappingURL=client.js.map