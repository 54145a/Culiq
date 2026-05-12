export interface SseEvent {
	event?: string;
	data: string;
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<SseEvent> {
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	let eventName: string | undefined;
	let dataLines: string[] = [];

	const flush = (): SseEvent | undefined => {
		if (dataLines.length === 0 && !eventName) {
			eventName = undefined;
			return undefined;
		}
		const event: SseEvent = { data: dataLines.join("\n") };
		if (eventName) event.event = eventName;
		eventName = undefined;
		dataLines = [];
		return event;
	};

	try {
		while (true) {
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let nlIndex: number;
			while ((nlIndex = buffer.indexOf("\n")) !== -1) {
				let line = buffer.slice(0, nlIndex);
				buffer = buffer.slice(nlIndex + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);

				if (line === "") {
					const ev = flush();
					if (ev) yield ev;
					continue;
				}
				if (line.startsWith(":")) continue;

				const colon = line.indexOf(":");
				const field = colon === -1 ? line : line.slice(0, colon);
				let val = colon === -1 ? "" : line.slice(colon + 1);
				if (val.startsWith(" ")) val = val.slice(1);

				if (field === "event") eventName = val;
				else if (field === "data") dataLines.push(val);
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) {
			for (const line of buffer.split("\n")) {
				if (line === "") {
					const ev = flush();
					if (ev) yield ev;
					continue;
				}
				if (line.startsWith(":")) continue;
				const colon = line.indexOf(":");
				const field = colon === -1 ? line : line.slice(0, colon);
				let val = colon === -1 ? "" : line.slice(colon + 1);
				if (val.startsWith(" ")) val = val.slice(1);
				if (field === "event") eventName = val;
				else if (field === "data") dataLines.push(val);
			}
		}
		const tail = flush();
		if (tail) yield tail;
	} finally {
		try {
			await reader.cancel();
		} catch {}
	}
}
