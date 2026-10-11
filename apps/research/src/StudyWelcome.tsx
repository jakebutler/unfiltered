import { useState } from "react";
import type { StudyWelcome } from "../../../packages/research-core/src/welcome";
import type { Participant } from "./state";
import { DateTime, Notice } from "./components";

/** One descriptor and renderer supply the operator preview and participant consent. */
export function StudyWelcomePanel({ welcome, pending = false, agree }: {
  welcome: StudyWelcome;
  pending?: boolean;
  agree?: (consent: NonNullable<Participant["consent"]>) => Promise<void>;
}) {
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const test = welcome.purpose === "readiness-test";
  return <section aria-label={agree ? "Study welcome and consent" : "Participant welcome preview"}>
    <h3>{welcome.title}</h3>
    <p className="muted">{welcome.context.organization} · {welcome.context.clientName} · {welcome.context.operatorName}</p>
    <p className="introduction">{welcome.introduction}</p>
    <Notice>{test ? "Capture test only. These answers and recordings are excluded from research findings and client reports. " : ""}Use fictional details only. Do not enter personal, confidential or patient information.</Notice>
    <p>{welcome.fallback}</p>
    {welcome.prototypeUrl ? <p style={{ overflowWrap: "anywhere" }}>Study prototype: {welcome.prototypeUrl}</p> : null}
    <ul>
      <li>Screen sharing: {welcome.capture.screen === "expected" ? "requested for this study" : "optional"}.</li>
      <li>Controlled page activity: {welcome.capture.controlledDom === "expected" ? "requested for this study" : "optional"}.</li>
      <li>Camera: optional.</li>
    </ul>
    <p>{welcome.deviceNotice}</p>
    <p>Alternative: {welcome.capture.alternatePath}</p>
    <form className="consent-form" onSubmit={event => {
      event.preventDefault();
      if (!agree || pending || welcome.choices.some(choice => choice.required && !choices[choice.id])) return;
      void agree({ version: welcome.consentVersion, storage: !!choices.storage, analysis: !!choices.analysis, microphone: false, camera: false, screen: false, dom: false,
        shareTranscript: !test && !!choices.shareTranscript, shareAudio: false, shareCamera: false, shareScreen: false, shareDom: false, retainApprovedExcerpts: !test && !!choices.retainApprovedExcerpts });
    }}>
      <h4>Before we begin</h4>
      <fieldset disabled={pending || !agree}><legend>Storage, analysis and sharing</legend>
        {welcome.choices.map(choice => <label className="check" key={choice.id}>
          <input type="checkbox" required={choice.required} disabled={test && !choice.required} checked={!!choices[choice.id]} onChange={event => setChoices(old => ({ ...old, [choice.id]: event.target.checked }))} />
          <span>{choice.label}{choice.required ? " Required." : " Optional."}</span>
        </label>)}
      </fieldset>
      <p>Answers retained {welcome.lifecycle.retainUntil !== null ? <>until <DateTime value={welcome.lifecycle.retainUntil} /></> : <>for {welcome.lifecycle.retentionDays} days from session creation</>}.</p>
      <p>Invitation access {welcome.lifecycle.expiresAt !== null ? <>until <DateTime value={welcome.lifecycle.expiresAt} /></> : <>for {welcome.lifecycle.invitationDays} days from issue</>}.</p>
      <p className="muted">These choices do not publish anything or start a device. Each device requires a separate choice during the interview.{test ? " Test data cannot be shared with clients." : ""}</p>
      {agree ? <button disabled={pending || welcome.choices.some(choice => choice.required && !choices[choice.id])}>{pending ? "Saving your choices…" : "Agree and start interview"}</button> : <p className="muted">Preview only. No invitation has been created or consent submitted here.</p>}
    </form>
  </section>;
}
