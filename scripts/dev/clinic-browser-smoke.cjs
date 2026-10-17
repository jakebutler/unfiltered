/** Real Chromium UI checks against the disposable invitations-local-smoke backend.
 * No hosted target or credentials accepted. See DEMO-ACCEPTANCE.md for installation.
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = 'http://127.0.0.1:5173';
const output = path.resolve(process.env.CLINIC_BROWSER_OUTPUT || '.factory/browser-evidence');
const widths = [1365, 390, 360];
const scenarios = ['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'];
const results = [];
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
let browser;
async function check(page, name, width) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, `${name}: horizontal page overflow at ${width}px`);
  await page.screenshot({ path: path.join(output, `${width}-${name}.png`), fullPage: true });
}
async function settledClick(page, locator, endpoint, status = 200, readBody = true) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST');
  await locator.click();
  const value = await response; assert.equal(value.status(), status, endpoint);
  return readBody ? value.json() : undefined;
}
async function start(page, scenario) {
  await page.goto(origin);
  await page.locator(`input[value="${scenario}"]`).check();
  await page.locator('.acknowledgement input').check();
  await settledClick(page, page.getByRole('button', { name: 'Start conversation', exact: true }), '/api/clinic/sessions', 201);
  await settledClick(page, page.getByRole('button', { name: /Continue as/ }), '/api/clinic/confirm-identity');
  await page.getByRole('button', { name: 'Review my answers', exact: true }).waitFor();
}
async function login(page) {
  await page.goto(origin + '/staff');
  await page.getByLabel('Work email', { exact: true }).fill('synthetic-md@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('local-smoke-only');
  await settledClick(page, page.getByRole('button', { name: 'Sign in', exact: true }), '/api/staff/login');
  await page.getByRole('heading', { name: 'Invite a patient', exact: true }).waitFor();
}
async function topic(page, title, width) {
  if (width < 621) await page.getByRole('button', { name: 'Your topics', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(title) }).click();
}
(async () => {
  if (process.argv.length > 2) throw Error('This script accepts no arguments or hosted target.');
  browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
  for (const width of widths) {
    const contexts = [], errors = [];
    const page = async () => {
      const c = await browser.newContext({ viewport: { width, height: width === 360 ? 740 : width === 390 ? 844 : 1000 } });
      contexts.push(c);
      await c.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
      const p = await c.newPage(); p.setDefaultTimeout(15000); p.on('pageerror', e => errors.push(e.message)); return p;
    };
    try {
      // Every workflow can enter, retain a deliberate skip, review partial answers and deliver.
      for (const scenario of scenarios) {
        console.log(`CHECK ${width}px ${scenario}`);
        const p = await page(); await start(p, scenario); await check(p, `${scenario}-conversation`, width);
        await settledClick(p, p.getByRole('button', { name: 'Skip for now', exact: true }), '/api/clinic/turns');
        await p.reload();
        await settledClick(p, p.getByRole('button', { name: /Continue as/ }), '/api/clinic/confirm-identity');
        await p.getByRole('button', { name: 'Review my answers', exact: true }).waitFor();
        const review = await settledClick(p, p.getByRole('button', { name: 'Review my answers', exact: true }), '/api/clinic/review');
        assert.equal(review.session.completeness, 'partial');
        await p.getByRole('heading', { name: 'Check your answers', exact: true }).waitFor();
        await check(p, `${scenario}-review`, width);
        const sent = await settledClick(p, p.getByRole('button', { name: 'Confirm and send to Corvo Clinic', exact: true }), '/api/clinic/confirm');
        assert.equal(sent.delivery.state, 'received'); assert.equal(sent.completeness, 'partial');
        results.push({ width, scenario, partialDelivery: 'passed', reload: 'passed' });
        await p.context().close();
      }
      console.log(`CHECK ${width}px PHQ and staff`);
      const p = await page(); await start(p, 'first-intake');
      await topic(p, 'Mood, anxiety and support', width);
      for (let i = 0; i < 3; i++) await settledClick(p, p.getByRole('button', { name: 'I don’t know', exact: true }), '/api/clinic/turns');
      for (const label of ['Several days', 'More than half the days', 'Nearly every day', 'Not at all']) {
        await p.getByRole('button', { name: label, exact: true }).click();
        assert.equal(await p.locator('#answer-text').count(), 0, 'PHQ must be buttons-only');
        await check(p, `phq-${label.replaceAll(' ', '-')}`, width);
        await settledClick(p, p.getByRole('button', { name: 'Send answer', exact: true }), '/api/clinic/turns');
      }
      await settledClick(p, p.getByRole('button', { name: 'Review my answers', exact: true }), '/api/clinic/review');
      await p.locator('.screening-result').waitFor();
      assert((await p.locator('body').innerText()).includes('PHQ-4: 6; GAD-2: 3; PHQ-2: 3.'));
      await check(p, 'phq-review', width);
      const sent = await settledClick(p, p.getByRole('button', { name: 'Confirm and send to Corvo Clinic', exact: true }), '/api/clinic/confirm');
      const staff = await page(); await login(staff);
      // The newest received handoff is first; only actual buttons inside the work list qualify.
      await staff.locator('.queue-list button.queue-item').first().click();
      await staff.locator('.screening-result').waitFor();
      assert((await staff.locator('.screening-result').innerText()).includes('PHQ-4: 6; GAD-2: 3; PHQ-2: 3.'));
      assert((await staff.locator('body').innerText()).includes('Clinician review required'));
      // Do not log source contents or identifiers; the UI assertions are the acceptance evidence.
      await check(staff, 'phq-staff', width);
      if (width < 621) await staff.getByRole('button', { name: 'Work queue', exact: true }).click();
      await staff.getByRole('button', { name: 'Send check-in link', exact: true }).first().click();
      await staff.getByLabel('Workflow', { exact: true }).selectOption('pre-visit');
      const issue = await settledClick(staff, staff.getByRole('button', { name: 'Create check-in link', exact: true }), '/api/clinic/staff/invitations', 201);
      assert.equal(issue.emailStatus, 'copy-only');
      const link = await staff.getByLabel('One-time invitation link', { exact: true }).inputValue();
      const join = await page(); let redeemed = 0, identity;
      await join.route('**/api/clinic/invitations/redeem', async route => {
        const response = await route.fetch(); identity = await response.json(); await route.fulfill({ response });
      });
      join.on('request', r => { if (new URL(r.url()).pathname === '/api/clinic/invitations/redeem') redeemed++; });
      await join.goto(link); await join.getByRole('heading', { name: 'Your clinic check-in', exact: true }).waitFor();
      assert.equal(join.url(), origin + '/join'); assert.equal(redeemed, 0);
      assert(await join.getByRole('button', { name: 'Open check-in', exact: true }).isDisabled());
      await check(join, 'invitation-ack', width);
      await join.getByRole('checkbox').check();
      await settledClick(join, join.getByRole('button', { name: 'Open check-in', exact: true }), '/api/clinic/invitations/redeem', 201, false);
      assert.equal(identity.phase, 'identity'); assert.equal(identity.scenario, 'pre-visit');
      assert.equal(identity.persona.displayName, 'PHQ smoke (synthetic)');
      await settledClick(join, join.getByRole('button', { name: /Continue as/ }), '/api/clinic/confirm-identity');
      await join.getByRole('heading', { name: 'Before your visit', exact: true }).waitFor();
      const reuse = await page(); await reuse.goto(link); await reuse.getByRole('checkbox').check();
      await settledClick(reuse, reuse.getByRole('button', { name: 'Open check-in', exact: true }), '/api/clinic/invitations/redeem', 410);
      await check(reuse, 'invitation-used', width);
      const safety = await page(); await start(safety, 'first-intake');
      await safety.getByLabel('Your answer', { exact: true }).fill('Honestly I feel hopeless most days.');
      await settledClick(safety, safety.getByRole('button', { name: 'Send answer', exact: true }), '/api/clinic/turns');
      // No reviewer is configured: explicitly verify the production fail-closed UI.
      await staff.reload(); await staff.locator('button.safety-item').filter({ hasText: '1 open' }).first().click();
      await staff.getByRole('heading', { name: 'Review 1 · Open', exact: true }).waitFor();
      if (width < 621) assert.equal(await staff.locator('.queue-panel').isVisible(), false, 'Mobile safety detail must hide queue');
      assert((await staff.locator('.safety-message').first().innerText()).includes('Honestly I feel hopeless most days.'));
      await check(staff, 'safety-open', width);
      await staff.getByLabel('Outcome', { exact: true }).selectOption('contacted-patient');
      await staff.getByLabel('Note', { exact: true }).fill('Synthetic test: fictional clinician contact recorded.');
      let releaseAction;
      const actionHeld = new Promise(resolve => { releaseAction = resolve; });
      let actionSaved;
      const saved = new Promise(resolve => { actionSaved = resolve; });
      let actionAttempts = 0, originalActionId;
      await staff.route('**/api/staff/safety/*/actions', async route => {
        const action = route.request().postDataJSON();
        const response = await route.fetch();
        if (++actionAttempts === 1) {
          originalActionId = action.actionId;
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost acknowledgement', code: 'fixture-response-lost', retryable: true } }) });
          return;
        }
        assert.equal(action.actionId, originalActionId, 'Uncertain action must retry its original ID');
        actionSaved(); await actionHeld; await route.fulfill({ response });
      });
      await staff.getByRole('button', { name: 'Record action', exact: true }).click();
      await staff.getByText('Synthetic lost acknowledgement', { exact: true }).waitFor();
      assert.equal(await staff.getByLabel('Note', { exact: true }).inputValue(), 'Synthetic test: fictional clinician contact recorded.');
      assert.equal(await staff.getByRole('button', { name: 'Sign out', exact: true }).isDisabled(), false, 'Failed action must release navigation');
      await staff.getByRole('button', { name: 'Record action', exact: true }).click();
      await saved;
      try {
        assert(await staff.getByRole('button', { name: 'Sign out', exact: true }).isDisabled());
        assert(await staff.getByRole('button', { name: 'Safety review list', exact: true }).isDisabled());
        assert(await staff.locator('.queue-list button.queue-item').first().isDisabled(), 'Navigation must wait for an in-flight safety action');
      } finally { releaseAction(); }
      await staff.getByRole('heading', { name: 'Review 1 · Closed', exact: true }).waitFor();
      assert((await staff.locator('.safety-history').innerText()).includes('Synthetic test: fictional clinician contact recorded.'));
      assert.equal(await staff.locator('.safety-actions > li').count(), 1, 'Uncertain-response retry must not duplicate the action');
      await check(staff, 'safety-closed', width);
      await staff.getByRole('button', { name: 'Safety review list', exact: true }).click();
      await staff.getByText(/^No open safety reviews (in your scope|on the loaded pages)\.$/).waitFor();
      assert.equal(await staff.locator('button.safety-item').count(), 0, 'Closed items must leave the active safety queue');
      await staff.locator('.safety-reviewed summary').click();
      await staff.locator('button.safety-history-item').first().waitFor();
      await check(staff, 'staff-queue', width);
      assert.deepEqual(errors, []);
      results.push({ width, phq: '6/3/3', invitations: 'copy-only, identity-bound, single-use', safety: 'fail-closed, saved action, refreshed queue', horizontalOverflow: false, pageErrors: 0 });
      console.log(`PASS ${width}px: seven partial workflows, reload, PHQ, invitation, safety action and layout.`);
    } finally { for (const c of contexts) await c.close(); }
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ mode: 'offline-browser', at: new Date().toISOString(), liveProviders: false, results }, null, 2));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
