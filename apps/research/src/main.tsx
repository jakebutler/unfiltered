import React, { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { OperatorApp } from "./OperatorApp";
import { ClientReportApp } from "./ClientReportApp";
import { createSyntheticVoiceFixture } from "./synthetic-voice-fixture";
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
const syntheticVoice = import.meta.env.DEV && window.location.pathname === "/participate/synthetic-voice" ? createSyntheticVoiceFixture() : undefined;
const root = createRoot(document.getElementById("root")!);
if (window.location.pathname.startsWith("/report/"))
  root.render(
    <React.StrictMode>
      <Boundary>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <ClientReportApp />
      </Boundary>
    </React.StrictMode>,
  );
else if (!endpoint)
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
          {(window.location.pathname === "/participate" || syntheticVoice) ? (
            <ParticipantApp fixture={syntheticVoice} />
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
