# Waypoint — Product & UI Specification (for external review)

## 1. What the product is

Waypoint is an internal **B2B sales account-management book** used by a Tencent cloud sales team in Malaysia. It tracks customers, the people inside those customers, opportunities, interactions (meetings/calls), action items, product catalogue, and an audit trail. Single-page app, one HTML file (`Waypoint-v1.html`) + a small Node server, JSON data store, offline-tolerant sync with server-side merge.

Users sign in with name + password. Two roles:

- **BD (Business Development)** — owns accounts, sees own scope.
- **SA (Solution Architect)** — supports accounts.
- **Admin** — adds users/customers, deletes records, sees audit.

## 2. Design language

- **Tokens**: CSS variables for spacing (`--s1..--s5`), radius (`--r-xs..chip`), colors (`--ink-0..3`, `--line`, `--surface`, `--blue`, `--risk`...). Font stack system UI; numbers use tabular figures.
- **Two row shapes**: *cards* for objects you act on (customers, opportunities, people), *flow rows* (`.flow`, hairline-separated, no card chrome) for streams you read (timelines, audit, history).
- **Toolbar idiom**: every list screen = header row (h1 + count subtitle) → filter strip → list. Filters are **stat-chips** (number + label, e.g. `4 decide`, `2 can stop it`) that double as filters; the active one is highlighted.
- **Segmented controls** (`.seg`) for switching views that are mutually exclusive (board/list, cards/map, people/departments, classification/department grouping).
- **Dropdown `<select>`** for filters with >6 options (department filter), never a wall of chips.
- **Search boxes** appear only when a list is long enough to need one.
- **Hover action layer**: a resting row is information only — pencil (edit) and bin (remove) icons float in on row hover (opacity 0 → 1), 24px square icon buttons. Same rule everywhere; keyboard focus also reveals them.
- **Inline edit**: clicking Edit turns the record's own body into fields (same frame, same position), not a separate dialog. Cancel restores.
- **Two-step remove**: Remove → the row itself becomes a confirm ("Remove X?  Yes, remove / Cancel"). Never a browser dialog.
- **Toasts** for every commit ("Added — Sarah Lee", "Renamed to Network & Rollout · 2 people moved").
- **Drawer + pinned split**: list screens open a record in a right drawer over a dimmed list; can be pinned into a 38%/62% split. ESC unpins then closes.
- **Empty states** are one line, actionable ("No departments yet. Add the ones U Mobile actually uses."), never lectures.
- **Explanations live in `title` tooltips**, not prose paragraphs. If a paragraph was needed to explain a control, the control is wrong.
- Dense/comfortable row density toggle; mobile-responsive (nav collapses, grids go 1-col).

## 3. Screens

### 3.1 Today
Roll-up: overdue/next actions across accounts, upcoming closes, recent interactions, signals to check.

### 3.2 Calendar
Month view of interactions, steps and close dates.

### 3.3 Customers
Board (cards) / List toggle. Cards show health, next step, last touch, open threats. Filters: search, industry, owner, health. Click → **Customer page** with tabs:

- **Brief** — account summary: industry, health, Primary BD / Primary SA, products used, opportunities snapshot, next steps.
- **People** — see §4 (the deepest screen).
- **Systems** — the customer's incumbent systems; stance per system: *Replace / Both / Integrate / Keep*.
- **Opportunities** — board or list; stages (Interested → … → Won/Lost), value RM, probability, close date, competitor, owner; drag on board, inline edit, weighted pipeline figures.
- **Timeline** — merged stream of interactions, notes, steps, signals; grouped by day.
- **Files** — attachments.

### 3.4 People (global)
All contacts across customers, cards/map toggle, search, customer picker, stance filter (chip + dropdown for customer).

### 3.5 Opportunities
Board (Kanban by stage) / List. Hover layer actions. Inline expansion shows next step + last touch.

### 3.6 Interactions
Chronological log grouped by month (past months collapsed with counts). Each entry: title, date, kind chip, attendees (their side / our side / third party), Details/MOM, Outcome. "Log an interaction" form (see §5).

### 3.7 Products
Catalogue with abbreviation chips, categories, specialists; assign products to accounts.

### 3.8 Insights
Cross-account figures: pipeline totals, coverage gaps, quiet accounts.

