// Cross-browser smoke test of the public build: Chromium, Firefox and WebKit (Safari's engine),
// on a desktop and a phone-sized screen. Uses only made-up data.
// Run: npm run build:public && npm run test:browsers
import { spawn } from 'node:child_process';
import { chromium, firefox, webkit, devices } from 'playwright';

const PORT = 5181;
const BASE = `http://localhost:${PORT}`;
const server = spawn('npx', ['vite', 'preview', '--mode', 'public', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
await new Promise((ok) => setTimeout(ok, 1500));

const linkedin = [
  'Notes:', '"x"', '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Ada,Quill,,ada@example.com,Globex,Engineer,02 Mar 2017',
  'Ben,Okoro,,,Acme Corp,Manager,03 Mar 2022',
  'Cara,Vance,,,Acme Corp,Analyst,10 Jan 2021',
].join('\n');
const education = 'School Name,Start Date,End Date,Notes,Degree Name,Activities\nState University,2015,2019,,BS,';
const positions = 'Company Name,Title,Description,Location,Started On,Finished On\nAcme Corp,Analyst,,NYC,Jul 2019,Jun 2026';
const ics = ['BEGIN:VCALENDAR', ...Array.from({ length: 3 }, () => ['BEGIN:VEVENT', 'SUMMARY:Study group', 'RRULE:FREQ=WEEKLY',
  'ORGANIZER;CN=You:mailto:you@school.edu', 'ATTENDEE;CN=Dee Fox:mailto:dee.fox@school.edu', 'ATTENDEE;CN=Eli Moss:mailto:eli@bain.com', 'END:VEVENT'].join('\r\n')),
'END:VCALENDAR'].join('\r\n');
const file = (name, text) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });

const results = [];
for (const [engine, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
  for (const form of ['desktop', 'phone']) {
    const label = `${engine} ${form}`;
    const problems = [];
    const browser = await type.launch();
    const opts = form === 'phone'
      ? (engine === 'firefox' ? { viewport: { width: 390, height: 844 }, hasTouch: true } : { ...devices['iPhone 13'] })
      : { viewport: { width: 1360, height: 860 } };
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 160)}`); });
    page.on('pageerror', (e) => problems.push(`error: ${e.message.slice(0, 160)}`));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP blocked ${e.blockedURI} (${e.violatedDirective})`)));
    const check = async (name, fn) => { try { await fn(); } catch (e) { problems.push(`${name}: ${e.message.split('\n')[0].slice(0, 160)}`); } };

    await page.goto(BASE);
    await check('sample map and welcome', async () => {
      await page.getByRole('heading', { name: 'See the shape of your network' }).waitFor({ timeout: 8000 });
      const people = await page.locator('#graph .node.person').count();
      if (people < 30) throw new Error(`only ${people} people drawn`);
    });
    await check('intro path in the sample', async () => {
      await page.getByRole('button', { name: 'Explore the sample' }).click();
      await page.locator('#graph .node.person[aria-label^="Olivia Brooks"]').dispatchEvent('click');
      await page.locator('#panel').getByRole('heading', { name: 'Intro path' }).waitFor({ timeout: 4000 });
    });
    await check('feedback dialog', async () => {
      await page.locator('#feedback-btn').click();
      await page.getByText('What’s working, what isn’t').waitFor({ timeout: 3000 });
      await page.locator('#feedback [data-close]').click();
    });
    await check('phone steps', async () => {
      await page.locator('#cta').click();
      await page.locator('[data-src-tile="contacts"]').click();
      const steps = await page.locator('.steps').innerText();
      const phoneish = steps.includes('Lists');
      if (phoneish !== (form === 'phone')) throw new Error(`expected ${form} steps, got: ${steps.slice(0, 60)}`);
    });
    await check('import LinkedIn zip parts and a calendar', async () => {
      await page.locator('#files').setInputFiles([file('Connections.csv', linkedin), file('Education.csv', education), file('Positions.csv', positions), file('calendar.ics', ics)]);
      await page.locator('.pending [data-commit]').first().waitFor({ timeout: 4000 });
      for (let i = 0; i < 4 && await page.locator('.pending [data-commit]').count(); i++) {
        await page.locator('.pending [data-commit]').first().click();
        await page.waitForTimeout(400);
      }
    });
    await check('map persists after reload', async () => {
      await page.goto(`${BASE}/?view=data`);
      await page.getByRole('heading', { name: 'Your data', exact: true }).waitFor({ timeout: 6000 });
      const badge = await page.locator('#sample-badge').innerText();
      if (!/this browser/i.test(badge)) throw new Error(`badge says "${badge}"`);
      const worlds = await page.locator('#circles button').allInnerTexts();
      if (!worlds.some((w) => w.startsWith('State University')) || !worlds.some((w) => w.startsWith('Acme Corp'))) throw new Error(`worlds: ${worlds.join(', ')}`);
    });
    await check('sort with a tap', async () => {
      await page.goto(`${BASE}/?view=sort`);
      const name = await page.locator('.card h2').first().innerText({ timeout: 5000 });
      const slot = page.locator('.slot').first();
      await (form === 'phone' ? slot.tap() : slot.click());
      await page.waitForTimeout(300);
      const next = await page.locator('.card h2').first().innerText();
      if (next === name) throw new Error(`still on ${name} after placing them`);
    });
    const persist = await page.evaluate(async () => (navigator.storage?.persisted ? String(await navigator.storage.persisted()) : 'no API'));
    await check('privacy page', async () => {
      await page.goto(`${BASE}/privacy.html`);
      await page.getByRole('heading', { name: 'How privacy works' }).waitFor({ timeout: 4000 });
    });
    await browser.close();
    results.push({ label, problems, persist });
  }
}
server.kill();

let failed = 0;
for (const r of results) {
  const ok = !r.problems.length;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(17)} storage persisted: ${r.persist}`);
  for (const p of r.problems) console.log(`      ${p}`);
}
process.exit(failed ? 1 : 0);
