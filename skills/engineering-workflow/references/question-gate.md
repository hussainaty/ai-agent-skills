# The question gate

Before anything is built, find every question whose answer would change the
product, the design, the tests, or the cost. Give them to the human in one
document, then stop until the blocking ones are answered.

## How to find the questions

Read `RESEARCH.md` and the request, then walk this list. Ask a question only
when the answer is not already known from the request, research, memory, or
the code.

| Area | Typical questions |
|---|---|
| Outcome | Who uses it, for what job? What does "done" look like? What is the demo or launch date? |
| Users and roles | Which roles exist? What can each see and do? Who administers? |
| Scope | What is in the first release, and what is explicitly out? Which requests are nice-to-have? |
| Data | What data exists today, and in what format? Who owns it? Retention, privacy, personal data? |
| Integrations | Which external systems, APIs, payment, email/SMS, identity providers? Who holds the accounts? |
| Language and locale | Which languages? RTL? Date, number, and currency formats? |
| Platforms | Web, mobile, desktop, offline? Which browsers or devices? Weak-connectivity needs? |
| Non-functional | Users and load, response-time targets, availability, backups, audit logs |
| Security | Authentication method, multi-tenant isolation, compliance needs |
| Deployment | Where does it run (Vercel, Railway, a VPS, on premises)? Budget limits? Domain? |
| Budget and accounts | What can be paid for? Which free tiers? Who creates accounts and keys? |
| Acceptance | Which journeys must work in the demo? Who signs off? |
| Constraints | Must-use or must-avoid technologies, existing code to keep, deadlines |

## Rules

- **One document, all questions.** Do not drip-feed questions across turns.
- **Blocking vs non-blocking.** Blocking: a wrong guess means rework. A
  non-blocking question carries the default you will use if there is no
  answer.
- **Explain each question in one line.** Say why it matters, so the human can
  answer fast or delegate it.
- **Offer options.** Where possible, give 2–4 concrete options and mark the
  recommended one.
- **Stop.** Do not start Phase 3 while blocking questions are open. Research
  that answers a question is fine; building is not.
- **Record answers** in `DECISIONS.md` with the date and who decided. A later
  change of mind becomes a new decision entry, not an edit of history.
