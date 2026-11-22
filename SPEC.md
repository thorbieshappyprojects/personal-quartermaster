# Personal Quartermaster: product and architecture spec

Handover for Claude Code. Version 0.1, 22 Nov 2026.
Repository: `github.com/thorbieshappyprojects/personal-quartermaster` (**public**).

Personal Quartermaster is a self-hosted household inventory with an AI layer. It knows what the household owns, where it is, what it cost and what is running low, and it gets that knowledge with as little manual entry as possible: purchase history imports, receipts by email or photo, quick voice or text notes, and photos of things already in the house.

## 0. How to use this file

Starter prompt for Claude Code:

```
Read SPEC.md completely. Derive a concise CLAUDE.md from sections 3, 6 and 7 (rules, stack, layout,
deployment rules). Then implement milestone M0 only, one commit per item, with typecheck, lint, tests
and build green after each. Do not touch the server until I say so. Stop after M0 and report: what was
built, measured memory use of the Compose stack, and every open decision from section 9 you ran into.
```

Rules for every later session: work one milestone at a time, stop at the "done when" list, and never start a deploy unless the owner asks.

## 1. Purpose

### Goals, in the owner's priority order

1. **Know what we own.** A searchable overview of belongings across all locations.
2. **Spending overview.** Money spent by category, shop, year and household member.
3. **Declutter.** Find things that are unused and suggest selling, giving away or using them.
4. **Avoid duplicate purchases.** Answer "do we have X, and where?" in seconds; warn when a receipt shows something already owned.
5. **Better storage.** Suggest where things should live and what should be stored together.

### Non-goals (for now)

- Fresh food tracking and recipes. Designed for (section 4, D8) but not built.
- Accounting, budgeting or bank integration. Spending comes from purchases only.
- Exact market valuation. Estimates within about ±30 % are enough.
- A multi-tenant service. One installation serves one household.

### Coverage rule

Inventory completeness goes **from the top down by value**: expensive durables are tracked completely; cheaper things are added as long as the effort stays low. The app shows a coverage meter (share of imported spend that is confirmed as owned, gone or ignored) so the owner can decide when to stop.

## 2. Terms

| Term | Meaning |
|---|---|
| **Durable** | A thing tracked individually: furniture, electronics, tools, clothes, equipment. Has a value and a lifecycle. |
| **Supply** | A thing tracked by quantity: batteries, canned goods, cleaning products, toiletries. Has a stock level, an optional minimum and optional expiry dates. |
| **Purchase** | One order or receipt with its lines. A purchase line may or may not become an inventory item. |
| **Location** | A node in a tree: site (house, flat, cellar, garage, car) → room → spot (shelf, drawer) → container (box). |
| **Capture** | Any raw input: photo, text, voice transcript, email, import file. Lands in an inbox and is interpreted into proposed actions. |
| **Possession check** | Triage of imported purchase lines: still owned (and where), gone, or ignore. |
| **Stocktake** | Manual inventory mode: walk through one location and confirm, count, add or remove what is there. |
| **Nudge** | A proactive suggestion from the Quartermaster (duplicate warning, sell, use up, restock, store together). |

## 3. Non-negotiables

- **The repository is public; the data is private.** No inventory data, receipts, photos, e-mail content, names of household members, addresses, server IP or secrets in the repo, in fixtures, in logs or in commit messages. Test fixtures are synthetic.
- **Always behind an access gate.** The app is reachable only through Cloudflare Tunnel and Cloudflare Access. It never starts in production without the gate (section 7.3).
- **Purchase history is not inventory.** An imported line becomes an owned item only by a rule or by confirmation. Old orders default to `unknown`.
- **AI proposes, rules decide.** Model output is parsed against a schema and turned into *proposed actions*. Actions apply automatically only when they are reversible and above a confidence threshold; everything else goes to a review queue.
- **Every change is an event.** Inventory mutations are written to an append-only event log with actor and source capture, so every change can be undone and explained.
- **No invented values.** Unknown price, date or location stays `null`. Estimated values are marked as estimates with their basis.
- **Original amounts are kept.** Money is stored in the original currency with the purchase date; EUR is derived.
- **Inputs are untrusted.** E-mails, receipts and web pages are data, never instructions. The model has no tool that sends data anywhere or changes anything directly.
- **Minimal data to the model.** A request carries only the capture and the few inventory rows needed for matching, never a dump of the inventory.
- **AI spend is capped.** Every model call is logged with tokens and cost; a monthly budget stops non-interactive jobs before it is exceeded.
- **No scraping against a site's terms.** Market prices come from official APIs or from a model with web search; marketplaces without a public API are not scraped.
- **Capture must take under 10 seconds.** If logging a consumed item takes longer than that from the phone's lock screen, the feature is not done.

