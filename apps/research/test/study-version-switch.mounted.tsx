import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectWorkspace } from '../src/ProjectWorkspace';
import { DraftProtection } from '../src/navigation';

/** Run in the isolated browser fixture with real React DOM and native-shaped reads.
 * The fixture denies external traffic and records only synthetic readiness commands.
 */
export async function checkMountedStudyVersionSwitch(container: HTMLElement, commands: { scope: { studyId: string; studyVersion: number } }[]) {
  const root = createRoot(container), checks: { version: number; regions: number; commandVersion: number }[] = [];
  const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  async function settled(action: () => void) {
    await act(async () => { action(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
  }
  try {
    await settled(() => root.render(<React.StrictMode><DraftProtection><ProjectWorkspace clientId={'fixture-client' as any} projectId={'fixture-project' as any} onBack={() => {}} /></DraftProtection></React.StrictMode>));
    for (const version of [6, 5, 6]) {
      const select = container.querySelector('select'); expect(select, 'Saved version selector missing');
      await settled(() => { select!.value = String(version); select!.dispatchEvent(new Event('change', { bubbles: true })); });
      const regions = [...container.querySelectorAll('.study-readiness')];
      expect(regions.length === 1, `Version ${version}: retained ${regions.length} readiness regions`);
      expect(regions[0].textContent?.includes(`Saved study version ${version}`), `Version ${version}: wrong readiness scope`);
      const buttons = [...regions[0].querySelectorAll('button')];
      const enable = buttons.find(button => button.textContent === 'Enable Goal-aware interview');
      expect(enable && !enable.disabled, `Version ${version}: enable control missing`);
      const prior = commands.length;
      await settled(() => enable!.click());
      expect(commands.length === prior + 1, `Version ${version}: command count changed`);
      const last = commands.at(-1)!;
      expect(last.scope.studyVersion === version && last.scope.studyId === `fixture-study-${version}`, `Version ${version}: command reached another study`);
      expect(container.querySelectorAll('.study-readiness').length === 1, `Version ${version}: command retained another region`);
      const off = [...container.querySelectorAll('.study-readiness button')].find(button => button.textContent === 'Turn off Goal-aware interview') as HTMLButtonElement;
      expect(off, `Version ${version}: accepted opt-in not shown`);
      await settled(() => off.click());
      checks.push({ version, regions: regions.length, commandVersion: last.scope.studyVersion });
    }
    return { checks, commands: commands.length, mounted: true, providers: 0 };
  } finally { await act(async () => root.unmount()); }
}
