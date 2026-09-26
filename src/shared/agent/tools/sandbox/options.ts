/**
 * Top-level bridge helpers take a single options object, matching the
 * `@culiq/sandbox` declarations that custom tools are written against. These
 * helpers keep that shape strict so a positional call fails loudly instead of
 * reaching the tools with `"[object Object]"`.
 */

export function optsOf(args: unknown[], method: string): Record<string, unknown> {
	const first = args[0];
	if (typeof first !== "object" || first === null || Array.isArray(first)) {
		throw new Error(`sandbox.${method}(...) takes a single options object, e.g. sandbox.${method}({ ... })`);
	}
	return first as Record<string, unknown>;
}

export function optionalOpts(args: unknown[], method: string): Record<string, unknown> {
	return args[0] === undefined ? {} : optsOf(args, method);
}

export function requireString(opts: Record<string, unknown>, key: string, method: string): string {
	const value = opts[key];
	if (typeof value !== "string" || value === "") {
		throw new Error(`sandbox.${method}(...) requires { ${key}: string }`);
	}
	return value;
}

export function requireNumber(opts: Record<string, unknown>, key: string, method: string): number {
	const value = Number(opts[key]);
	if (!Number.isInteger(value)) {
		throw new Error(`sandbox.${method}(...) requires { ${key}: number }`);
	}
	return value;
}
