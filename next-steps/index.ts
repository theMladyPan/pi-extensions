import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import { parseSnapshot, reorder, type QueueTask } from "./queue.ts";

const ENTRY_TYPE = "next-steps-queue";
const STATUS_ID = "next-steps";

type PanelResult = { editId: string } | undefined;

export default function (pi: ExtensionAPI) {
	let tasks: QueueTask[] = [];
	let dispatching = false;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_ID, tasks.length ? `next steps: ${tasks.length}` : undefined);
	}

	function persist(ctx: ExtensionContext): void {
		pi.appendEntry(ENTRY_TYPE, { tasks: tasks.map((task) => ({ ...task })) });
		updateStatus(ctx);
	}

	function dispatchOne(ctx: ExtensionContext): void {
		if (dispatching || !ctx.isIdle() || tasks.length === 0) return;
		dispatching = true;
		const task = tasks.shift()!;
		persist(ctx);
		try {
			pi.sendUserMessage(task.text);
		} catch (error) {
			ctx.ui.notify(`Could not dispatch next step: ${String(error)}`, "error");
		} finally {
			dispatching = false;
		}
	}

	async function openPanel(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Next-step queue requires TUI mode", "warning");
			return;
		}

		while (true) {
			const result = await ctx.ui.custom<PanelResult>((tui, theme, _keybindings, done) => {
				let selectedId = tasks[0]?.id;

				function selectedIndex(): number {
					if (tasks.length === 0) {
						selectedId = undefined;
						return -1;
					}
					const index = tasks.findIndex((task) => task.id === selectedId);
					if (index >= 0) return index;
					selectedId = tasks[0]!.id;
					return 0;
				}

				return {
					render(width: number): string[] {
						const selected = selectedIndex();
						const lines = [theme.fg("accent", theme.bold(`Next steps (${tasks.length})`)), ""];
						if (tasks.length === 0) lines.push(theme.fg("dim", "Queue empty"));
						for (const [index, task] of tasks.entries()) {
							const prefix = index === selected ? theme.fg("accent", "> ") : "  ";
							lines.push(prefix + theme.fg(index === selected ? "text" : "muted", task.text));
						}
						lines.push("", theme.fg("dim", "↑↓ select  alt+↑↓ move  del remove  enter edit  esc close"));
						return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
					},
					handleInput(data: string): void {
						const index = selectedIndex();
						if (matchesKey(data, Key.escape)) return done(undefined);
						if (matchesKey(data, Key.enter) && selectedId) return done({ editId: selectedId });
						if (matchesKey(data, Key.alt("up")) && selectedId) {
							const next = reorder(tasks, selectedId, -1);
							if (next !== tasks) {
								tasks = next;
								persist(ctx);
							}
						} else if (matchesKey(data, Key.alt("down")) && selectedId) {
							const next = reorder(tasks, selectedId, 1);
							if (next !== tasks) {
								tasks = next;
								persist(ctx);
							}
						} else if (matchesKey(data, Key.up) && index > 0) {
							selectedId = tasks[index - 1]!.id;
						} else if (matchesKey(data, Key.down) && index >= 0 && index < tasks.length - 1) {
							selectedId = tasks[index + 1]!.id;
						} else if (matchesKey(data, Key.delete) && selectedId) {
							tasks = tasks.filter((task) => task.id !== selectedId);
							selectedId = tasks[Math.min(index, tasks.length - 1)]?.id;
							persist(ctx);
						}
						tui.requestRender();
					},
					invalidate(): void {},
				};
			}, {
				overlay: true,
				overlayOptions: {
					anchor: "bottom-center",
					width: "70%",
					minWidth: 40,
					maxHeight: "60%",
					margin: 1,
				},
			});

			if (!result) return;
			const task = tasks.find((item) => item.id === result.editId);
			if (!task) continue;
			const edited = await ctx.ui.editor("Edit next step", task.text);
			if (edited === undefined) continue;
			const text = edited.trim();
			if (!text) {
				ctx.ui.notify("Next step cannot be empty", "warning");
				continue;
			}
			const current = tasks.find((item) => item.id === result.editId);
			if (current) {
				current.text = text;
				persist(ctx);
			}
		}
	}

	function queueTask(ctx: ExtensionContext, text: string): void {
		const startsNow = ctx.isIdle();
		tasks.push({ id: randomUUID(), text });
		persist(ctx);
		ctx.ui.notify(startsNow ? "Starting next step" : `Queued next step (${tasks.length} pending)`, "info");
		if (startsNow) dispatchOne(ctx);
	}

	pi.registerShortcut(Key.ctrl("q"), {
		description: "Queue editor text as the next step",
		handler: async (ctx) => {
			const text = ctx.ui.getEditorText().trim();
			if (text) {
				ctx.ui.setEditorText("");
				queueTask(ctx, text);
				return;
			}

			const entered = await ctx.ui.editor("Queue next step", "");
			if (entered?.trim()) queueTask(ctx, entered.trim());
		},
	});

	pi.registerShortcut(Key.ctrlShift("q"), {
		description: "Open the next-step queue",
		handler: openPanel,
	});

	pi.on("session_start", (_event, ctx) => {
		tasks = [];
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index]!;
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const restored = parseSnapshot(entry.data);
			if (restored) {
				tasks = restored;
				break;
			}
		}
		updateStatus(ctx);
		if (ctx.isIdle()) dispatchOne(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		dispatchOne(ctx);
	});
}