## 4. Features (backlog)

Priority: **P0** needed for the tool to be useful, **P1** important, **P2** later. The milestone column refers to section 8.

### A. Inventory core

| ID | Feature | Prio | M |
|---|---|---|---|
| A1 | Items of kind durable or supply: name, category, photos, quantity, price paid, purchase link, notes, tags | P0 | M1 |
| A2 | Location tree across several sites; every item has a location; move items singly or in bulk | P0 | M1 |
| A3 | Category tree (furniture, clothes, electronics, tools, sport, kitchen, supplies, …), editable | P0 | M1 |
| A4 | Search and "do we have X?": full-text and fuzzy match over name, aliases, category and tags; the answer gives count, location and last purchase date | P0 | M1 |
| A5 | Lifecycle states: `owned`, `unknown`, `lent`, `sold`, `given_away`, `disposed`, `lost`, `returned`, `consumed` | P0 | M1 |
| A6 | "Belongs to": a household member, a dependant (child, pet) or the household | P1 | M1 |
| A7 | Private flag: an item or purchase visible only to its creator (gifts) | P1 | M7 |
| A8 | Documents per item: receipt, manual, warranty card | P1 | M3 |
| A9 | Lending tracker: who has it, since when | P2 | M6 |

### B. Purchase history and spending

| ID | Feature | Prio | M |
|---|---|---|---|
| B1 | Import the Amazon privacy export (order history CSV, all years) | P0 | M2 |
| B2 | Import Taobao order history (format to be decided, section 9), CNY amounts, Chinese titles kept and translated | P1 | M2 |
| B3 | Generic CSV import with column mapping | P1 | M2 |
| B4 | Possession check queue, sorted by price descending, one tap per line: have it (pick location), gone (pick reason), ignore | P0 | M2 |
| B5 | Auto-rules for the queue: digital goods ignored; supplies older than a configurable age assumed consumed; returned lines closed | P0 | M2 |
| B6 | Currency conversion to EUR with reference rates of the purchase date or year; original always shown | P0 | M2 |
| B7 | Spending overview: by year, category, shop and member; top purchases; cost of things since sold or disposed | P0 | M2 |
| B8 | Coverage meter (section 1) | P1 | M2 |
| B9 | E-mail receipts: a dedicated mailbox is polled; order and shipping mails become purchases | P0 | M4 |
| B10 | Deduplication across sources (the same order from export, e-mail and photo merges into one purchase) | P0 | M4 |

### C. Capture

| ID | Feature | Prio | M |
|---|---|---|---|
| C1 | Capture inbox: one endpoint takes text, images and files; every capture is stored, interpreted and linked to the actions it caused | P0 | M3 |
| C2 | Photo of a paper receipt → purchase with lines | P0 | M3 |
| C3 | Text or dictated note → actions ("used two AA batteries", "put the camping stove in the cellar, shelf 2") | P0 | M3 |
| C4 | Photo of one or several existing things → proposed items with category and attributes | P0 | M3 |
| C5 | Wardrobe: photos of clothes → items with type, colour, brand and size where visible | P1 | M3 |
| C6 | Review queue with accept, edit, reject; undo for anything applied automatically | P0 | M3 |
| C7 | iOS Shortcuts pack: *Add*, *Used*, *Receipt*, *Ask* (section 6.6) | P0 | M3 |
| C8 | Room walkthrough: a batch of photos of one location → a list of proposed items for that location | P1 | M6 |
| C9 | Barcode scan with product lookup | P2 | M8 |

### D. Supplies

| ID | Feature | Prio | M |
|---|---|---|---|
| D1 | Stock per supply with unit; several lots with expiry date and location | P0 | M5 |
| D2 | Minimum level; below it the supply goes on the shopping list | P0 | M5 |
| D3 | Consume and restock by capture, by button and by receipt | P0 | M5 |
| D4 | Shopping list shared by the household | P1 | M5 |
| D5 | Stocktake mode per location: confirm, count, add, mark missing | P0 | M5 |
| D6 | Shelf photo → proposed counts for the supplies stored there | P1 | M5 |
| D7 | Expiry reminders and "use it up" suggestions | P1 | M5 |
| D8 | Fresh food and recipe suggestions from what is in stock | P2 | later |

