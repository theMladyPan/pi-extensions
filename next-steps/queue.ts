export interface QueueTask {
	id: string;
	text: string;
}

export function parseSnapshot(value: unknown): QueueTask[] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const tasks = (value as { tasks?: unknown }).tasks;
	if (!Array.isArray(tasks)) return undefined;

	const ids = new Set<string>();
	const parsed: QueueTask[] = [];
	for (const task of tasks) {
		if (!task || typeof task !== "object") return undefined;
		const { id, text } = task as { id?: unknown; text?: unknown };
		if (typeof id !== "string" || !id || typeof text !== "string" || !text.trim() || ids.has(id)) {
			return undefined;
		}
		ids.add(id);
		parsed.push({ id, text });
	}
	return parsed;
}

export function reorder(tasks: QueueTask[], id: string, offset: -1 | 1): QueueTask[] {
	const from = tasks.findIndex((task) => task.id === id);
	const to = from + offset;
	if (from < 0 || to < 0 || to >= tasks.length) return tasks;
	const next = [...tasks];
	[next[from], next[to]] = [next[to]!, next[from]!];
	return next;
}
