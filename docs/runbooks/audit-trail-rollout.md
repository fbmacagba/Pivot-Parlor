# Audit trail rollout (Plan 1)

Spec: `docs/superpowers/specs/2026-09-26-audit-trail-design.md`. Run by the operator, in order.
Every `wrangler` command below starts from `apps/worker` unless a step says otherwise.

**Read this whole page before doing anything.** Steps 0-2 must happen **before you open the
pull request**, not just before merging it. This repo's `e2e.yml` workflow runs D1 migrations
and deploys the worker to the **staging** environment on every pull request event (opened,
synchronize, reopened, labelled), not only on merge. If the staging archive bucket, the trigger
support, or the alert email secret are missing when the PR is opened, that automatic staging
deploy fails before anyone reviews anything.

Standing rule for every command below and for anything else in this repo: any `wrangler kv` or
`wrangler d1` command aimed at a real database, **staging or production**, must carry `--remote`,
or it silently talks to a local simulator instead of the real thing.

## 0. Prove the database accepts triggers (owner-gated, before opening the pull request)

The audit tables rely on two SQLite `CREATE TRIGGER` statements to block direct edits to the
trail. The local test simulator is real SQLite, but production/staging D1 may behave
differently, so this has to be proven against the real staging database once, with your
explicit go-ahead, before the migration first reaches it.

**Get an explicit yes to this question before running anything below** (it has a real side
effect on the shared staging database, so it needs a deliberate go-ahead in the moment, not an
assumption): "May I create and drop a throwaway table and trigger on the STAGING database to
prove D1 accepts triggers?" Only on a yes, run this from `apps/worker`:

```bash
npx wrangler d1 execute pivot-parlor-db-staging --env staging --remote --command "CREATE TABLE zz_trigger_probe (x INTEGER)"
npx wrangler d1 execute pivot-parlor-db-staging --env staging --remote --command "CREATE TRIGGER zz_trigger_probe_nd BEFORE DELETE ON zz_trigger_probe BEGIN SELECT RAISE(ABORT, 'probe blocked'); END"
npx wrangler d1 execute pivot-parlor-db-staging --env staging --remote --command "INSERT INTO zz_trigger_probe VALUES (1)"
npx wrangler d1 execute pivot-parlor-db-staging --env staging --remote --command "DELETE FROM zz_trigger_probe"
npx wrangler d1 execute pivot-parlor-db-staging --env staging --remote --command "DROP TABLE zz_trigger_probe"
```

`--env staging` is required: the staging database is only declared under `[env.staging]` in
`wrangler.toml`, and without it wrangler sends the database *name* where Cloudflare expects
its id, which comes back as a misleading "Authentication error [code: 10000]".

Expected: the `DELETE` command fails and prints `probe blocked` (in full:
`probe blocked: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`); that's the trigger
doing its job. `DROP TABLE` should then succeed and remove everything cleanly.

**Done 2026-11-07 on staging:** `CREATE TRIGGER` succeeded, the `DELETE` failed with exactly
the message above, the row was still there afterwards, and `DROP TABLE` left no
`zz_trigger_probe` objects behind.