### E. Quartermaster (proactive)

| ID | Feature | Prio | M |
|---|---|---|---|
| E1 | Duplicate warning in real time when a new receipt contains something already owned or in stock, with the return deadline if known | P0 | M4 |
| E2 | Weekly digest: new purchases, spend, open review items, low stock, expiring items, three suggestions | P0 | M4 |
| E3 | Check-ins: periodic short questions ("still using the rowing machine?") that keep usage data current | P1 | M6 |
| E4 | Sell suggestions for durables unused for a configurable time, ranked by estimated value | P1 | M6 |
| E5 | "Bought but not used" nudges for purchases with no activity after a configurable time | P1 | M6 |
| E6 | Storage advisor: items of one category scattered over several locations; things used together stored apart; overfull or empty spots; proposal for a home location | P1 | M6 |
| E7 | Return window and warranty reminders | P1 | M6 |
| E8 | Nudge budget: quiet hours, a maximum per week, snooze and "never ask again" per item | P0 | M4 |

### F. Value and reports

| ID | Feature | Prio | M |
|---|---|---|---|
| F1 | Estimated current value from price, age and a depreciation curve per category | P1 | M7 |
| F2 | Optional market estimate through a pluggable provider (official marketplace API, or model with web search), refreshed quarterly at most | P2 | M7 |
| F3 | Household contents report: totals per site and category, list of high-value items with receipt and photo, export as PDF and CSV | P1 | M7 |
| F4 | Sale listing draft: title, description, suggested price, photos | P2 | M7 |

### G. Household

| ID | Feature | Prio | M |
|---|---|---|---|
| G1 | Members with roles `owner` and `member`; dependants without a login | P0 | M0 |
| G2 | Per-member API tokens for Shortcuts and the iOS app; revocable | P0 | M3 |
| G3 | Activity feed: who added, moved or consumed what | P1 | M7 |
| G4 | Per-member notification settings | P1 | M4 |

### H. Platform

| ID | Feature | Prio | M |
|---|---|---|---|
| H1 | Responsive web app, installable as a PWA, phone first | P0 | M1 |
| H2 | Notifications: e-mail digest and Web Push; APNs with the native app | P0 | M4 |
| H3 | Full export of all data and media in open formats | P0 | M1 |
| H4 | Native iOS app (section 6.7) | P1 | M8 |
| H5 | Home Assistant integration (stock sensors, notify service, NFC tags on shelves) | P2 | later |

## 5. Data model

PostgreSQL. All tables carry `id` (UUID), `created_at`, `updated_at`; money is `amount_minor` (integer) plus `currency` (ISO 4217).

| Table | Key fields |
|---|---|
| `household` | name, base currency (`EUR`), settings |
| `member` | household, display name, e-mail (for Access identity), role, notification settings |
| `person` | household, display name, kind (`member`, `dependant`), optional member link. Used for "belongs to" |
| `api_token` | member, hashed token, label, last used, revoked at |
| `location` | household, parent, kind (`site`, `room`, `spot`, `container`), name, notes, photo |
| `category` | parent, name, default kind, depreciation curve, default "assume consumed after" |
| `item` | household, kind (`durable`, `supply`), name, aliases, category, location, belongs_to, state, quantity, unit, min_quantity, attributes (JSONB: brand, model, size, colour, serial), private_to, last_used_at, acquired_at |
| `stock_lot` | item, quantity, expiry date, location, purchase line |
| `purchase` | household, source (`amazon_export`, `taobao`, `email`, `photo`, `csv`, `manual`), merchant, external order id, ordered at, total, currency, buyer (member), dedupe key |
| `purchase_line` | purchase, title (original), title_translated, quantity, unit price, currency, amount in EUR, external product id, url, item link, possession status (`pending`, `owned`, `gone`, `ignored`), return deadline, warranty until |
| `document` | kind (`receipt`, `manual`, `warranty`, `photo`, `import_file`, `email`), storage key, mime, sha256, links to item / purchase / capture |
| `capture` | member, channel (`web`, `shortcut`, `email`, `import`, `ios`), raw text, documents, status (`new`, `interpreted`, `applied`, `needs_review`, `rejected`, `failed`) |
| `proposed_action` | capture, type (`create_item`, `update_item`, `move_item`, `consume`, `restock`, `create_purchase`, `link_line`, `set_state`), payload, confidence, status, applied event |
| `event` | append-only: household, actor (member or `system`), type, item / purchase refs, before, after, capture ref, undone_by |
| `valuation` | item, amount in EUR, method (`depreciation`, `market`, `manual`), basis, valued at |
| `nudge` | type, target refs, payload, status (`open`, `sent`, `accepted`, `dismissed`, `snoozed`), due at |
| `stocktake` | location, member, started, finished, counts |
| `fx_rate` | date or year, currency, rate to EUR, source |
| `ai_call` | purpose, model, input and output tokens, cost in USD, capture ref, duration, outcome |
| `job` | queue tables of the job library |

