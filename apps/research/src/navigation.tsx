import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

type Guard = { dirty: { current: boolean }; allow: () => boolean };
const DraftContext = createContext<Guard>({
  dirty: { current: false },
  allow: () => true,
});
export function DraftProtection({ children }: { children: ReactNode }) {
  const dirty = useRef(false);
  const guard = useMemo(
    () => ({
      dirty,
      allow: () =>
        !dirty.current ||
        window.confirm(
          "Discard your unsaved changes? Saved versions will remain unchanged.",
        ),
    }),
    [],
  );
  useEffect(() => {
    const beforeLeave = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeLeave);
    return () => window.removeEventListener("beforeunload", beforeLeave);
  }, []);
  return (
    <DraftContext.Provider value={guard}>{children}</DraftContext.Provider>
  );
}
export function useNavigationGuard() {
  return useContext(DraftContext).allow;
}
export function useStudyDraftProtection(dirty: boolean) {
  const guard = useContext(DraftContext);
  useEffect(() => {
    guard.dirty.current = dirty;
    return () => {
      guard.dirty.current = false;
    };
  }, [dirty, guard]);
}
