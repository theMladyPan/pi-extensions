import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSnapshot, reorder } from "./queue.ts";

const tasks = [
	{ id: "a", text: "first" },
	{ id: "b", text: "second" },
];

test("parseSnapshot rejects malformed state", () => {
	for (const value of [
		null,
		{},
		{ tasks: "nope" },
		{ tasks: [{ id: "a", text: 1 }] },
		{ tasks: [{ id: "a", text: "ok" }, { id: "a", text: "duplicate" }] },
	]) {
		assert.equal(parseSnapshot(value), undefined);
	}
	assert.deepEqual(parseSnapshot({ tasks: [] }), []);
});

test("reorder is safe at boundaries", () => {
	assert.deepEqual(reorder(tasks, "a", -1), tasks);
	assert.deepEqual(reorder(tasks, "b", 1), tasks);
	assert.deepEqual(reorder(tasks, "missing", 1), tasks);
});

test("reorder moves a task without mutating input", () => {
	assert.deepEqual(reorder(tasks, "b", -1), [tasks[1], tasks[0]]);
	assert.deepEqual(tasks.map((task) => task.id), ["a", "b"]);
});