Search: a generated `tsvector` column plus `pg_trgm` indexes on item name and aliases (German, English and transliterated or translated Chinese titles). No vector database in the first version.

## 6. Architecture

```
iPhone / Mac                         Cloudflare                          VPS: /opt/personal-quartermaster
┌───────────────┐                ┌──────────────────┐                  ┌───────────────────────────────────┐
│ Web app (PWA) │──HTTPS────────▶│ Access           │                  │ tunnel (cloudflared, dials out)   │
│ iOS Shortcuts │  one-time PIN  │  · e-mail allow  │──▶ Tunnel ◀──────│        │                          │
│ iOS app (M8)  │  or service    │  · service token │                  │        ▼                          │
└───────────────┘  token         └──────────────────┘                  │ app  (Node: API + web + jobs)     │
                                                                       │   │            │                  │
 Receipt mailbox ◀── IMAP poll (outbound) ─────────────────────────────│   ▼            ▼                  │
 Anthropic API   ◀── HTTPS (outbound) ─────────────────────────────────│ db (Postgres)  media volume       │
                                                                       └───────────────────────────────────┘
```

No port is published on the server. The only inbound path is the tunnel.

### 6.1 Stack

- **Language:** TypeScript everywhere on the server and web side; Swift for the native app.
- **Runtime:** Node.js 22, pnpm workspace.
- **API:** Fastify with JSON-schema validated routes; the OpenAPI document is generated from the route schemas and is the contract for the web app, the Shortcuts and the iOS app.
- **Database:** PostgreSQL 17 with `pg_trgm`; SQL migrations applied at start (a failed migration stops the start).
- **Jobs:** a Postgres-backed queue (for example pg-boss), run inside the app process. No Redis.
- **Web:** Vite, Preact with signals, service worker for installability and Web Push. Phone-first layout.
- **AI:** Anthropic API through the official SDK, behind an internal `AiProvider` interface.
- **Images:** sharp for derivatives (HEIC in, WebP out).
- **Tests:** Vitest for domain logic and API; one Playwright smoke test at phone and desktop width; model calls replaced by recorded fixtures (no live calls in CI).

### 6.2 Repository layout

```
apps/api/            Fastify app: routes, auth, static web, job runner, CLI (pnpm pq …)
apps/web/            Preact PWA
packages/core/       pure domain logic: actions, rules, dedupe, depreciation, nudges (unit tested)
packages/db/         schema, migrations, queries
packages/ai/         provider interface, prompts (versioned), schemas, cost ledger
packages/importers/  amazon-export, taobao, csv, email, each with synthetic fixtures
ios/                 SwiftUI app (M8)
shortcuts/           documentation and exported Shortcuts
deploy/              compose.yml, env.production.example, backup.sh, restore.sh, update.sh
scripts/             deploy.sh, deploy_verify.sh
docs/                user and operator documentation
```

### 6.3 Capture pipeline

1. A capture arrives (upload, Shortcut, e-mail, import file) and is stored with its documents. The request returns at once with a capture id.
2. A job classifies it (receipt, item photo, note, order mail, unknown) and extracts structured data with a schema-constrained model call. For matching, the job first fetches candidate items by search and passes only those.
3. Rules in `packages/core` turn the extraction into `proposed_action` rows with a confidence.
4. Reversible actions above the threshold apply and write events; the rest waits in the review queue.
5. After applying, the nudge rules run (duplicate, low stock, return deadline).

Synchronous exception: the *Ask* and *Used* Shortcuts wait for the result (target under 5 s) and get a one-sentence answer back.

### 6.4 API surface (v1)

