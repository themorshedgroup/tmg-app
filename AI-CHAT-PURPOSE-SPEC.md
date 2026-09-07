# AI Chat — purpose pivot spec

**Status:** decisions made, nothing built. Written 2026-09-07, updated 2026-09-08.
**Decision owner:** Symon.

---

## The decision

AI Chat stops being a general-purpose chatbot. It becomes a small set of
**app-only** surfaces that answer questions about TMG's own data — tasks, deals,
calls, KPIs, the calendar.

Anything general — drafting, research, "analyse this spreadsheet", "write me a
report" — moves to **Gemini**, which the team already has through Google
Workspace at no extra cost.

**Why:** the API spend was never the automations. It was people using AI Chat and
CRM Tasks AI as a free-form assistant. The measured averages:

| Surface | Avg tokens per call | Total logged |
|---|---|---|
| CRM Tasks AI | **114,000 input** | 5.9M input over 52 calls |
| AI Chat | **21,000 input** | 0.94M input over 45 calls |

One CRM Tasks session cost about $20 on its own. A brief costs a cent or two.

---

## What stays

**The assistant itself stays, for everyone.** It stays conversational — a text
box you can talk to. What changes is what it is allowed to know about: TMG's own
data (CRM, tasks, deals, calls, and the emails that person has connected) and
nothing else. Asked something outside that, it says so and points to Gemini
rather than answering.

Around it, **Projects and Conversations are removed** (see "What comes out"), so
the assistant is a single ongoing chat with a Clear button — the Kikos model.

Then three click-to-run surfaces. Each one is **a database query plus a short
piece of writing** — never the model going looking for things itself.

### 1. Today's Brief
**On demand — the person clicks it.** Never generated automatically.

- **The app gathers:** today's tasks, today's calendar events, anything overdue,
  deals with a date this week.
- **Claude does:** writes 3–5 sentences — what matters today, what's slipping.
- **Budget:** ~4,000 input / 600 output tokens.

### 2. Weekly Brief
**On demand — the person clicks it.** Never generated automatically.

- **The app gathers:** last week's completed tasks, this week's due items, KPI
  numbers for the week, deals that moved stage.
- **Claude does:** a short recap and the week's three priorities.
- **Budget:** ~15,000 input / 1,500 output tokens.

### 3. Today's Call List
On demand, per person. **Same calls that already show under the Calls tab —
this is a summary of that list, not a second list.** No manager/team view.

- **The app gathers:** that person's calls for today from the Calls tab, plus
  each contact's linked deal, last contact date, and open tasks.
- **Claude does:** orders them and writes one line per call on why it matters
  today.
- **Budget:** ~6,000 input / 800 output tokens.

---

## The rules that keep this cheap

These are the whole point. Without them the cost goes back where it was.

1. **The app assembles the data. The model never searches.**
   No tool calls, no "let me look that up", no fetching. The edge function runs
   fixed SQL, gets rows back, and hands the model a finished list.
   *This is also the accuracy control — the model cannot invent a number it was
   handed.*

2. **Hard row caps, enforced server-side.**
   Every query has a `LIMIT`. If someone has 400 open tasks, the brief covers the
   top 30, and says so. The $20 CRM Tasks incident was exactly this: a search
   walking 785 rows.

3. **Hard token cap per call.**
   Reject the request rather than send an oversized prompt. A brief that costs
   more than a few cents is a bug, not a big day.

4. **Nothing generates on a schedule. Everything is click-to-run.**
   Cache each result for the day it covers: clicking twice re-reads the saved
   one rather than paying again. Nobody is charged for a brief they never opened.

5. **Every call is tagged in `usage_log`.**
   New feature tags: `brief_daily`, `brief_weekly`, `call_list`. If a surface
   isn't tagged, it doesn't ship — that blind spot is what hid the Christie's
   crawler's spend for a month.

6. **Haiku 4.5 unless there's a reason.**
   Summarising rows you already handed it is exactly what Haiku is for, at half
   Sonnet 5's price. Use Sonnet 5 only where judgement is genuinely needed.

---

## What it costs

**Upper bound.** Assumes all 9 people run all three surfaces every working day.
They're click-to-run, so real spend will be lower — nobody is charged for a brief
they didn't open.

| Surface | Sonnet 5 | Haiku 4.5 |
|---|---|---|
| Today's Brief | ~$2.80/mo | ~$1.40/mo |
| Weekly Brief | ~$1.75/mo | ~$0.90/mo |
| Today's Call List | ~$4.00/mo | ~$2.00/mo |
| **Total** | **~$8.50/mo** | **~$4.30/mo** |

For comparison: 52 CRM Tasks AI calls cost roughly $12.

---

## What comes out

- **Projects** — the whole AI Projects feature. Removed.
- **Conversations** — the saved-chat list and history sidebar. Removed. The
  assistant becomes one ongoing chat with a **Clear** button, like Kikos. Nothing
  to name, file, or come back to.
- **CRM Tasks AI bulk operations** — already flagged as never-use. Make that a
  code-level block, not a note.
- **The attach button** — replaced by a **trash/clear button** for the chat.
  This is the single most effective change here: no uploads means no 21,000-token
  calls. Pasted-document analysis is Gemini's job now.

The assistant itself is **not** removed, and is not admin-only. Everyone keeps it.

### How "only app data" is actually enforced

Worth being precise, because a system prompt alone won't do it:

1. **It has no way to reach the outside.** No web search, no tool calls, no
   fetching. It can only see what the app puts in front of it.
2. **The system prompt tells it to decline** anything not answerable from the
   supplied TMG data, and to name Gemini as the place for that.
3. **The real cost control is an input cap, not a topic rule.** AI Chat averaged
   21,000 input tokens per call — that is people pasting documents in, not people
   chatting. Cap the input; reject a long paste with "that's a Gemini job".

Points 1 and 3 are what actually hold. Point 2 is manners: a model can still
answer "what's the capital of France" from its own knowledge, and that is fine —
it costs a fraction of a cent and isn't worth engineering against.

---

## Guardrails to build alongside

- A **monthly spend cap per person** already exists as a warning ($20). Make it
  actually block once the briefs are the only surfaces, since a brief can never
  legitimately reach it.
- **Log failed calls too.** Right now a Claude outage looks identical to nobody
  using the app — which is why the Aug 14 – Sep 7 silence took this long to spot.

---

## Decided

- The assistant **stays for everyone**, conversational, scoped to app data.
- **Projects: removed** (UI only).
- **Conversations: removed** (UI only) — one ongoing chat with a Clear button.
- **The database tables stay.** Only the UI goes, so nothing is lost and the
  decision is reversible if someone misses it in week two.
- **The attach button is removed**, and a **trash/clear button takes its place.**
- The chat **still syncs across a person's devices** — it is one saved
  conversation per person, not a browser-local scratchpad. Clear empties it.
- **Briefs and the call list never auto-generate.** They run when clicked.
- **The call list is per-person only.** No manager or team-wide view.
