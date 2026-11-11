/**
 * pivot-parlor-uptime: every 5 minutes, checks that production answers the
 * way a visitor needs it to (src/checks.ts). A failing check is logged as an
 * error, which Workers Issues turns into an alert email.
 * Runbook: docs/runbooks/production-alerting.md.
 */
import { runAll, type Fetcher, type RunOptions, type UptimeEnv } from "./checks";

export async function runScheduled(env: UptimeEnv, fetcher: Fetcher, opts: RunOptions = {}): Promise<void> {
  for (const r of await runAll(env, fetcher, opts)) {
    if (r.ok) {
      console.log(`uptime ok ${r.name} (${r.ms} ms, attempt ${r.attempts})`);
    } else {
      // An Error object, so Workers Issues records it as a failure with this message.
      console.error(new Error(`Uptime check failed: ${r.name}: ${r.detail}`));
    }
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: UptimeEnv): Promise<void> {
    await runScheduled(env, (url, init) => fetch(url, init));
  },
} satisfies ExportedHandler<UptimeEnv>;
