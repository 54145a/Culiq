import { streamAnthropic } from "./providers/anthropic";
import { streamOpenAI } from "./providers/openai";
import type { AssistantMessage, Context, Model, StreamEvent, StreamOptions } from "./types";

export class EventStream implements AsyncIterable<StreamEvent> {
	private queue: StreamEvent[] = [];
	private waiters: Array<(value: IteratorResult<StreamEvent>) => void> = [];
	private finalMessage: AssistantMessage | null = null;
	private resultResolvers: Array<(message: AssistantMessage) => void> = [];
	private ended = false;

	push(event: StreamEvent): void {
		if (this.ended) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);

		if (event.type === "done") this.resolveResult(event.message);
		else if (event.type === "error") this.resolveResult(event.message);
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		while (this.waiters.length > 0) {
			const w = this.waiters.shift();
			if (w) w({ value: undefined as never, done: true });
		}
	}

	private resolveResult(message: AssistantMessage): void {
		this.finalMessage = message;
		for (const r of this.resultResolvers) r(message);
		this.resultResolvers = [];
	}

	result(): Promise<AssistantMessage> {
		if (this.finalMessage) return Promise.resolve(this.finalMessage);
		return new Promise((resolve) => this.resultResolvers.push(resolve));
	}

	[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
		return {
			next: (): Promise<IteratorResult<StreamEvent>> => {
				const queued = this.queue.shift();
				if (queued) return Promise.resolve({ value: queued, done: false });
				if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
				return new Promise((resolve) => this.waiters.push(resolve));
			},
		};
	}
}

export function streamSimple(model: Model, context: Context, options: StreamOptions): EventStream {
	const stream = new EventStream();
	const run = model.provider === "anthropic" ? streamAnthropic : streamOpenAI;
	void run(model, context, options, stream).catch((err) => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			stopReason: options.signal?.aborted ? "aborted" : "error",
			errorMessage: err instanceof Error ? err.message : String(err),
		};
		stream.push({ type: "error", error: message.errorMessage ?? "unknown", message });
		stream.end();
	});
	return stream;
}