| Route | Purpose |
|---|---|
| `POST /api/v1/capture` | multipart: `text`, `files[]`, `hint` (`receipt`, `item`, `used`, `note`), `location_id`; `wait=true` returns the applied result as plain text |
| `POST /api/v1/ask` | `{ "q": "do we have AA batteries?" }` → short answer plus matching items |
| `GET/POST/PATCH /api/v1/items`, `/locations`, `/categories`, `/purchases` | CRUD and bulk move |
| `POST /api/v1/items/{id}/consume`, `/restock`, `/move`, `/state` | direct actions |
| `GET /api/v1/review`, `POST /api/v1/review/{id}/accept\|reject` | review queue |
| `GET /api/v1/possession`, `POST /api/v1/possession/{line}/…` | possession check |
| `POST /api/v1/imports` | upload an import file, returns a job |
| `GET /api/v1/reports/spending`, `/contents`, `/coverage` | reports |
| `GET /api/v1/shopping-list`, `/nudges`, `/events` | lists and feed |
| `POST /api/v1/events/{id}/undo` | undo |
| `GET /api/v1/export` | full export |
| `GET /healthz` | `{ ok: true }` when the database answers and the media volume is writable with more than 10 % free; no details |

### 6.5 Authentication

Two layers, both required:

1. **Cloudflare Access** in front of the hostname. People log in with a one-time PIN sent to an allow-listed e-mail address. Devices that cannot do an interactive login (Shortcuts, the iOS app, scripts) send a service token in the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers; the Access application has a *Service Auth* policy for those tokens.
2. **The app** verifies the `Cf-Access-Jwt-Assertion` header on every request against the team's signing keys and the application audience, and refuses requests without a valid one. Browser sessions map the e-mail in the token to a `member`. Service-token requests carry no person, so they must also send `Authorization: Bearer <per-member API token>`.

A `DEV_AUTH=1` bypass exists for local development only and refuses to work when `NODE_ENV=production`.

### 6.6 iOS Shortcuts (before the native app)

| Shortcut | Input | Call |
|---|---|---|
| **QM Used** | Dictate Text | `POST /capture` with `hint=used`, `wait=true`; shows or speaks the reply ("AA batteries: 6 left") |
| **QM Ask** | Dictate Text | `POST /ask`; speaks the answer |
| **QM Receipt** | Take Photo | `POST /capture` with `hint=receipt` |
| **QM Add** | Share sheet or camera, optional location menu | `POST /capture` with `hint=item` |

Dictation runs on the phone, so the server receives text. Each phone stores one service token and the member's API token inside its Shortcuts.

### 6.7 Native iOS app (M8)

SwiftUI client of the same API, generated from the OpenAPI document. Adds what Shortcuts cannot do well: camera flow with several items per photo, barcode scan, offline capture queue, push notifications, Siri and widgets through App Intents, share extension, stocktake mode with large tap targets. Tokens live in the Keychain. Push notifications and TestFlight need a paid Apple Developer account.

### 6.8 Importers

- **Amazon:** the account's privacy data request delivers a ZIP whose `Retail.OrderHistory.*` folder holds a CSV with every order. The importer accepts the ZIP or the CSV, finds the file by pattern (the numeric suffix varies), and is idempotent on order id plus product id. Returns files in the same export close the matching lines when present.
- **Taobao:** no official export is known. Candidates: saved order-list pages (HTML), screenshots read by the model, or a CSV from a browser tool. The importer's internal format is fixed first; the input adapter follows the owner's decision. Titles are stored in the original and translated; amounts in CNY.
- **E-mail:** the app polls a **dedicated receipt mailbox** over IMAP. The owner forwards shop mail to it by rule, so the server never has access to a personal mailbox. Historical mail can be imported as `.eml` or mbox files.
- **Generic CSV:** column mapping saved per source.

All importers produce purchases and lines only. Items come from the possession check and its auto-rules.

### 6.9 AI layer

- One interface, `AiProvider`, with purposes: `classify_capture`, `extract_receipt`, `extract_items_from_photo`, `interpret_note`, `answer_question`, `translate_titles`, `estimate_value`, `write_digest`.
- Models are set per purpose by environment variable, with a small fast model for extraction and a stronger one for reasoning. Check the current model ids in the Anthropic documentation when wiring this up.
- `answer_question` uses tool calls against read-only search functions instead of receiving inventory data up front.
- Prompts are files with a version; the version is stored on each `ai_call`.
- `AI_BUDGET_USD_MONTH` stops background jobs when reached; interactive calls continue and the owner is told.

