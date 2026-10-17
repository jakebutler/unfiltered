import { useState, type FormEvent } from "react";
import { useConvex, useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { usePages, useRead } from "./data";
import { Brand, DateTime, Field, Notice, Pages } from "./components";
import { errorText } from "./state";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { useNavigationGuard } from "./navigation";

type Client = FunctionReturnType<typeof api.research.clients>["page"][number];
export function OperatorApp() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  if (isLoading)
    return (
      <main id="main" tabIndex={-1} className="entry">
        <Brand />
        <p role="status">Opening your workspace…</p>
      </main>
    );
  return isAuthenticated ? <Workspace /> : <SignIn />;
}
function SignIn() {
  const { signIn } = useAuthActions();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      await signIn("password", {
        flow: "signIn",
        email: String(form.get("email")),
        password: String(form.get("password")),
      });
    } catch {
      setError(
        "Sign-in was not completed. Check your operator details and try again. If attempts are limited, wait before retrying.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <header className="topbar">
        <Brand />
        <span className="demo-label">Synthetic demo</span>
      </header>
      <main id="main" tabIndex={-1} className="entry">
        <h1>Your research workspace</h1>
        <p className="lede">
          Keep each client’s studies and participant sources together.
        </p>
        <form onSubmit={submit} className="stack">
          <Field label="Operator email">
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              maxLength={254}
            />
          </Field>
          <Field label="Password">
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          {error && <Notice error>{error}</Notice>}
          <button disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="muted">
          Access is managed by Corvo Labs. Participant invitations open their
          own interview.
        </p>
      </main>
    </>
  );
}
function Workspace() {
  const allowNavigation = useNavigationGuard();
  const me = useRead(api.research.me, {});
  const clients = usePages(api.research.clients, {});
  const [clientId, setClientId] = useState<Id<"researchClients"> | null>(null);
  const [projectId, setProjectId] = useState<Id<"researchProjects"> | null>(
    null,
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const { signOut } = useAuthActions();
  const selected = clients.rows.find((c) => c._id === clientId);
  return (
    <>
      <header className="topbar">
        <Brand />
        <div className="topbar-right">
          <span className="demo-label">Synthetic demo</span>
          <span className="operator-name">{me.data?.name}</span>
          <button
            className="text-button"
            onClick={() =>
              allowNavigation() &&
              void signOut().catch(() =>
                setError(
                  "Sign-out was not confirmed. Keep this tab open and try again.",
                ),
              )
            }
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="operator-layout">
        <aside className="client-rail" aria-label="Clients">
          <div className="rail-title">
            <h2>Clients</h2>
            <button
              className="text-button"
              onClick={() => {
                if (allowNavigation()) setCreating(true);
              }}
            >
              Add client
            </button>
          </div>
          {creating && (
            <NameForm
              label="Client name"
              save={async (_name, client) => {
                await clients.refresh();
                setClientId(client!);
                setProjectId(null);
                setCreating(false);
              }}
              onCancel={() => {
                setCreating(false);
                void clients.refresh();
              }}
              useCreate
            />
          )}
          <nav aria-label="Select client">
            {clients.rows.map((client) => (
              <button
                key={client._id}
                className={`client-item ${client._id === clientId ? "selected" : ""}`}
                aria-current={client._id === clientId ? "page" : undefined}
                onClick={() => {
                  if (!allowNavigation()) return;
                  setClientId(client._id);
                  setProjectId(null);
                }}
              >
                <span>{client.name}</span>
                <small>
                  {client.state === "archived"
                    ? "Archived"
                    : "Client workspace"}
                </small>
              </button>
            ))}
          </nav>
          {!clients.loading && !clients.rows.length && (
            <p className="muted">Add a client to start their first project.</p>
          )}
          <Pages {...clients} />
          <p className="rail-note">
            Client data stays scoped to its own projects.
          </p>
        </aside>
        <main id="main" tabIndex={-1} className="workspace">
          {error && <Notice error>{error}</Notice>}
          {me.error && <Notice error>{me.error}</Notice>}
          {selected ? (
            projectId ? (
              <ProjectWorkspace
                key={projectId}
                clientId={selected._id}
                projectId={projectId}
                onBack={() => {
                  if (allowNavigation()) setProjectId(null);
                }}
              />
            ) : (
              <ClientWorkspace
                key={selected._id}
                client={selected}
                onProject={setProjectId}
                refreshClients={clients.refresh}
              />
            )
          ) : (
            <div className="workspace-empty">
              <h1>Research, organized by client</h1>
              <p>
                Select a client to open their projects, or add a new client to
                set up a study.
              </p>
              <button
                onClick={() => {
                  if (allowNavigation()) setCreating(true);
                }}
              >
                Add your next client
              </button>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
function NameForm({
  label,
  initial = "",
  save,
  onCancel,
  useCreate = false,
}: {
  label: string;
  initial?: string;
  save: (name: string, createdId?: Id<"researchClients">) => Promise<void>;
  onCancel: () => void;
  useCreate?: boolean;
}) {
  const convex = useConvex();
  const [name, setName] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  return (
    <form
      className="stack compact-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError("");
        try {
          if (useCreate) {
            const id = await convex.mutation(api.research.createClient, {
              name,
            });
            await save(name, id);
          } else await save(name);
        } catch (err) {
          setError(errorText(err));
          setUncertain(true);
        } finally {
          setPending(false);
        }
      }}
    >
      <Field label={label}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
          autoFocus
        />
      </Field>
      {error && (
        <Notice error>
          {error} Check the list before creating another record.
        </Notice>
      )}
      <div className="actions">
        <button disabled={pending || uncertain}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={pending}
          onClick={onCancel}
        >
          {uncertain ? "Close and check list" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
function ClientWorkspace({
  client,
  onProject,
  refreshClients,
}: {
  client: Client;
  onProject: (id: Id<"researchProjects">) => void;
  refreshClients: () => Promise<void>;
}) {
  const convex = useConvex();
  const projects = usePages(api.research.projects, { clientId: client._id });
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const update = async (name: string, state: "active" | "archived") => {
    await convex.mutation(api.research.updateClient, {
      clientId: client._id,
      expectedRevision: client.revision,
      name,
      state,
    });
    await refreshClients();
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{client.name}</h1>
          <p className="muted">
            {client.state === "archived"
              ? "Archived client · participant access is stopped"
              : "Projects and studies for this client"}
          </p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={() => setEdit(!edit)}>
            Edit client
          </button>
          <button className="secondary" onClick={() => setConfirmArchive(true)}>
            {client.state === "active" ? "Archive client" : "Restore client"}
          </button>
        </div>
      </div>
      {edit && (
        <NameForm
          label="Client name"
          initial={client.name}
          save={async (name) => {
            await update(name, client.state);
            setEdit(false);
          }}
          onCancel={() => {
            setEdit(false);
            void refreshClients();
          }}
        />
      )}{" "}
      {confirmArchive && (
        <section className="confirmation">
          <h2>
            {client.state === "active"
              ? "Archive this client?"
              : "Restore this client?"}
          </h2>
          <p>
            {client.state === "active"
              ? "Projects and sources remain saved. Participant invitations stop working while the client is archived. Revoke individual invitations to end their access permanently."
              : "Unexpired invitations that were not revoked will work again. Review them after restoring."}
          </p>
          <div className="actions">
            <button
              disabled={pending}
              onClick={async () => {
                setPending(true);
                try {
                  await update(
                    client.name,
                    client.state === "active" ? "archived" : "active",
                  );
                  setConfirmArchive(false);
                } catch (e) {
                  setError(errorText(e));
                  await refreshClients();
                } finally {
                  setPending(false);
                }
              }}
            >
              Confirm {client.state === "active" ? "archive" : "restore"}
            </button>
            <button
              className="secondary"
              disabled={pending}
              onClick={() => setConfirmArchive(false)}
            >
              Cancel
            </button>
          </div>
        </section>
      )}
      {error && <Notice error>{error}</Notice>}
      <div className="section-heading">
        <h2>Projects</h2>
        <div className="actions">
          <button
            className="text-button"
            onClick={() => void projects.refresh()}
          >
            Refresh
          </button>
          {client.state === "active" && (
            <button onClick={() => setCreate(true)}>New project</button>
          )}
        </div>
      </div>
      {create && (
        <NameForm
          label="Project name"
          save={async (name) => {
            const id = await convex.mutation(api.research.createProject, {
              clientId: client._id,
              name,
            });
            await projects.refresh();
            setCreate(false);
            onProject(id);
          }}
          onCancel={() => {
            setCreate(false);
            void projects.refresh();
          }}
        />
      )}
      <div className="project-list">
        {projects.rows.map((project) => (
          <button
            className="project-row"
            key={project._id}
            onClick={() => onProject(project._id)}
          >
            <span>
              <strong>{project.name}</strong>
              <small>
                {project.latestStudyVersion
                  ? `Study version ${project.latestStudyVersion}`
                  : "Study not yet saved"}
              </small>
            </span>
            <span className="status">{project.state}</span>
            <span className="row-date">
              <DateTime value={project.updatedAt} />
            </span>
            <span aria-hidden="true">→</span>
          </button>
        ))}
      </div>
      {!projects.loading && !projects.rows.length && (
        <div className="empty">
          <h3>The first study starts here</h3>
          <p>
            Create a project, write its goals and interview script, then share a
            version-specific invitation.
          </p>
        </div>
      )}
      <Pages {...projects} />
    </>
  );
}
