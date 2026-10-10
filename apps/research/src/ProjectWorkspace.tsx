import { useState, type FormEvent } from "react";
import { useConvex } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { usePages, useRead } from "./data";
import { CaptureSources, PrototypeAuthorization } from "./CaptureSources";
import { useNavigationGuard, useStudyDraftProtection } from "./navigation";
import { DateTime, Field, Notice, Pages, SourceList } from "./components";
import {
  emptyStudy,
  clearSessionItem,
  errorText,
  invitationUrl,
  isDefinitiveError,
  type Study,
} from "./state";

type Scope = {
  clientId: Id<"researchClients">;
  projectId: Id<"researchProjects">;
};
type Project = FunctionReturnType<typeof api.research.project>["project"];
export function ProjectWorkspace({
  clientId,
  projectId,
  onBack,
}: Scope & { onBack: () => void }) {
  const allowNavigation = useNavigationGuard();
  const scope = { clientId, projectId };
  const record = useRead(api.research.project, scope);
  const [tab, setTab] = useState<"study" | "invitations" | "sessions">("study");
  const [editing, setEditing] = useState(false);
  if (record.error)
    return (
      <Notice error>
        {record.error} <button onClick={record.refresh}>Refresh project</button>
      </Notice>
    );
  if (!record.data) return <p role="status">Opening project…</p>;
  const { client, project } = record.data;
  const active = client.state === "active" && project.state === "active";
  return (
    <>
      <nav className="breadcrumbs" aria-label="Project location">
        <button className="text-button" onClick={onBack}>
          {client.name}
        </button>
        <span aria-hidden="true">/</span>
        <span>{project.name}</span>
      </nav>
      <div className="page-heading">
        <div>
          <h1>{project.name}</h1>
          <p className="muted">
            {active
              ? "Private client research"
              : "Archived · participant access is stopped"}
          </p>
        </div>
        <button className="secondary" onClick={() => setEditing(!editing)}>
          Project settings
        </button>
      </div>
      {editing && (
        <ProjectSettings
          scope={scope}
          project={project}
          close={() => setEditing(false)}
        />
      )}
      <nav className="tabs" aria-label="Project sections">
        {(["study", "invitations", "sessions"] as const).map((value) => (
          <button
            key={value}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => {
              if (tab === value || allowNavigation()) setTab(value);
            }}
          >
            {value === "study"
              ? "Study setup"
              : value === "invitations"
                ? "Invitations"
                : "Sessions & sources"}
          </button>
        ))}
      </nav>
      {tab === "study" && (
        <StudyWorkspace scope={scope} project={project} active={active} />
      )}{" "}
      {tab === "invitations" && (
        <Invitations scope={scope} project={project} active={active} />
      )}{" "}
      {tab === "sessions" && <Sessions scope={scope} />}
    </>
  );
}
function ProjectSettings({
  scope,
  project,
  close,
}: {
  scope: Scope;
  project: Project;
  close: () => void;
}) {
  const convex = useConvex();
  const [name, setName] = useState(project.name);
  const [state, setState] = useState(project.state);
  const [baseRevision] = useState(project.revision);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="settings stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        try {
          await convex.mutation(api.research.updateProject, {
            ...scope,
            expectedRevision: baseRevision,
            name,
            state,
          });
          close();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setPending(false);
        }
      }}
    >
      <Field label="Project name">
        <input
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Project access">
        <select
          value={state}
          onChange={(e) => setState(e.target.value as typeof state)}
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </select>
      </Field>
      {state !== project.state && (
        <Notice>
          {state === "archived"
            ? "Archiving keeps evidence and stops participant access. Revoke an invitation separately if access must stay stopped after restoration."
            : "Restoring re-enables unexpired invitations that have not been revoked."}
        </Notice>
      )}
      {error && (
        <Notice error>
          {error} Close these settings and reopen them to reconcile the latest
          project revision.
        </Notice>
      )}
      <div className="actions">
        <button disabled={pending || !!error}>
          {pending ? "Saving…" : "Save settings"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={pending}
          onClick={close}
        >
          Close
        </button>
      </div>
    </form>
  );
}
function StudyWorkspace({
  scope,
  project,
  active,
}: {
  scope: Scope;
  project: Project;
  active: boolean;
}) {
  const allowNavigation = useNavigationGuard();
  const [version, setVersion] = useState<number | null>(null);
  const selected = version ?? project.latestStudyVersion;
  const study = useRead(
    api.research.readStudy,
    selected ? { ...scope, version: selected } : null,
  );
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Study definition</h2>
          <p className="muted">
            Each saved version preserves the script used for its invitations.
          </p>
        </div>
        {project.latestStudyVersion > 0 && (
          <Field label="Saved version">
            <select
              value={selected}
              onChange={(e) => {
                if (allowNavigation()) setVersion(Number(e.target.value));
              }}
            >
              {Array.from(
                { length: project.latestStudyVersion },
                (_, i) => i + 1,
              )
                .reverse()
                .map((n) => (
                  <option key={n} value={n}>
                    Version {n}
                    {n === project.latestStudyVersion ? " · latest" : ""}
                  </option>
                ))}
            </select>
          </Field>
        )}
      </div>
      {study.error && (
        <Notice error>
          {study.error}
          <button onClick={study.refresh}>Refresh</button>
        </Notice>
      )}
      {study.error ? null : selected > 0 && !study.data ? (
        <p role="status">Loading study version…</p>
      ) : (
        <StudyEditor
          key={`${scope.projectId}:${selected}`}
          scope={scope}
          project={project}
          active={active}
          initial={study.data?.definition ?? emptyStudy(project.name)}
          sourceVersion={selected}
          onSaved={setVersion}
        />
      )}
      {study.data?.definition.prototypeUrl && <PrototypeAuthorization key={study.data.studyId} scope={scope} studyId={study.data.studyId} prototypeUrl={study.data.definition.prototypeUrl} active={active} />}
    </>
  );
}
function StudyEditor({
  scope,
  project,
  active,
  initial,
  sourceVersion,
  onSaved,
}: {
  scope: Scope;
  project: Project;
  active: boolean;
  initial: Study;
  sourceVersion: number;
  onSaved: (version: number) => void;
}) {
  const convex = useConvex();
  const [draft, setDraft] = useState(initial);
  useStudyDraftProtection(draft !== initial);
  const [baseRevision] = useState(project.revision);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const change = <K extends keyof Study>(key: K, value: Study[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError("");
    try {
      const result = await convex.mutation(api.research.saveStudy, {
        ...scope,
        expectedRevision: baseRevision,
        definition: draft,
      });
      setSaved(
        `Version ${result.version} saved. Existing invitations retain their original version.`,
      );
      onSaved(result.version);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="study-editor" onSubmit={submit}>
      <div className="study-main">
        <fieldset disabled={!active || pending}>
          <legend className="sr-only">Study content</legend>
          <Field label="Study title" hint="Participants see this name.">
            <input
              required
              maxLength={100}
              value={draft.title}
              onChange={(e) => change("title", e.target.value)}
            />
          </Field>
          <Field
            label="Participant introduction"
            hint="Explain the activity and what you want them to try. Use fictional information in this demo."
          >
            <textarea
              required
              maxLength={2000}
              rows={4}
              value={draft.introduction}
              onChange={(e) => change("introduction", e.target.value)}
            />
          </Field>
          <section className="editor-section">
            <h3>Research goals</h3>
            <p className="muted">
              Private context for your team. Goals are not shown to
              participants.
            </p>
            {draft.goals.map((goal, i) => (
              <div className="repeat-field" key={i}>
                <Field label={`Goal ${i + 1}`}>
                  <textarea
                    rows={2}
                    required
                    maxLength={500}
                    value={goal}
                    onChange={(e) =>
                      change(
                        "goals",
                        draft.goals.map((g, index) =>
                          i === index ? e.target.value : g,
                        ),
                      )
                    }
                  />
                </Field>
                {draft.goals.length > 1 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      change(
                        "goals",
                        draft.goals.filter((_, index) => i !== index),
                      )
                    }
                  >
                    Remove goal {i + 1}
                  </button>
                )}
              </div>
            ))}
            {draft.goals.length < 12 && (
              <button
                type="button"
                className="secondary"
                onClick={() => change("goals", [...draft.goals, ""])}
              >
                Add goal
              </button>
            )}
          </section>
          <section className="editor-section">
            <h3>Interview script</h3>
            <p className="muted">
              The current interview asks these questions in order. Write one
              clear question per step.
            </p>
            {draft.script.map((question, i) => (
              <div className="repeat-field" key={question.id}>
                <Field label={`Question ${i + 1}`}>
                  <textarea
                    rows={3}
                    required
                    maxLength={2000}
                    value={question.question}
                    onChange={(e) =>
                      change(
                        "script",
                        draft.script.map((q) =>
                          q.id === question.id
                            ? { ...q, question: e.target.value }
                            : q,
                        ),
                      )
                    }
                  />
                </Field>
                {draft.script.length > 1 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      change(
                        "script",
                        draft.script.filter((q) => q.id !== question.id),
                      )
                    }
                  >
                    Remove question {i + 1}
                  </button>
                )}
              </div>
            ))}
            {draft.script.length < 30 && (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  change("script", [
                    ...draft.script,
                    { id: crypto.randomUUID(), question: "" },
                  ])
                }
              >
                Add question
              </button>
            )}
          </section>
          <section className="editor-section">
            <h3>Prototype and repository</h3>
            <Field
              label="Prototype URL (optional)"
              hint="Participants can open this link. Use a URL without credentials, a query string or a fragment."
            >
              <input
                type="url"
                value={draft.prototypeUrl ?? ""}
                onChange={(e) => change("prototypeUrl", e.target.value || null)}
              />
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={!!draft.repository}
                onChange={(e) =>
                  change(
                    "repository",
                    e.target.checked
                      ? { url: "", revision: "", files: [] }
                      : null,
                  )
                }
              />
              <span>Include private repository context</span>
            </label>
            {draft.repository && (
              <>
                <Field label="Repository URL">
                  <input
                    type="url"
                    required
                    value={draft.repository.url}
                    onChange={(e) =>
                      change("repository", {
                        ...draft.repository!,
                        url: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field
                  label="Full commit hash"
                  hint="A reference only. This does not fetch, build or run a repository."
                >
                  <input
                    required
                    pattern="[a-fA-F0-9]{40}|[a-fA-F0-9]{64}"
                    value={draft.repository.revision}
                    onChange={(e) =>
                      change("repository", {
                        ...draft.repository!,
                        revision: e.target.value,
                      })
                    }
                  />
                </Field>
                <p className="muted">
                  Optional authorized source excerpts: up to eight files and 48
                  KB total. Exclude secrets, credentials and personal
                  information.
                </p>
                {draft.repository.files.map((file, i) => (
                  <div className="context-file" key={i}>
                    <Field label={`Source path ${i + 1}`}>
                      <input
                        required
                        maxLength={240}
                        value={file.path}
                        onChange={(e) =>
                          change("repository", {
                            ...draft.repository!,
                            files: draft.repository!.files.map((f, j) =>
                              i === j ? { ...f, path: e.target.value } : f,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label={`Source content ${i + 1}`}>
                      <textarea
                        rows={5}
                        value={file.text}
                        onChange={(e) =>
                          change("repository", {
                            ...draft.repository!,
                            files: draft.repository!.files.map((f, j) =>
                              i === j ? { ...f, text: e.target.value } : f,
                            ),
                          })
                        }
                      />
                    </Field>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        change("repository", {
                          ...draft.repository!,
                          files: draft.repository!.files.filter(
                            (_, j) => i !== j,
                          ),
                        })
                      }
                    >
                      Remove source {i + 1}
                    </button>
                  </div>
                ))}
                {draft.repository.files.length < 8 && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      change("repository", {
                        ...draft.repository!,
                        files: [
                          ...draft.repository!.files,
                          { path: "", text: "" },
                        ],
                      })
                    }
                  >
                    Add source excerpt
                  </button>
                )}
              </>
            )}
          </section>
        </fieldset>
        {error && (
          <Notice error>
            {error} Your edits remain here. Check the latest saved version
            before re-opening the editor; no second version has been requested.
          </Notice>
        )}
        {saved && <Notice>{saved}</Notice>}
        <div className="save-bar">
          <p>
            {sourceVersion
              ? `Editing from version ${sourceVersion}`
              : "New study"}{" "}
            · saves as a new version
          </p>
          <button disabled={!active || pending || !!error}>
            {pending ? "Saving version…" : "Save new study version"}
          </button>
        </div>
      </div>
      <aside className="study-note">
        <h3>Before you invite</h3>
        <p>
          Save a clear introduction and a complete script. Invitations are
          pinned to the version you choose.
        </p>
        <dl>
          <dt>Interview</dt>
          <dd>Text · ordered script</dd>
          <dt>Capture</dt>
          <dd>No microphone, camera or screen recording in this interview</dd>
          <dt>Participant sources</dt>
          <dd>Exact answers and earlier corrections are preserved</dd>
        </dl>
        <p>This interview collects text answers for your review.</p>
      </aside>
    </form>
  );
}

type InviteRequest = {
  clientId: Id<"researchClients">;
  projectId: Id<"researchProjects">;
  studyVersion: number;
  requestId: string;
};
function Invitations({
  scope,
  project,
  active,
}: {
  scope: Scope;
  project: Project;
  active: boolean;
}) {
  const convex = useConvex();
  const list = usePages(api.invitations.list, scope);
  const [version, setVersion] = useState(project.latestStudyVersion);
  const storageKey = `corvo.research.invite-request.${scope.projectId}`;
  const [request, setRequest] = useState<InviteRequest | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      return value?.clientId === scope.clientId &&
        value?.projectId === scope.projectId &&
        typeof value?.requestId === "string" &&
        Number.isInteger(value?.studyVersion)
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const [receipt, setReceipt] = useState<FunctionReturnType<
    typeof api.invitations.create
  > | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [copy, setCopy] = useState("");
  const [revoke, setRevoke] = useState<Id<"researchInvitations"> | null>(null);
  async function issue(recover: boolean) {
    const next = recover
      ? request
      : { ...scope, studyVersion: version, requestId: crypto.randomUUID() };
    if (!next) return;
    // Persist only the nonsecret operation receipt, never the invitation token.
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      setError(
        "This browser cannot retain the invitation request for recovery. Enable session storage before issuing a link.",
      );
      return;
    }
    setRequest(next);
    setPending(true);
    setReceipt(null);
    setError("");
    try {
      const result = await convex.action(api.invitations.create, next);
      setReceipt(result);
      setRequest(null);
      clearSessionItem(storageKey);
      await list.refresh();
    } catch (err) {
      setError(errorText(err));
      if (isDefinitiveError(err)) {
        setRequest(null);
        clearSessionItem(storageKey);
      }
    } finally {
      setPending(false);
    }
  }
  const link = receipt?.token
    ? invitationUrl(window.location.origin, receipt.token)
    : null;
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Participant invitations</h2>
          <p className="muted">
            Each link opens one private session and expires seven days after
            issue.
          </p>
        </div>
        <button className="text-button" onClick={() => void list.refresh()}>
          Refresh
        </button>
      </div>
      {active && project.latestStudyVersion > 0 ? (
        <section className="invite-create">
          <Field label="Study version">
            <select
              disabled={pending || !!request}
              value={version}
              onChange={(e) => setVersion(Number(e.target.value))}
            >
              {Array.from(
                { length: project.latestStudyVersion },
                (_, i) => i + 1,
              )
                .reverse()
                .map((n) => (
                  <option key={n} value={n}>
                    Version {n}
                  </option>
                ))}
            </select>
          </Field>
          <button
            disabled={pending || !!request}
            onClick={() => void issue(false)}
          >
            {pending ? "Checking invitation…" : "Create invitation"}
          </button>
        </section>
      ) : (
        <Notice>
          {active
            ? "Save a study version before creating an invitation."
            : "Restore the client and project before creating invitations."}
        </Notice>
      )}
      {request && !pending && (
        <Notice>
          The previous result was not confirmed. Check that same request; this
          will not create a second session.{" "}
          <button className="secondary" onClick={() => void issue(true)}>
            Check original invitation
          </button>
        </Notice>
      )}
      {error && <Notice error>{error}</Notice>}
      {receipt && (
        <section className="issued-invite" aria-live="polite">
          <h3>
            {link ? "Invitation ready" : "Invitation found · link unavailable"}
          </h3>
          <p>
            Session <code>{receipt.sessionId}</code> · access until{" "}
            <DateTime value={receipt.expiresAt} />
          </p>
          {link ? (
            <>
              <Field
                label="Private participant link"
                hint="Copy it now. This secret link cannot be retrieved again after you leave this view."
              >
                <input
                  readOnly
                  value={link}
                  onFocus={(e) => e.target.select()}
                />
              </Field>
              <div className="actions">
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link);
                      setCopy("Link copied");
                    } catch {
                      setCopy("Select the link above and copy it manually.");
                    }
                  }}
                >
                  Copy invitation
                </button>
                <a
                  className="button secondary"
                  href={link}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open participant view
                </a>
              </div>
              <p role="status">{copy}</p>
            </>
          ) : (
            <p>
              The first request already issued this invitation. Its secret link
              cannot be recovered. Revoke this invitation below, then
              deliberately create a replacement.
            </p>
          )}
        </section>
      )}
      <div className="invite-list">
        {list.rows.map((invite) => (
          <div className="invite-row" key={invite.invitationId}>
            <div>
              <strong>Session {invite.sessionId.slice(-8)}</strong>
              <p>
                {invite.revokedAt ? (
                  <>
                    Revoked <DateTime value={invite.revokedAt} />
                  </>
                ) : (
                  <>
                    Access until <DateTime value={invite.expiresAt} />
                  </>
                )}
              </p>
              <small>
                Study <code>{invite.studyId.slice(-8)}</code>
              </small>
            </div>
            <div>
              {invite.revokedAt === null && (
                <button
                  className="secondary"
                  onClick={() => setRevoke(invite.invitationId)}
                >
                  Revoke link
                </button>
              )}
              {revoke === invite.invitationId && (
                <div className="revoke-confirm">
                  <p>Stop this link immediately? Saved sources remain.</p>
                  <div className="actions">
                    <button
                      disabled={pending}
                      onClick={async () => {
                        setPending(true);
                        setError("");
                        try {
                          await convex.mutation(api.invitations.revoke, {
                            ...scope,
                            invitationId: invite.invitationId,
                          });
                          setRevoke(null);
                          await list.refresh();
                        } catch (err) {
                          setError(errorText(err));
                          await list.refresh();
                        } finally {
                          setPending(false);
                        }
                      }}
                    >
                      Confirm revoke
                    </button>
                    <button
                      className="secondary"
                      disabled={pending}
                      onClick={() => setRevoke(null)}
                    >
                      Keep link
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {!list.loading && !list.rows.length && (
        <p className="empty">
          No invitations yet. Choose a saved version to begin.
        </p>
      )}
      <Pages {...list} />
    </>
  );
}
function Sessions({ scope }: { scope: Scope }) {
  const sessions = usePages(api.research.sessions, scope);
  const [selected, setSelected] = useState<Id<"researchSessions"> | null>(null);
  const session = sessions.rows.find((s) => s.sessionId === selected);
  const sources = usePages(
    api.research.sessionSources,
    selected ? { ...scope, sessionId: selected } : null,
  );
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Sessions & sources</h2>
          <p className="muted">
            Inspect the participant’s exact words and correction history.
          </p>
        </div>
        <button
          className="text-button"
          onClick={() => {
            void sessions.refresh();
            if (selected) void sources.refresh();
          }}
        >
          Refresh
        </button>
      </div>
      <div className="session-workspace">
        <aside className="session-list" aria-label="Research sessions">
          {sessions.rows.map((s) => (
            <button
              key={s.sessionId}
              className={`session-item ${selected === s.sessionId ? "selected" : ""}`}
              onClick={() => setSelected(s.sessionId)}
            >
              <strong>Session {s.sessionId.slice(-8)}</strong>
              <span>
                {s.state} · {s.sourceCount} sources
              </span>
              <small>
                Saved <DateTime value={s.savedAt} />
              </small>
            </button>
          ))}
          {!sessions.loading && !sessions.rows.length && (
            <p className="empty">
              Participant sessions appear when invitations are issued.
            </p>
          )}
          <Pages {...sessions} />
        </aside>
        <section
          className="source-workspace"
          aria-label="Selected session sources"
        >
          {session ? (
            <>
              <div className="source-heading">
                <h3>Session {session.sessionId.slice(-8)}</h3>
                <p>
                  {session.state} · revision {session.revision}
                </p>
                <p className="muted">
                  Sources available until{" "}
                  <DateTime value={session.retainUntil} />
                </p>
              </div>
              {session.retainUntil <= Date.now() ? (
                <Notice>
                  Source retention has ended. This session’s original sources
                  are no longer available.
                </Notice>
              ) : (
                <>
                  <SourceList sources={sources.rows} />
                  <CaptureSources key={session.sessionId} scope={{ ...scope, sessionId: session.sessionId }} />
                  <Pages {...sources} />
                  {!sources.loading &&
                    !sources.rows.length &&
                    !sources.error && (
                      <p className="empty">
                        The participant has not started the interview.
                      </p>
                    )}
                </>
              )}
            </>
          ) : (
            <div className="empty">
              <h3>Open a session to inspect its sources</h3>
              <p>
                Original answers and later corrections appear together. Source
                IDs stay attached to their exact wording.
              </p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
