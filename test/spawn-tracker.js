'use strict';
// Track every CLI child a test file spawns; when the file's tests finish, kill
// whatever survived — process GROUP included. A `pidge bridge` handler runs
// under `sh -c`: a straggler grandchild inherits the child's pipes and keeps the
// test process's event loop alive after the last test passes, so the runner
// never exits (on a Linux CI runner that reads as a job that hangs until the
// 6-hour kill). Spawn children with `detached: true` so each gets its own
// process group and the group-kill below can reach the grandchildren.
const { after } = require('node:test');

const tracked = new Set();

function track(child) {
  tracked.add(child);
  child.once('exit', () => tracked.delete(child));
  return child;
}

after(() => {
  for (const c of tracked) {
    try { process.kill(-c.pid, 'SIGKILL'); } catch { /* group already gone */ }
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
    for (const s of [c.stdin, c.stdout, c.stderr]) { if (s) s.destroy(); }
  }
  // Escape hatch: if a leaked handle still holds the event loop open 5s after
  // the last test (seen on Linux CI), exit with the code the runner already
  // decided instead of hanging forever. unref'd — it never fires on a clean run.
  const t = setTimeout(() => {
    console.error('spawn-tracker: event loop still alive 5s after the tests — leaked handles:',
      JSON.stringify(process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : ['n/a']));
    process.exit(process.exitCode ?? 0);
  }, 5000);
  if (t.unref) t.unref();
});

module.exports = { track };
