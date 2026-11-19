import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Spacer, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface LabelContext {
	hiddenThinkingLabel: string;
	defaultHiddenThinkingLabel: string;
	chatContainer: Container;
	streamingComponent: AssistantMessageComponent | undefined;
	ui: TuiMainScreen;
}

const setHiddenThinkingLabel = Reflect.get(InteractiveMode.prototype, "setHiddenThinkingLabel") as (
	this: LabelContext,
	label?: string,
) => void;

function createMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "thinking content" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "example.txt" } },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

describe("hidden thinking label updates", () => {
	test("keeps completed per-message labels in scrollback when the global default is reset again", async () => {
		initTheme("dark");
		const terminal = new VirtualTerminal(80, 12);
		const ui = new TuiMainScreen(terminal);
		const history = new Container();
		const completed = new AssistantMessageComponent(createMessage(), true);
		completed.setHiddenThinkingLabel("think done");
		history.addChild(completed);
		history.addChild(new Spacer(40));
		const streaming = new AssistantMessageComponent(undefined, true);
		streaming.updateContent(createMessage(), true);
		history.addChild(streaming);
		ui.addChild(history);
		ui.addChild(new Text("editor"));
		const context: LabelContext = {
			hiddenThinkingLabel: "Thinking...",
			defaultHiddenThinkingLabel: "Thinking...",
			chatContainer: history,
			streamingComponent: streaming,
			ui,
		};
		ui.start();
		try {
			await terminal.waitForRender();
			const redraws = ui.fullRedraws;
			const revision = completed.getScrollbackState().revision;
			setHiddenThinkingLabel.call(context);
			ui.requestRender();
			await terminal.waitForRender();
			expect(ui.fullRedraws).toBe(redraws);
			expect(completed.getScrollbackState().revision).toBe(revision);
			expect(terminal.getScrollBuffer().some((line) => line.includes("think done"))).toBe(true);
			expect(completed.render(80).join("\n")).toContain("think done");
		} finally {
			ui.stop();
		}
	});

	test("applies a changed global label and restores the default", () => {
		initTheme("dark");
		const history = new Container();
		const completed = new AssistantMessageComponent(createMessage(), true);
		const streaming = new AssistantMessageComponent(undefined, true);
		streaming.updateContent(createMessage(), true);
		history.addChild(completed);
		const context: LabelContext = {
			hiddenThinkingLabel: "Thinking...",
			defaultHiddenThinkingLabel: "Thinking...",
			chatContainer: history,
			streamingComponent: streaming,
			ui: new TuiMainScreen(new VirtualTerminal()),
		};
		setHiddenThinkingLabel.call(context, "Reasoning...");
		expect(completed.render(80).join("\n")).toContain("Reasoning...");
		expect(streaming.render(80).join("\n")).toContain("Reasoning...");
		setHiddenThinkingLabel.call(context);
		expect(completed.render(80).join("\n")).toContain("Thinking...");
		expect(streaming.render(80).join("\n")).toContain("Thinking...");
	});
});
