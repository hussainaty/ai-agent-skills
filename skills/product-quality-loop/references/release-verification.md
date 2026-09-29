# Release, data, and email verification

Read the sections relevant to the requested change. These are operational checks, not a requirement to deploy, reseed, email people, or audit unrelated systems on every task. Authorization comes from the user and task context.

## Confirm the actual environment

- Identify the frontend project and alias, backend deployment, connected database/schema, storage, and relevant workers or providers. Similar project names and local Docker services are not evidence of which resources production uses.
- Verify configuration presence and usability without displaying secrets. Distinguish an unset variable, a value configured for the wrong environment, and a running deployment that has not received the new value.
- Check current schema revision before releasing code that expects new columns or tables. Choose a compatible migration/deployment order. Review data effects, existing recovery options, and transaction boundaries; require a recoverable backup for destructive data work. Do not run production downgrade tests or reset schemas to validate a release.
- If a report says everything passed, inspect evidence for the relevant current revision and target. A green local run cannot establish live schema or provider readiness.

## Seed complete, coherent examples

- Resolve exactly which tenant, projects, and records are in scope. A real application containing demo data is still a real application. Preserve accounts, invitations, user-authored content, and unrelated tenants. Destructive replacement needs authorization for those exact targets.
- Prefer an idempotent seed using stable keys and explicit ownership. Rerunning should update intended fixtures without multiplying rows, approvals, attachments, tasks, or outbound notifications. Do not invoke mail or paid AI incidentally through seed hooks.
- Cover the requested workflow with linked records, not just counts: for example, brief -> concept -> treatment -> script -> storyboard -> scene breakdown -> production/post-production pages. Use the actual application's model, IDs, state machine, and permissions; do not invent a generic pipeline where the product differs.
- For requested or affected workflows, check the first-item flow separately from seeded content. A page must remain usable when no parent/artifact exists, or explain and link to the real prerequisite. A completed sample's locked state must not be mistaken for a broken creation flow.
- Attach real, retrievable assets of the expected type. Verify storage retrieval and at least a representative displayed image/document under the intended role. A database row or nonempty URL does not prove the file opens. Identify synthetic/example media honestly; notes or placeholder attachments do not satisfy a requested playable final video.
- Verify the scope explicitly: one complete sample does not satisfy a request to fill every named project. Check requested locales, readable content, stage links, deadlines, assignments, and relevant attachments. Avoid duplicate pseudo-translations such as adding an '(ar)' suffix to untranslated content.
- Verify persistence by re-reading live records and opening the representative journey in the live app. Separate checks of database contents from checks of what a particular role can actually see.

## Temporary seed or maintenance access

Use the established CLI/admin path when available. Create a temporary endpoint only when authorized and necessary; do not add one merely because access is inconvenient.

- Restrict it to the exact operation and target. Use a cryptographically random secret, constant-time validation, rate/concurrency controls, and a durable atomic single-use claim so concurrent requests cannot both perform the operation.
- Keep secrets out of URLs, browser code, source control, logs, and output. Record success only after the operation commits. An ambiguous timeout must trigger an audit/data check before retrying; use an idempotent operation and deliberate recovery for a claimed but unfinished run.
- On completion or abandonment, disable access and remove temporary secrets. If runtime configuration is fixed at deployment time, redeploy or otherwise invalidate all still-reachable deployments that retain access; removing a setting from the dashboard alone may not revoke an old deployment.
- Verify retirement without rerunning the seed. Check the route is absent/disabled and any relevant retained deployment cannot still execute it. Report incomplete cleanup as outstanding work.

## Deploy and verify the published result

- Deploy the intended change set to the existing project/URL unless the user requested a new destination. Keep deployment authorization separate from unrelated source pushes or repository changes.
- A returned URL, successful upload, or 'Building' state is not a finished deployment. Inspect the final provider status. If the command disconnects, inspect that deployment before starting another.
- Confirm the intended alias resolves to the completed deployment and the frontend points to the expected backend. Account for environment updates that require a new build/deploy.
- Smoke-test the changed workflow on the live target: authenticated access, relevant data/asset retrieval, affected routes, and the intended roles. Prefer read-only checks; use explicitly scoped disposable records if a live mutation is needed. Do not direct a destructive local test suite at production.
- A dashboard HTTP 200 can be a login shell or error screen. It proves an HTTP response, not successful authentication or a functioning workflow. Match the final claim to what was actually checked.

## Invitations, recovery, and notifications

- Send real messages only when authorized. Confirm recipients, names, tenant/project, role, sender, and canonical application URL. Preserve Unicode names. Tenant Project Managers must not acquire platform-wide authority through an invitation.
- Before sending, confirm that the required schema/configuration and invitation or recovery pages are usable at the canonical target. Complete their deployment first; an emailed link should not depend on an unfinished release.
- Inspect existing account/invitation state through an authorized administrative path before sending. Reuse the established service and its token expiry, hashing, and single-use rules. Never manufacture credentials, expose raw invite/reset tokens, or reset another person's password directly.
- For an existing account, choose the flow that fulfills the request. Recovery is appropriate when restoring access is requested or already authorized; otherwise retain the account and use an authorized existing-user invitation or welcome flow if available. Explain any substitution. Do not silently count a recovery request as a new invitation.
- Before retrying after a timeout, check persisted invitation/outbox/provider status. Reconcile the original attempt; avoid duplicate emails and conflicting active tokens. Respect rate limits.
- Distinguish evidence precisely:

| Observed result | Supported statement |
| --- | --- |
| Opaque recovery HTTP 202 | Recovery request accepted; delivery and account existence remain unconfirmed |
| Outbox/queue record | Email queued |
| SMTP/provider accepted message | Mail transport accepted the message; check what the app's 'sent' flag actually means |
| Provider delivery receipt | Recipient server accepted delivery |
| Recipient/mailbox confirms Inbox placement | Inbox receipt confirmed for that message |

- Do not promise Inbox placement or zero spam. If deliverability is in scope, inspect relevant sender authentication and authorized mailbox/provider evidence; do not infer a need to alter a recipient domain's DNS just because an email is addressed there.
- Verify the acceptance/reset journey using a designated test account when needed. Never redeem a real recipient's link on their behalf as a test. Report unsent, failed, pending, and confirmed messages individually.
