import { useRef, useState } from "react";
import { useConvex } from "convex/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";
import type { RawGrant } from "../../../packages/research-core/src/analysis";
import { Notice } from "./components";
import { errorText, isDefinitiveError } from "./state";

const sourceLabels: Record<string, string> = {
  "self-report": "Participant answer", "dom-event": "Masked page activity",
  "screen-observation": "Screen recording", "camera-observation": "Camera recording", audio: "Audio recording",
};

export function SourceGrantEditor({ scope, share, onSaved }: {
  scope: { clientId: Id<"researchClients">; projectId: Id<"researchProjects"> };
  share: { shareId: Id<"researchShares">; revision: number; grants: RawGrant[] };
  onSaved: () => void;
}) {
  const convex = useConvex();
  const [draft, setDraft] = useState(() => share.grants.map(g => ({ ...g })));
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const busy = useRef(false);
  const expectedRevision = useRef(share.revision);
  const stale = expectedRevision.current !== share.revision;
  const changed = JSON.stringify(draft) !== JSON.stringify(share.grants);
  const widening = draft.some(g => {
    const prior = share.grants.find(p => p.evidenceId === g.evidenceId);
    return g.view && !prior?.view || g.download && !prior?.download;
  });
  function toggle(id: string, permission: "view" | "download", checked: boolean) {
    setDraft(old => old.map(g => g.evidenceId === id ? { ...g, [permission]: checked } : g));
    setAcknowledged(false);
  }
  return <div className="stack">
    <h3>Original source permissions</h3>
    <p>Changes apply only to this client link. Permissions cover each whole source. An approved excerpt or original source access must remain available for every published citation.</p>
    <p>You can restore permissions for sources still listed here, within this report’s original publication selections and current participant consent. Wider access requires a new publication preview.</p>
    <p>Removing both permissions removes that source from this link’s editor after saving. To select it again in this interface, prepare a new publication preview.</p>
    {draft.map((grant, index) => <div key={grant.evidenceId} className="evidence-choice">
      <p>{sourceLabels[grant.evidenceId.split(":")[0]] ?? "Original source"} {index + 1} · whole source</p>
      {(["view", "download"] as const).map(permission => <label className="check" key={permission}>
        <input type="checkbox" disabled={pending || stale || unconfirmed} checked={grant[permission]} onChange={event => toggle(grant.evidenceId, permission, event.target.checked)} />
        <span>Allow original source {permission}</span>
      </label>)}
    </div>)}
    {!draft.length && <p>No original sources were granted to this link. Prepare a new publication preview to release source access.</p>}
    {changed && <label className="check">
      <input type="checkbox" disabled={pending || stale || unconfirmed} checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
      <span>{widening ? "I confirm restoring the selected whole-source access within the original publication and participant consent." : "I confirm narrowing the selected source access. People can retain what they already viewed."} Existing viewers must unlock this link again after the change.</span>
    </label>}
    {stale && <Notice error>Access changed while this editor was open. Reopen source permissions to review the latest revision before saving.</Notice>}
    {error && <Notice error>{error}</Notice>}
    {unconfirmed && <Notice>Refresh client access and reopen source permissions to check the saved grant before another change.</Notice>}
    <button type="button" disabled={!changed || !acknowledged || pending || stale || unconfirmed} onClick={async () => {
      if (busy.current || stale || unconfirmed || !changed || !acknowledged) return;
      busy.current = true;
      setPending(true);
      setError("");
      try {
        await convex.mutation(api.researchPortal.updateGrants, { ...scope, shareId: share.shareId, expectedRevision: expectedRevision.current, grants: draft.filter(g => g.view || g.download) });
        onSaved();
      } catch (cause) {
        setError(errorText(cause));
        setUnconfirmed(!isDefinitiveError(cause));
      } finally {
        // Never automatically retry a permission write.
        busy.current = false;
        setPending(false);
      }
    }}>{pending ? "Saving source permissions…" : "Save source permissions"}</button>
  </div>;
}