### 6.10 Notifications

`Notifier` interface with three channels: SMTP e-mail (weekly digest), Web Push (real-time nudges on phones that installed the PWA), APNs (with the native app). Nudge budget rules (E8) sit in front of all channels.

### 6.11 Media

Originals and derivatives live in a Docker volume, addressed by content hash. Images are downscaled on upload (longest side 2,000 px) with a thumbnail; receipt originals are kept. Clients downscale photos before upload; uploads above 25 MB are refused (Cloudflare also caps request bodies).

## 7. Deployment

### 7.1 Server facts

- One existing VPS: 2 vCores (x86), 4 GB RAM, 80 GB SSD, Debian 13, Docker Compose. **It is shared with several other stacks.**
- SSH as the non-root user `deploy` with a key and `-o BatchMode=yes`. Root login is disabled. fail2ban bans an address for one hour after five failed logins, so never retry SSH in a loop.
- The domain is on Cloudflare and a Zero Trust team already exists. Other stacks have their own tunnels and Access applications.
- The real host address and URL live only in the local, gitignored `deploy.env`.

### 7.2 Stack

Own Compose project **`personal-quartermaster`** in **`/opt/personal-quartermaster`**, own private network, own tunnel.

> A different stack named `quartermaster` already runs in `/opt/quartermaster`. It is unrelated. Never touch it, its tunnel, or any other stack, Caddyfile, port or volume on the server.

| Service | Image | Notes | Memory limit |
|---|---|---|---|
| `app` | `ghcr.io/thorbieshappyprojects/personal-quartermaster:${APP_TAG:-latest}` | API, static web app and job runner in one process; `env_file: .env`; volume `media`; health check on `/healthz`; non-root, read-only root filesystem with tmpfs | 640 MB |
| `db` | `postgres:17` | volume `pgdata`; `pg_isready` health check; **no published port**; `shared_buffers` 128 MB | 512 MB |
| `tunnel` | `cloudflare/cloudflared` (pinned version) | `tunnel --no-autoupdate run`; token from `.env`; forwards to `http://app:3000` | 128 MB |
| `jobs` | same image, profile `jobs` | one-off commands: `docker compose run --rm jobs pnpm pq …` | 640 MB |

All services: `restart: unless-stopped`, `cap_drop: [ALL]`, `no-new-privileges`, `json-file` logs with `max-size: 10m` and `max-file: 5`. The stack must stay under about 1.3 GB in total; measure and report real use in M0.

The image is built by GitHub Actions and pulled by the server. Nothing is built on the server. The image contains no secrets and no data.

### 7.3 Cloudflare (owner, in the dashboard)

1. Create a tunnel named `personal-quartermaster` (Docker); copy only the token.
2. Add a published application route: hostname `<subdomain>.<your-domain>` → `http://app:3000`.
3. Create a self-hosted Access application for that hostname: session 24 hours, login method one-time PIN, policy *Allow* → *Emails* → the household members.
4. Create one service token per device and add a *Service Auth* policy that includes those tokens.
5. Put the team domain and the application audience tag into the server's `.env`.

`deploy_verify.sh` must show: without login the hostname answers 302 to the Access login; with a service token and API token `/healthz` answers 200; no published ports for this project; `.env` mode 600.

### 7.4 Secrets

