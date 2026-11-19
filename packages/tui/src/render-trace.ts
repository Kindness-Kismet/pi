// Batch main-screen render diagnostics without storing conversation content.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export class RenderTrace {
	private readonly filename: string;
	private pending: string[] = [];
	private timer: NodeJS.Timeout | undefined;
	private failed = false;

	constructor(directory: string) {
		this.filename = join(directory, `pi-tui-scroll-${process.pid}.jsonl`);
		mkdirSync(directory, { recursive: true });
		process.on("exit", this.flush);
		const sessionIndex = process.argv.indexOf("--session");
		this.record("trace-start", {
			session: sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined,
			cwd: process.cwd(),
			terminalProgram: process.env.TERM_PROGRAM,
			windowsTerminal: Boolean(process.env.WT_SESSION),
		});
	}

	record(event: string, details: Record<string, unknown>): void {
		if (this.failed) return;
		this.pending.push(JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event, ...details }));
		if (this.pending.length >= 64) {
			this.flush();
		} else if (!this.timer) {
			this.timer = setTimeout(this.flush, 250);
			this.timer.unref();
		}
	}

	close(): void {
		this.flush();
		process.off("exit", this.flush);
	}

	private readonly flush = (): void => {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.pending.length === 0) return;
		const data = `${this.pending.join("\n")}\n`;
		this.pending = [];
		try {
			appendFileSync(this.filename, data);
		} catch {
			// A diagnostic file failure must not interrupt terminal rendering.
			this.failed = true;
		}
	};
}
