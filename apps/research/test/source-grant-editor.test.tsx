import { beforeEach, expect, test, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceGrantEditor } from "../src/SourceGrantEditor";
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[] }));
const mutation = vi.hoisted(() => vi.fn());
vi.mock("react", async original => ({ ...await original<any>(),
  useRef(value: unknown) { const index = hooks.cursor++; return hooks.values[index] ??= { current: value }; },
  useState(value: unknown) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof value === "function" ? value() : value; return [hooks.values[index], (next: any) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }]; },
}));
vi.mock("convex/react", () => ({ useConvex: () => ({ mutation }) }));
function nodes(tree: unknown, type: string): ReactElement<any>[] {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, type));
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as ReactElement<any>;
  return [...(node.type === type ? [node] : []), ...nodes(node.props.children, type)];
}
function fixture() {
  return { scope: { clientId: "client", projectId: "project" } as any, share: { shareId: "share", revision: 0, grants: [{ evidenceId: "self-report:source:0:84", view: true, download: true }] } as any, onSaved: vi.fn() };
}
function render(props: Parameters<typeof SourceGrantEditor>[0]) { hooks.cursor = 0; return SourceGrantEditor(props); }
beforeEach(() => { hooks.cursor = 0; hooks.values = []; mutation.mockReset(); });
test("narrowing requires acknowledgement and submits the editor's original CAS revision only once", async () => {
  const props = fixture();
  nodes(render(props), "input")[1].props.onChange({ target: { checked: false } });
  let tree = render(props);
  expect(nodes(tree, "button")[0].props.disabled).toBe(true);
  nodes(tree, "input")[2].props.onChange({ target: { checked: true } });
  tree = render(props);
  let resolve!: () => void;
  mutation.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  const click = nodes(tree, "button")[0].props.onClick;
  const pending = click(); await click();
  expect(mutation).toHaveBeenCalledOnce();
  expect(mutation.mock.calls[0][1]).toEqual({ ...props.scope, shareId: "share", expectedRevision: 0, grants: [{ evidenceId: "self-report:source:0:84", view: true, download: false }] });
  resolve(); await pending;
  expect(props.onSaved).toHaveBeenCalledOnce();
});
test("a concurrent revision blocks saving and wider-permission consent denial remains visible without retry", async () => {
  const props = fixture(); props.share.grants[0].download = false;
  nodes(render(props), "input")[1].props.onChange({ target: { checked: true } });
  let tree = render(props);
  expect(JSON.stringify(tree)).toContain("restoring the selected whole-source access");
  expect(JSON.stringify(tree)).toContain("sources still listed here");
  expect(renderToStaticMarkup(tree)).toContain("Participant answer 1");
  expect(renderToStaticMarkup(tree)).not.toContain("self-report:source:0:84");
  nodes(tree, "input")[2].props.onChange({ target: { checked: true } });
  mutation.mockRejectedValue({ data: "Wider access requires a new publication preview" });
  await nodes(render(props), "button")[0].props.onClick();
  expect(JSON.stringify(render(props))).toContain("Wider access requires a new publication preview");
  expect(mutation).toHaveBeenCalledOnce();
  expect(props.onSaved).not.toHaveBeenCalled();
  props.share = { ...props.share, revision: 1 };
  tree = render(props);
  expect(nodes(tree, "button")[0].props.disabled).toBe(true);
  await nodes(tree, "button")[0].props.onClick();
  expect(mutation).toHaveBeenCalledOnce();
});
test("removing a source submits no false-permission grants, and an unconfirmed write blocks another dispatch", async () => {
  const props = fixture();
  nodes(render(props), "input")[0].props.onChange({ target: { checked: false } });
  nodes(render(props), "input")[1].props.onChange({ target: { checked: false } });
  nodes(render(props), "input")[2].props.onChange({ target: { checked: true } });
  expect(JSON.stringify(render(props))).toContain("Removing both permissions removes that source from this link’s editor after saving.");
  expect(JSON.stringify(render(props))).toContain("prepare a new publication preview");
  mutation.mockRejectedValue(new Error("transport interrupted"));
  await nodes(render(props), "button")[0].props.onClick();
  expect(mutation.mock.calls[0][1].grants).toEqual([]);
  const tree = render(props);
  expect(nodes(tree, "button")[0].props.disabled).toBe(true);
  expect(JSON.stringify(tree)).toContain("Refresh client access and reopen source permissions");
  await nodes(tree, "button")[0].props.onClick();
  expect(mutation).toHaveBeenCalledOnce();
});