### 3.9 AI Tasks / Admin
AI processing queue; admin: users, roles, audit log (filterable by kind, searchable), workspace config.

## 4. Customer → People tab (redesigned)

Master–detail: filterable roster left, person card right.

**Toolbar**: segmented `People 24 | Departments 11` → then, per view:
- People view: [Show relationship map] · seg [By classification | By department] · [Compact]
- Departments view: just the list (see below)

**Roster (People view)**
- Strip of stat-chip filters: `24 people · 4 decide · 1 can stop it · 2 against us · 3 quiet 45d+ · 2 no owner` + a **department dropdown** (`All departments · 24 / Commercial · 6 / … / Not placed · 3`) — a select, not chips, because department count is unbounded.
- Grouped list (by classification or by department). Row = avatar (ring color = stance) · name · title · stance tag · last met · owner.
- **Person card** (right): avatar, name, stance badge, title; fields — Department (input with datalist of this customer's depts), Reports to (select of colleagues; click-through navigation), Our owner (input + datalist of team, free text allowed — no account required), Email, Phone, LinkedIn (exact URL only), "In a room with us" (meeting count), Classification chips (Decision maker / Blocker / Influencer — 3 bands, "User" was removed), links, PDPA footer. Edit mode converts fields in place; classification chips commit on tap without leaving edit.

**Departments view (module)**
- One card: stat strip (`11 departments · 21 placed · 3 not placed`), search (appears >6 depts), then **one line per department**:
  `[monogram] Commercial ············· 6 people · 3 decide` with pencil/bin icons in hover.
- **Monogram ring is dashed if the department was guessed from a job title** (not written down); solid once confirmed. Tooltip explains. Renaming a guessed name to the same word confirms it.
- Rename: row becomes input + Save/Cancel; renaming moves everyone in it and follows the filter.
- Remove (two-step): department goes, its people become "Not placed" — people are never deleted.
- **Not placed** is a real last row (count only, no actions).
- Footer action in the strip: `+ Department` → inline input with datalist of names used on other accounts.
- Departments are stored **per customer** (`c.depts`, rows `{id, n}`), not global — two customers may name the same work differently.

**Relationship map / org chart**
- Toggle. If any person has "Reports to", the chart is the real tree (parent centered over children, horizontal scroll when wide, never shrunk). Otherwise tiers are drawn from title seniority and a one-line caption says so.
- Cards in chart: avatar ring = stance, name, wrapped title, "never met" warning in red. Click opens the person.

## 5. Logging an interaction

One form produces up to three records:
1. The interaction itself: Customer · Title · Attendees (room picker: their side ranked by decision weight / our side / third party) · **Details/MOM** (textarea) · Outcome · Type.
2. **Next step** (optional) + due date → a real tracked action (enters Tracker, timeline, overdue nagging; tracker defaults to account's Primary BD/SA).
3. **Opportunity** (optional) + value RM → created at stage "Interested", description "Raised in: <meeting title>".

Interaction types: Meeting · Workshop · Call · Video call · Email · Demo · Site visit · Training · Review · Social (single source list shared by picker, edit form, CSV import).

Timeline entry merges outcome + "Next: …".

## 6. Core interaction rules (the "grammar")

1. Half-of-the-record: BD sees/edits BD fields, SA sees SA fields; admin-only deletion enforced server-side too.
2. Nothing that looks like a choice may do nothing; every drawn filter works.
3. No fake AI — AI features show their provenance, and say so when nothing is configured.
4. Deleting is two-step, inline, row-identified.
5. Forms close when you navigate away (screen, customer, or tab change cancels add/edit state — an edit belongs to the place it was made).
6. Dates are ISO or refused; money parsed strictly; CSV imports validated with row-level refusals listed.
7. Timeline has one shape for all event kinds.
8. Names are the identity for org links (boss/dept), so renames propagate.
9. Multi-user: server merges by row `id` + `updatedAt`, removals are an envelope, conflicts counted and surfaced honestly ("Saved with 2 conflicts").

## 7. Known open issues

- LinkedIn chips: person rows currently render no link in test env (3 failing checks).
- Stance and owner fields for U Mobile's 24 contacts still unverified (names/titles/classification/departments done).
