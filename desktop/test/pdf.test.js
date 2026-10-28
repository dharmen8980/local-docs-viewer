// pdf.ts deadline helper under plain Node: a promise that never settles (a hung print page's
// executeJavaScript / printToPDF) must still fail the render, so the serialised queue advances.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { within, PRINT_SLACK_MS } = require("../dist/pdf");

test("within: settles, times out, never leaks", async () => {
  assert.equal(await within(Promise.resolve(7), 1000, () => new Error("late")), 7);
  await assert.rejects(within(Promise.reject(new Error("boom")), 1000, () => new Error("late")), /boom/);
  const started = Date.now();
  await assert.rejects(within(new Promise(() => {}), 50, () => new Error("stuck")), /stuck/);
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(within(new Promise(() => {}), -5, () => new Error("past")), /past/);
  // the loser rejecting later is not an unhandled rejection
  let fail;
  const late = new Promise((_r, j) => (fail = j));
  await assert.rejects(within(late, 10, () => new Error("stuck")), /stuck/);
  fail(new Error("late reject"));
  await new Promise((r) => setTimeout(r, 20));
  // Python's own timeout is nav + ready + 60s: Electron must give up first
  assert.ok(PRINT_SLACK_MS < 60_000);
});
