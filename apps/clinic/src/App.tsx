import { PatientApp } from './PatientApp';
import { StaffApp } from './StaffApp';
import { JoinApp } from './JoinApp';
import { takeInvitationToken } from './join-invitation';

// Capture before React starts effects; module initialization also survives StrictMode's double render.
const joinToken = window.location.pathname === '/join' ? takeInvitationToken(window.location, window.history) : undefined;

export function App() {
  if (window.location.pathname === '/join') return <JoinApp initialToken={joinToken} />;
  return window.location.pathname === '/staff' || window.location.pathname.startsWith('/staff/') ? <StaffApp /> : <PatientApp />;
}
