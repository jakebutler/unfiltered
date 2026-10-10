import React, { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { OperatorApp } from "./OperatorApp";
import { ParticipantApp } from "./ParticipantApp";
import { Brand } from "./components";
import { DraftProtection } from "./navigation";
import "./styles.css";

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="entry">
        <Brand />
        <h1>This workspace could not load</h1>
        <p>
          Reload to check your access and reconnect. No new submission will be
          created by reloading.
        </p>
        <button onClick={() => window.location.reload()}>
          Reload workspace
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
// Only the public deployment URL belongs in the browser. Local development is
// explicit; production builds require VITE_RESEARCH_CONVEX_URL.
const endpoint =
  import.meta.env.VITE_RESEARCH_CONVEX_URL ||
  (import.meta.env.DEV ? "http://127.0.0.1:3210" : "");
const root = createRoot(document.getElementById("root")!);
if (!endpoint)
  root.render(
    <main className="entry">
      <Brand />
      <h1>Research is not configured</h1>
      <p>
        The operator needs to configure this deployment before it can receive
        interviews.
      </p>
    </main>,
  );
else {
  const client = new ConvexReactClient(endpoint, { logger: false });
  root.render(
    <React.StrictMode>
      <Boundary>
        <ConvexAuthProvider client={client}>
          <a className="skip" href="#main">
            Skip to content
          </a>
          {window.location.pathname === "/participate" ? (
            <ParticipantApp />
          ) : (
            <DraftProtection>
              <OperatorApp />
            </DraftProtection>
          )}
        </ConvexAuthProvider>
      </Boundary>
    </React.StrictMode>,
  );
}
