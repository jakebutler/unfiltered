import { expect, test, vi } from "vitest";
import { canPrepareRevisedPublication, retainCompletedPublication } from "../src/publication-intent";
const receipt = { reportId: "immutable-v1", version: 1, publishedAt: 100, expiresAt: 1000 };
const review = { state: "ready", revision: 4, reviewedAt: 120 };

test("unknown and pending publication intents cannot prepare a new dispatch, even after review changes", () => {
  expect(canPrepareRevisedPublication(null, review, 3, false)).toBe(false);
  expect(canPrepareRevisedPublication(undefined, review, 3, false)).toBe(false);
  expect(canPrepareRevisedPublication(receipt, review, 3, true)).toBe(false);
  expect(canPrepareRevisedPublication(receipt, { ...review, state: "unknown" }, 3, false)).toBe(false);
});
test("known completed publication requires a changed saved review, including legacy request identifiers", () => {
  expect(canPrepareRevisedPublication(receipt, review, 3, false)).toBe(true);
  expect(canPrepareRevisedPublication(receipt, review, 4, false)).toBe(false);
  expect(canPrepareRevisedPublication(receipt, { ...review, reviewedAt: null }, 3, false)).toBe(false);
  expect(canPrepareRevisedPublication(receipt, review, null, false)).toBe(true);
  expect(canPrepareRevisedPublication(receipt, { ...review, reviewedAt: 100 }, null, false)).toBe(false);
});
test("explicit preparation archives immutable receipt before releasing the active identifier; storage failure retains reconciliation", () => {
  const values = new Map([["intent", "request-one"], ["intent.revision", "3"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const write = vi.spyOn(storage, "setItem").mockImplementationOnce(() => { throw new Error("quota"); });
  expect(() => retainCompletedPublication(storage, "intent", "request-one", receipt, 3)).toThrow("quota");
  expect(values.get("intent")).toBe("request-one");
  write.mockRestore();
  retainCompletedPublication(storage, "intent", "request-one", receipt, 3);
  expect(JSON.parse(values.get("intent.completed.request-one")!)).toEqual({ requestId: "request-one", receipt, reviewRevision: 3 });
  expect(values.has("intent")).toBe(false);
});