- Secrets never pass through a chat, the repo, shell history or CI logs.
- The owner writes the tunnel token and API keys into `/opt/personal-quartermaster/.env` on the server (`umask 077`).
- `deploy/env.production.example` lists every variable with a comment and no values: `TUNNEL_TOKEN`, `DATABASE_URL`, `POSTGRES_PASSWORD`, `ANTHROPIC_API_KEY`, `AI_BUDGET_USD_MONTH`, `AI_MODEL_EXTRACT`, `AI_MODEL_REASON`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD`, `SMTP_*`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `BACKUP_AGE_RECIPIENT`, `BACKUP_REMOTE`.

### 7.5 Operations

- `scripts/deploy.sh [--dry-run]`: checks, copies `deploy/` files, runs `update.sh` on the server.
- `deploy/update.sh`: backup, pull, restart, wait until healthy, print the running commit; if the new version does not get healthy, start the previous tag again.
- `deploy/backup.sh` (nightly cron): `pg_dump --format=custom` plus the media volume into `/var/backups/personal-quartermaster/`; keep 7 daily and 4 weekly; optional encrypted off-server copy with `age`.
- `deploy/restore.sh`: restores into a **new** database and prints row counts; never overwrites the running one. Test a restore after the first backup.
- Claude Code shows every command that changes the server before the first run of its kind, and asks before deleting volumes or restoring over data.

### 7.6 CI

`ci.yml`: lint → typecheck → unit and API tests (Postgres service container) → build → Playwright smoke. `image.yml`: build and push the image on `main` with tags `latest` and the commit hash. A check fails the build if a fixture or the image contains anything matching e-mail addresses, IBANs or the owner's domain.

## 8. Milestones

| M | Scope | Done when |
|---|---|---|
| **M0 Skeleton** | Workspace, CI, image, Compose stack, migrations, `/healthz`, Access JWT check, members (G1), backup and restore scripts | The empty app runs locally in Compose; memory measured; after the owner's go, it answers behind Access on the server and `deploy_verify.sh` passes |
| **M1 Inventory** | A1–A6, H1, H3: items, locations, categories, search, "do we have X?" without AI, export | An item can be added, found and moved from a phone in the PWA; export round-trips |
| **M2 History** | B1–B8: Amazon import, Taobao import, CSV, possession check, FX, spending overview, coverage | The full Amazon export imports twice without duplicates; the 50 most expensive lines can be triaged in under 10 minutes; spending by year and category is shown |
| **M3 Capture** | C1–C7, A8, G2: inbox, receipt photos, notes, item and clothes photos, review queue, undo, Shortcuts, `ask` with the model | The four Shortcuts work from the lock screen; "QM Used" takes under 10 seconds end to end; every applied action can be undone |
| **M4 Receipts and nudges** | B9, B10, E1, E2, E8, H2, G4: mailbox polling, dedupe, duplicate warning, weekly digest, Web Push | A forwarded order mail creates one purchase (no duplicate with the export) and, if the item is owned, a push within 5 minutes |
| **M5 Supplies** | D1–D7: stock, minimums, lots, expiry, shopping list, stocktake, shelf photo | A stocktake of one shelf takes under 2 minutes; the shopping list fills itself |
| **M6 Advice** | E3–E7, A9, C8: check-ins, sell and use suggestions, storage advisor, reminders, room walkthrough | The digest contains suggestions the owner accepts or dismisses; dismissed ones do not come back |
| **M7 Value and household** | F1–F4, A7, G3: valuation, contents report, listing drafts, private items, activity feed | The contents report exports as PDF and CSV with totals per site |
| **M8 iOS app** | H4, C9 | The app covers capture, ask, stocktake and push on the owner's phone |
| **Later** | D8 fresh food and recipes, H5 Home Assistant | |

## 9. Open decisions for the owner

1. **Hostname** for the app.
2. **Receipt mailbox:** which address, and which shop mails are forwarded to it.
3. **Taobao input:** saved pages, screenshots or a CSV tool.
4. **Members at the start** and whether new items are shared by default (assumed: yes, with a private flag).
5. **Notification channel before the iOS app:** Web Push plus e-mail (assumed) or e-mail only.
6. **AI budget per month** and the two default models.
7. **Off-server backup target.**
8. **Interface language** (assumed: English; item names stay as on the receipt, with a translation where needed).
9. **Licence** of the public repository.
10. **Apple Developer account** for M8.
11. **"Assume consumed" ages** per supply category and the "unused since" threshold for sell suggestions (assumed: 12 months for supplies, 18 months for durables).

## 10. Risks

| Risk | Mitigation |
|---|---|
| Upkeep effort kills the inventory | Imports and receipts first, manual entry last; stocktake and check-ins repair drift; coverage meter instead of a completeness promise |
| Imported history floods the inventory with things long gone | Possession check with `unknown` default and auto-rules |
| Wrong extraction from receipts or photos | Schema validation, confidence threshold, review queue, undo |
| Personal data leaks through the public repo | Non-negotiables in section 3, CI check, synthetic fixtures |
| The shared server runs out of memory or disk | Memory limits per service, disk check in `/healthz`, image derivatives, measured budget in M0 |
| Receipts and photos pass through Cloudflare and the model provider | Accepted by the owner; only the capture and matching candidates are sent to the model |
| Nudges become nagging | Nudge budget, snooze, "never ask again" |
