'use strict';

// index.html's Content-Security-Policy is a second line of defence behind
// escaping: if text from a server or a saved host ever reached innerHTML
// unescaped, the markup still couldn't run code. This injects what such a
// slip would let through, and checks none of it runs. That every other file
// finishes without a violation (see harness.js) shows the policy leaves the
// app itself alone.

const { start, check, run, waitFor } = require('./harness');

run(async () => {
  const t = await start();

  const policy = await t.js(`(document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || ''`);
  check('the page has a Content-Security-Policy', policy.includes("script-src 'self'"), policy);

  // Violations the page reports, with the directive each one broke
  await t.js(`window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => __violations.push(e.effectiveDirective)); 'ok'`);

  // Markup with an inline event handler, as an unescaped host name would inject
  await t.js(`document.getElementById('home-view').insertAdjacentHTML('beforeend',
    '<img id="csp-probe" src="x" onerror="window.__ranHandler = true">'); 'ok'`);
  // An inline <script>
  await t.js(`(() => { const s = document.createElement('script');
    s.textContent = 'window.__ranScript = true';
    document.body.appendChild(s); })(); 'ok'`);
  // eval and its relatives
  const evalResult = await t.js(`(() => { try { return eval('"evaluated"'); } catch (e) { return e.name; } })()`);
  const functionResult = await t.js(`(() => { try { return new Function('return "evaluated"')(); } catch (e) { return e.name; } })()`);

  await waitFor(() => t.js(`__violations.length >= 3`), 2000);
  const ran = await t.js(`({ handler: window.__ranHandler === true, script: window.__ranScript === true })`);
  check('an injected inline event handler doesn\'t run', !ran.handler, ran);
  check('an injected <script> doesn\'t run', !ran.script, ran);
  check('eval is refused', evalResult === 'EvalError', evalResult);
  check('new Function is refused', functionResult === 'EvalError', functionResult);
  check('and the injected image isn\'t even fetched', (await t.js(`__violations`)).includes('img-src'), await t.js(`__violations`));

  // The harness's own watcher saw them too, so its check in every other file means something
  check('the harness sees violations in the console', t.cspViolations.length >= 3, t.cspViolations.length);
  t.cspViolations.length = 0; // these were on purpose
});
