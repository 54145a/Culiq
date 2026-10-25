import type { JSX } from "preact";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

/** Streaming-aware markdown renderer. Streamdown repairs incomplete markdown
 *  (mid-stream LLM output), sanitizes via rehype-sanitize, and memoizes
 *  per-block so settled blocks are not re-parsed on every stream tick.
 *  Styling comes from the existing `#log .md <tag>` rules in style.css. */
export function Markdown({ children }: { children: string }) {
	return <Streamdown className="md-body">{children}</Streamdown> as unknown as JSX.Element;
}
