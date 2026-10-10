import { PatientApp } from './PatientApp';
import { StaffApp } from './StaffApp';

export function App() {
  return window.location.pathname === '/staff' || window.location.pathname.startsWith('/staff/') ? <StaffApp /> : <PatientApp />;
}
