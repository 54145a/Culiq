// Injected into the page's MAIN world (via chrome.scripting as a plain file,
// never a module import — relative imports and page CSP would break it).
// Wraps console methods in place (calls still reach the page's original
// console, so page behavior is preserved) and forwards serialized entries to
// the isolated content script via window.postMessage. Idempotent: re-injection
// on the same page never double-wraps.
//
// Keep this file self-contained plain JS — it must never import anything.
(function () {
	"use strict";
	if (window.__culiqConsoleShim) return;
	window.__culiqConsoleShim = true;

	var MAGIC = "culiq.console.v1";
	var TEXT_LIMIT = 2000;

	var serialize = function (value, depth) {
		if (value === null) return "null";
		if (value === undefined) return "undefined";
		var type = typeof value;
		if (type === "string") {
			return value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) + "…" : value;
		}
		if (type === "number" || type === "boolean" || type === "bigint") return String(value);
		if (type === "function") return "[function " + ((value && value.name) || "anonymous") + "]";
		if (type === "symbol") return String(value);
		if (value instanceof Error) {
			var stack = typeof value.stack === "string" ? value.stack : "";
			var head = stack.split("\n").slice(0, 4).join("\n");
			if (head.length > TEXT_LIMIT) head = head.slice(0, TEXT_LIMIT) + "…";
			return head || value.name + ": " + value.message;
		}
		if (depth <= 0) return Array.isArray(value) ? "[array]" : "[object]";
		try {
			var seen = new Set();
			var json = JSON.stringify(value, function (_key, v) {
				if (typeof v === "object" && v !== null) {
					if (seen.has(v)) return "[circular]";
					seen.add(v);
				}
				if (typeof v === "bigint") return String(v);
				if (typeof v === "function") return "[function]";
				return v;
			});
			if (json === undefined) return String(value);
			return json.length > TEXT_LIMIT ? json.slice(0, TEXT_LIMIT) + "…" : json;
		} catch {
			return "[unserializable]";
		}
	};

	var format = function (args) {
		return args
			.map(function (a) {
				return serialize(a, 2);
			})
			.join(" ")
			.slice(0, TEXT_LIMIT);
	};

	var post = function (entry) {
		try {
			window.postMessage({ magic: MAGIC, entry: entry }, "*");
		} catch {
			// Structured clone can reject on exotic arguments — dropping one
			// entry is better than breaking the page's console call.
		}
	};

	var emit = function (level, args) {
		var text = format(args);
		// Methods that print nothing on this call (groupEnd, countReset(),
		// time() start) would format as empty text — not worth a buffer slot.
		if (text.length === 0) return;
		post({ t: Date.now(), level: level, text: text });
	};

	// Level classification only — any console method not listed here is
	// recorded as "log", so future or nonstandard methods need no changes.
	var LEVELS = { debug: "debug", info: "info", warn: "warn", error: "error", trace: "trace" };

	// Enumerate instead of hardcoding method names: every function property of
	// the console object gets wrapped, whatever this browser provides.
	var names = Object.getOwnPropertyNames(console).filter(function (name) {
		if (name === "Console") return false;
		return typeof console[name] === "function";
	});

	for (var i = 0; i < names.length; i++) {
		(function (name) {
			var original = console[name].bind(console);
			var wrapped = function () {
				var args = Array.prototype.slice.call(arguments);
				if (name === "assert") {
					// console.assert only prints on a failing condition — record
					// it the same way instead of on every call.
					if (!args[0]) {
						var rest = args.slice(1);
						emit("error", rest.length > 0 ? ["Assertion failed:"].concat(rest) : ["Assertion failed:"]);
					}
				} else {
					emit(LEVELS[name] || "log", args);
				}
				return original.apply(null, args);
			};
			Object.defineProperty(console, name, {
				value: wrapped,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		})(names[i]);
	}

	window.addEventListener("error", function (event) {
		var error = event.error instanceof Error ? event.error : new Error(event.message);
		post({ t: Date.now(), level: "error", text: format([error]), source: "uncaught" });
	});

	window.addEventListener("unhandledrejection", function (event) {
		var reason = event.reason;
		post({ t: Date.now(), level: "error", text: format(["Unhandled rejection:", reason]), source: "unhandled-rejection" });
	});

	// The content script acknowledges the shim so it can tell "shim active"
	// from "shim missing" when the agent asks for console output.
	window.addEventListener("message", function (event) {
		if (event.source !== window) return;
		var data = event.data;
		if (data && data.magic === MAGIC && data.ping === "culiq") {
			window.postMessage({ magic: MAGIC, pong: true }, "*");
		}
	});
})();
