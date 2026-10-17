import { beforeEach, expect, test, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudyWelcomePanel } from "../src/StudyWelcome";
import { studyWelcome, CONSENT_CHOICES } from "../../../packages/research-core/src/welcome";
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[] }));
vi.mock("react", async original => ({ ...await original<any>(), useState(value: unknown) { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = value; return [hooks.values[i], (next: any) => { hooks.values[i] = typeof next === "function" ? next(hooks.values[i]) : next; }]; } }));
function nodes(tree: unknown, type: string): ReactElement<any>[] { if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, type)); if (!tree || typeof tree !== "object" || !("props" in tree)) return []; const node = tree as ReactElement<any>; return [...(node.type === type ? [node] : []), ...nodes(node.props.children, type)]; }
const welcome = studyWelcome({ scope: { clientId: "client", projectId: "project", studyId: "study", studyVersion: 1 }, title: "Study", introduction: "Synthetic task", prototypeUrl: null, clientName: "Client", operatorName: "Operator", captureExpectation: { screen: true, controlledDom: true, alternatePath: "Continue with text and report missing capture." } });
function render(props: Parameters<typeof StudyWelcomePanel>[0]) { hooks.cursor = 0; return StudyWelcomePanel(props); }
beforeEach(() => { hooks.cursor = 0; hooks.values = []; });
test("preview and participant share exact native wording, unchecked choices, capture expectations and honest lifecycle anchors", () => {
  const preview = renderToStaticMarkup(render({ welcome })), actual = renderToStaticMarkup(render({ welcome, agree: vi.fn() }));
  for (const label of CONSENT_CHOICES.map(choice => choice.label)) { expect(preview).toContain(label); expect(actual).toContain(label); }
  expect(preview).toContain("requested for this study"); expect(preview).toContain("Camera: optional"); expect(preview).toContain("7 days from issue"); expect(preview).toContain("30 days from session creation"); expect(preview).toContain("Preview only"); expect(preview).not.toContain("checked="); expect(preview).not.toContain("Agree and start");
});
test("preview cannot submit; real consent requires explicit required choices and starts no device or sharing by default", async () => {
  const agree = vi.fn(); const props = { welcome, agree };
  const submit = () => nodes(render(props), "form")[0].props.onSubmit({ preventDefault: vi.fn() });
  submit(); expect(agree).not.toHaveBeenCalled();
  nodes(render(props), "input")[0].props.onChange({ target: { checked: true } }); nodes(render(props), "input")[1].props.onChange({ target: { checked: true } }); submit();
  expect(agree).toHaveBeenCalledWith(expect.objectContaining({ storage: true, analysis: true, microphone: false, camera: false, screen: false, dom: false, shareTranscript: false, shareAudio: false }));
  const preview = render({ welcome }); nodes(preview, "form")[0].props.onSubmit({ preventDefault: vi.fn() }); expect(agree).toHaveBeenCalledOnce();
});
test("test welcome explicitly excludes findings/providers and cannot opt into client sharing", () => {
  const testWelcome = studyWelcome({ scope: welcome.scope, title: "Test", introduction: "Synthetic", prototypeUrl: null, clientName: "Client", operatorName: "Operator", purpose: "readiness-test", expiresAt: Date.UTC(2026, 9, 11), retainUntil: Date.UTC(2026, 10, 10) });
  const agree = vi.fn(), tree = render({ welcome: testWelcome, agree }); const html = renderToStaticMarkup(tree);
  expect(html).toContain("excluded from research findings"); expect(html).toContain("Voice, adaptive interviewing and AI analysis are disabled"); expect(html).toContain('dateTime="2026-10-11T00:00:00.000Z"'); expect(nodes(tree, "input")[2].props.disabled).toBe(true);
});