**If `CREATE TRIGGER` itself fails or errors**, stop here: do not go on to Step 1 and do not
open the pull request. Tell the developer, with the exact error text. The branch as written
cannot be deployed to that database: a developer has to change the code first so the two
protective triggers are left out (the spec's section 6.1 fallback), and then this rollout starts
again from Step 0. Either way, write down what happened (it worked, or the error text) wherever
you're tracking this rollout.

## 1. Create and lock the archive buckets (before opening the pull request)

The worker binds `AUDIT_ARCHIVE` in **both** production and staging `wrangler.toml` blocks
already. A deploy fails outright if the named bucket does not exist, and per the warning at the
top of this page, staging gets deployed the moment the pull request is opened, not just at
merge.

```bash
npx wrangler r2 bucket create pivot-parlor-audit
npx wrangler r2 bucket lock add pivot-parlor-audit retain-6y --retention-days 2192
npx wrangler r2 bucket create pivot-parlor-audit-staging
npx wrangler r2 bucket lock add pivot-parlor-audit-staging retain-6y --retention-days 2192
npx wrangler r2 bucket lock list pivot-parlor-audit
npx wrangler r2 bucket lock list pivot-parlor-audit-staging
```

The rule name (`retain-6y`) is a positional argument in wrangler 4.105 (checked with
`npx wrangler r2 bucket lock add --help`). Each `lock add` then asks two questions: first
"Enter a prefix for the bucket lock rule": press Enter to leave it empty; then whether to add
the rule "without a prefix", which defaults to **no**: type `y`. The whole bucket is the intent.
Answering no cancels with "Add cancelled." and adds no lock, so check the `lock list` output.

Archive files expire at the same age as database entries (spec 6.2), which is 2192 days (6
years). Add a lifecycle rule a few days past the lock so objects are actually removed once they
age out (confirm the exact flag names first with `npx wrangler r2 bucket lifecycle add --help`,
since they can change between wrangler versions; the intent is "delete objects 2200 days after
upload"):

```bash
npx wrangler r2 bucket lifecycle add pivot-parlor-audit expire-6y --expire-days 2200
npx wrangler r2 bucket lifecycle add pivot-parlor-audit-staging expire-6y --expire-days 2200
```

Each `lifecycle add` asks for a prefix ("leave empty for all prefixes"): press Enter.

Anchor files (stored under `anchors/` in the same bucket) are covered by the same lock and
lifecycle rules; nothing extra to do for them.

**A lock rule can be removed by anyone with account access to this Cloudflare account.** It is
not a substitute for a truly independent backup. The daily anchor email (Step 4 below) is the
copy that protects against someone doing that; keep those emails and do not filter them to trash.

## 2. Set the audit alert email (before opening the pull request)

The nightly integrity check is the only thing that sends email here (the sealer that runs every
minute only writes an entry to the trail itself when it spots tampering; it never emails
directly). That nightly email, the daily "Audit anchor" message and any problem/tamper alert,
goes to a Worker secret, `AUDIT_OPERATOR_EMAIL`, **never** to anything stored in the database,
because a database is exactly what an in-account attacker could rewrite. If this secret is
unset, the nightly check still runs but silently notes "alert email not configured" instead of
actually emailing anyone.

Set it for **both** production and staging (the staging environment name in
`apps/worker/wrangler.toml` is `staging`, i.e. the `--env staging` flag below):

```bash
npx wrangler secret put AUDIT_OPERATOR_EMAIL
npx wrangler secret put AUDIT_OPERATOR_EMAIL --env staging
```

You'll be prompted to type the email address; use the mailbox you actually want the daily
"Audit anchor" email and any tamper/problem alerts sent to.

Also confirm `RESEND_API_KEY` (the email-sending provider's key) is already set in **both**
places. It's not new to this rollout: it's the same key booking reminders, waitlist
notifications and account-verification emails already depend on. Check it hasn't lapsed anyway,
since the exact same "alert email not configured" symptom appears if either secret is missing,
not just `AUDIT_OPERATOR_EMAIL`:

```bash
npx wrangler secret list
npx wrangler secret list --env staging
```

Look for `RESEND_API_KEY` in both lists (this only shows secret *names*, never values). If it's
missing from either, set it there too before continuing.

## 3. Open and merge the pull request

Once Steps 0-2 are done, open the pull request as normal.

- **Opening it** triggers `e2e.yml`, which runs the pending D1 migrations against the **staging**
  database and deploys the PR's worker code there before running the E2E tests. This is the
  first time both audit-trail migrations, `046` and `047`, reach a real, shared database.
  `node scripts/migrate.mjs` always applies every pending migration in order, so both go together
  even though nothing in the workflow files themselves names either migration number.
- **Merging it to `main`** triggers `deploy-worker.yml`, which applies the same migrations to
  **production** and deploys the API worker there (this branch's own change adds
  `packages/audit/**` and `package-lock.json` to that workflow's trigger paths, so a future
  change to either now redeploys the worker automatically).

Confirm both workflow runs finish green before treating either environment as done.

**The audit trail's own end-to-end test only runs if you ask for it.** On every pull request,
`e2e.yml` runs only its quick SMOKE tier (sign-in and public booking). The audit-trail test
(`tests/e2e/audit-trail.spec.ts`) is in the FULL tier, which runs only when the pull request has
the **`e2e` label** (or when someone runs the workflow by hand). Add that label to run it. The
audit-trail test alone waits about two and a half minutes for sealing and archiving. FULL also
includes the site-generation spec, but it does not spend AI credits on staging: its tests that
wait for a real generated site are skipped unless `E2E_SITE_GENERATION=1` is set (the workflow
does not set it), and the one that submits a real generation request only puts a job on
`site-research-queue-staging`, which no staging worker consumes.

## 4. Verify

1. Sign in as developer and open **Activity** (the page at `/dev/activity`). Opening it writes
   its own "Activity viewed" entry into the trail. You'll see it appear.
2. Pause and re-activate a site whose website is already live, on whichever environment you're
   verifying (staging right after opening the pull request, or production right after merging).
   **Use a shop you control and are prepared to have briefly offline for real visitors during
   the test, never a paying customer's shop.** On the Shops page, the button on a live site says
   **Pause**; once paused, the same shop shows a **Resume** button. Two new entries appear on
   Activity: "Site paused" and "Site made live", each showing the website status before and
   after under the entry when you expand it.
3. Watch the badge on each of those two entries change over the next couple of minutes: it
   starts **Pending**, then **Sealed**, then **Archived**. You may never see **Sealed**: the
   same once-a-minute run that seals an entry usually archives it straight away, so going
   directly from Pending to Archived is normal. (Allow up to about two minutes on either
   environment, and refresh the page to see the badge change.) **Right after the first deploy
   of this change, allow up to 15 minutes instead:** the once-a-minute schedule is new to each
   environment, and Cloudflare can take several minutes to start running a newly added
   schedule. On staging (2026-11-07) the first seal came about 6 minutes after the deploy;
   everything written in between stayed Pending and was then sealed and archived together.
   Nothing is lost while it waits.
4. Press **Check now** (top of the Activity page). A message appears below the buttons; once
   something has actually been sealed, it reads "Checked N entries (X to Y): the trail is
   intact." (If nothing has sealed yet, e.g. you check within the first minute, it instead
   says there was nothing to check yet; try again shortly.)
5. To look at what actually got written to the archive: click **Export proof** (next to Export
   CSV, top of the Activity page). The downloaded JSON has an `archive_objects` array of keys
   like `2026/09/27/000000000123-000000000124.jsonl`. Copy one of those as `<archive_key>` below
   (the Activity page itself does not show this key anywhere). Use whichever bucket matches the
   environment you're actually verifying, the two buckets are separate and a key from one will
   not be found in the other:
   ```bash
   # Staging:
   npx wrangler r2 object get pivot-parlor-audit-staging/<archive_key> --remote --pipe | head -c 400

   # Production:
   npx wrangler r2 object get pivot-parlor-audit/<archive_key> --remote --pipe | head -c 400
   ```
   This should print raw JSON lines: the entries themselves.
6. The next morning, three things should have happened automatically (the nightly check runs
   at 03:00 UTC, which is 04:00 during British Summer Time): an email arrives with the subject
   **"Audit anchor \<date\>"**, and the Activity page shows a new **"Trail checked"** entry and a
   **"Daily fingerprint emailed"** entry timed to match. From then on, the "Audit anchor" email
   should arrive every morning; see "If you get an alert email" below for what to do when it
   doesn't.

One more thing worth knowing before you use this page for real: clicking **Record erasure
request** on any person's entry does **not** erase anything immediately. It opens a
confirmation dialog first, naming the person and explaining that their name and email will be
blanked in the activity trail in 30 days, and that this request itself is recorded and cannot be
undone. It only changes the activity trail: the person's account, bookings and other records are
not touched. IP addresses in the trail need no request; they blank on their own 30 days after
each visit. Nothing happens unless you click **Confirm erasure request** in that dialog;
**Cancel** (or closing the dialog) leaves everything exactly as it was.

## 5. Import AI usage history (once)

Press **Import AI usage history** (bottom of the Activity page) once. The page reports how many
rows it just imported. **If that message ends with "run again for more.", press the button
again**, and keep doing that, **until a press reports rows with no "run again for more."
suffix (or reports none at all).** Imported entries are labelled **Historical** so they're
distinguishable from entries recorded live going forward. This only ever needs doing once, on
first rollout.

## If you get an alert email

The nightly check emails **"Audit trail needs attention"** with one line per problem it found.
The same lines are on the Activity page, in that night's **"Trail checked"** entry (expand it).
Do not delete the email. Forward it to the developer and keep a copy.

**No "Audit anchor" email by mid-morning (UK time) counts as an alert too.** The check runs at
03:00 UTC and sends that email every night. If it is missing, open Activity and look for last
night's "Trail checked" and "Daily fingerprint emailed" entries: missing entries mean the check
did not run; a "Daily fingerprint emailed" entry marked failed means the email could not be sent
(the next night's alert then also says "previous night's ... email could not be sent"). Either
way, tell the developer the same day.

What the lines mean, grouped by how seriously to take them:

**Treat as possible tampering (tell the developer straight away, change nothing yourself):**

- "Check failed at seq N: ..." or "History re-walk failed at seq N: ..." followed by
  "entry_hash does not match the entry", "chain_hash breaks the chain", "missing seq N",
  "entry missing from archive ...", "entry differs from archive ..." or "unknown archive
  format ...". An entry no longer matches its sealed or archived copy, or has gone.
- "newest entries missing". Entries that were already checked have disappeared.
- "N entries failed their integrity check when sealing" and "N entries are permanently unsealed
  after failing their integrity check". An entry was changed before it could be sealed. The
  second line repeats every night for as long as that entry stays in the trail; that is
  deliberate, not a stuck alarm.
- "N entries are in an impossible state (...)". The trail's bookkeeping was edited directly.
- "stored anchor for DATE no longer matches the chain at seq N". Compare with the "Audit anchor"
  email for that date in your mailbox; the email is the trustworthy copy.

**Something is stuck (usually infrastructure, still tell the developer the same day):**

- "N entries unsealed for more than 10 minutes", "N sealed entries unarchived for more than 1
  hour" or "verification blocked at seq N: sealed but not archived". The once-a-minute sealer
  or the archive bucket is not keeping up or is failing.
- "N actions in the last 24 hours have no recorded outcome". Something started and never
  reported whether it worked (for example a worker was stopped mid-way).
- "... verify error: ...", "could not write anchor for DATE: ...", "could not verify stored
  anchor for DATE: ...". The check could not read or write the archive bucket.
- "nightly check crashed: ...". The check stopped part-way; nothing was verified that night.

**Email delivery:**

- "previous night's alert email could not be sent (...)" or "previous night's anchor email
  could not be sent (...)". Last night's email failed; check your spam folder and ask the
  developer to check the email provider. "could not read the previous night's email record"
  means the check could not tell whether last night's email went out; treat it the same way.
- "alert email not configured". This one is never emailed (there is nowhere to send it); you
  will only see it on the Activity page. Redo Step 2.

## Restoring the database

**Read this before any D1 Time Travel restore** (`docs/DR-RUNBOOK.md` section 4). A restore
rewinds the audit trail along with everything else, but the archive bucket and your mailbox are
not rewound, and the locked bucket cannot be edited to match. Expect this afterwards:

- Every activity entry recorded after the restore point disappears from the Activity page. The
  archived copies of any that were already archived stay in the bucket, and the "Audit anchor"
  emails stay in your mailbox; those are now the only record of that window, so keep them.
- New entries reuse the sequence numbers the lost entries had. The nightly check will then
  report "stored anchor for DATE no longer matches the chain at seq N" for any recent anchor
  past the restore point.
- If a new batch gets exactly the same archive name as one already in the bucket (same day,
  same sequence numbers), the bucket refuses to overwrite it, archiving stops at that batch,
  and the nightly reports "sealed entries unarchived for more than 1 hour" and "verification
  blocked at seq N". This needs a developer; do not try to remove the lock.

So: before restoring, note the restore point and tell the developer that the audit trail will
need follow-up. After restoring, expect alert emails the next morning and forward them.

## Known limits (report these to the owner; they are not blockers, they are follow-up work)

- **A person with direct database access is not fully locked out.** Someone who can write to the
  production database directly could, in principle, get a forged copy of an entry archived, or
  could delete the newest entries, anything recorded since the last nightly check (so up to
  about 24 hours' worth), before that check runs;
  R2 objects for the affected window would then be orphaned or replaced. The daily anchor emails
  are exactly the backstop for this: because they land in your mailbox, outside this system, an
  attacker with database access alone cannot also rewrite or delete them, so keep every "Audit
  anchor" email as a durable, independent record. Properly closing this gap needs its own
  follow-up (an R2-side index that's reconciled against the database independently); it is not
  part of this rollout.
- **The nightly check only re-reads and compares the last 2 days' stored anchors.** It's not a
  standing guarantee that a stored anchor from further back hasn't been altered or deleted, only
  a check on the most recent one or two. The **emailed** copy of each daily anchor is what
  actually gives you an unlimited, tamper-proof history to fall back on, because it left this
  system the moment it was sent; the stored copy did not. This is the same reason Step 1 above
  says to keep every "Audit anchor" email.
- **Most of the app still isn't being watched.** This rollout (Plan 1) only instruments a first
  slice of actions. As of this branch, **66 API routes are still pending** (61 ordinary routes
  plus 5 proxy routes that forward payments/refunds/Connect-onboarding calls), plus **3 scheduled
  jobs (crons)** and **2 queues** in the main API worker. The separate background worker and
  booking worker have **no instrumentation at all yet**. In the meantime, any change that reaches
  the API worker through an un-instrumented route still gets *some* record; it shows up on the
  Activity page as **"Unlabelled change"**, but without the specific before/after detail a
  properly instrumented action would show. Finishing this coverage is Plans 2 and 3, not part of
  this rollout.

## Rollback

- **Code:** redeploy the previous worker version with `npx wrangler rollback`. The audit tables,
  the archive bucket contents, and every entry already written stay exactly as they are;
  nothing needs to be undone or cleaned up.
- **Migrations:** leave `046` and `047` applied even on a code rollback. They only add tables,
  columns and triggers; nothing in the rest of the app depends on them being absent, so there is
  no reason to reverse them.
- **The buckets cannot be emptied while locked.** That's intended, not a bug to work around.
