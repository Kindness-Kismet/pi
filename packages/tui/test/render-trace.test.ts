// Verify diagnostics through the normal renderer without changing terminal output.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TraceTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class TraceComponent implements Component {
	lines = Array.from({ length: 20 }, (_, index) => `private conversation row ${index}`);

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

interface TraceRecord {
	event: string;
	reason?: string;
	frame?: number;
	previousRows?: number;
	newRows?: number;
	previousViewportTop?: number;
	firstChanged?: number;
	lastChanged?: number;
	key?: string;
}

test("records scroll diagnostics and preserves the terminal output", async () => {
	const fixtureRoot = resolve("build", "tui-scroll-tests");
	mkdirSync(fixtureRoot, { recursive: true });
	const previousFlag = process.env.PI_TUI_DEBUG_SCROLL;
	const runs: { directory: string; writes: string[] }[] = [];
	try {
		for (const enabled of [false, true]) {
			process.env.PI_TUI_DEBUG_SCROLL = enabled ? "1" : "0";
			const directory = mkdtempSync(join(fixtureRoot, "case-"));
			const terminal = new TraceTerminal(40, 6);
			const tui = new TuiMainScreen(terminal, undefined, directory);
			const component = new TraceComponent();
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			component.lines = [...component.lines, "private appended row"];
			tui.requestRender();
			await terminal.waitForRender();
			component.lines = ["private changed historical row", ...component.lines.slice(1)];
			tui.requestRender();
			await terminal.waitForRender();
			terminal.sendInput("\x1b[H");
			terminal.sendInput("private typed input");
			terminal.resize(41, 7);
			await terminal.waitForRender();
			tui.requestRender(true);
			await terminal.waitForRender();
			tui.stop();
			await terminal.flush();
			runs.push({ directory, writes: terminal.writes });
		}
		assert.deepEqual(runs[0].writes, runs[1].writes);
		const filename = `pi-tui-scroll-${process.pid}.jsonl`;
		assert.equal(existsSync(join(runs[0].directory, filename)), false);
		const output = readFileSync(join(runs[1].directory, filename), "utf8");
		assert.equal(output.includes("private"), false);
		const records = output
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as TraceRecord);
		const redraw = records.find((record) => record.reason?.startsWith("firstChanged < viewportTop"));
		assert.ok(redraw);
		assert.equal(redraw.previousRows, 21);
		assert.equal(redraw.newRows, 21);
		assert.equal(redraw.previousViewportTop, 15);
		assert.equal(redraw.firstChanged, 0);
		assert.equal(redraw.lastChanged, 0);
		assert.ok(records.some((record) => record.event === "differential-render"));
		assert.ok(records.some((record) => record.event === "input-key" && record.key === "home"));
		assert.ok(records.some((record) => record.reason?.startsWith("terminal width changed")));
		assert.ok(records.some((record) => record.event === "reset-render-state"));
		assert.equal(records.at(-1)?.event, "trace-stop");
	} finally {
		if (previousFlag === undefined) delete process.env.PI_TUI_DEBUG_SCROLL;
		else process.env.PI_TUI_DEBUG_SCROLL = previousFlag;
	}
});
