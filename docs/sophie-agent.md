# Sophie: grounded voice sales demo

Sophie uses the existing Realtime voice model with a modular behavioral prompt.
`assignment.md` is the source for the canonical community cards and room layouts.
Availability and community responses omit mock markers. The appointment sales-handoff explicitly announces that it is a demo simulation.
The prompt describes how to converse and when to use tools; it does not duplicate
the pricing table or full amenities list. There is no model fine-tuning, preview
product, production monitoring, or extra validation agent in this iteration.

## Facts and deliberate departures from the assignment

The community information tool returns one card: pricing, amenities, care,
payments, policies, contact, or careers. `notProvided` is distinct from false.
Unknown fields stay internal unless the visitor specifically asks for that detail.
When that happens, Sophie briefly acknowledges the gap and immediately offers a
team-member callback using the existing pending-request flow. Tool names and API
mechanics are not spoken. Live transfer is not implemented or promised.
Starting monthly prices are $2,000 Independent Living and $3,000 Assisted Living;
the entrance fee is $3,500. Layouts are Studio, 1 Bedroom / 1 Bath, and
2 Bedroom / 1.5 Bath. Studio bathrooms, room sizes, room prices, and inventory
counts are unknown. The fixture no longer invents them.

HUD and Medicaid participation are stated without promising eligibility or
claiming Section 8 participation. Kosher meals, individual thermostats, memory
care, speech therapy, and lease-term units remain unknown. Skilled nursing is
listed as provided but does not establish memory care or clinical suitability.
The assignment's address spelling and careers URL are preserved verbatim.

Tours use the explicitly configured `appConfig/appointments` Firestore slots,
interpreted in America/New_York, with thirty-minute durations. The admin page
edits a JSON array of date/time objects; the service returns future slots in
chronological order without generating business hours or asking for a date first.
Appointment inquiries skip the sales-director lookup. Other substantive inquiries
retain that lookup through the prompt; the unconditional forced tool choice is
removed so appointments can be retrieved immediately. Selected slots are
revalidated transactionally when a pending request is saved and do not reserve
inventory.

If a successful lookup is empty, or the visitor explicitly cannot attend any
option, Sophie calls `simulate_sales_handoff`. The server supplies a fixed
English/Spanish disclosure identifying the simulation, stops microphone capture,
and finishes the call after closing playback is acknowledged (15-second fallback).
No actual transfer or callback happens. The recording and transcript are saved
with `endReason: demo_sales_handoff`. Lookup failures offer retry instead of being
treated as empty schedules. The greeting and recording disclosure still occur
once per call and survive Pause/Resume.

## Session memory and action confirmation

The socket backend prefetches a profile after Firebase authentication, with a
two-second deadline and bounded short-lived cache. A saved first name
appears in the first greeting. Otherwise the greeting is generic; a late response
does not trigger another greeting. Recognition requires the same persisted
persisted Firebase visitor identity, not merely the same physical visitor or device.

Contact collection collects missing fields separately without a permission-to-remember gate.
Preparation returns exact values and an opaque read-back token; saving is available throughout the session but execution is blocked until a later user speech turn. Corrected values require a new token and another
confirmation. Tokens expire after five minutes. All writes require confirmation,
are serialized, and use stable idempotency keys. The model still interprets spoken
assent; token/phase validation is not a proof that an utterance semantically meant
"yes." Ordinary tests and manual voice checks cover this limitation; prompt
engineering cannot guarantee zero hallucinations.

The root `sessions/{uid}` document gains `contact.profile` and
`contact.updatedAt`, merged without replacing call metadata. Legacy consent fields are ignored and need no migration. Pending tour/callback
requests live in `followUpRequests`; private retry receipts live in `toolWrites`.
The model never supplies a UID or path: the trusted, authenticated socket backend
injects identity. IAM-private Cloud Functions perform writes, and Firestore rules
allow only owner reads of profiles/requests and deny direct client writes.

Cancelled work produces no subsequent acknowledgment. An already committed write
can remain, so retries reuse the same token/receipt. Tool errors are not treated
as proof of unavailability or proof that an uncertain write did not commit.

## Release

Builds, unit tests, emulator smoke, and browser fixtures need no live OpenAI key.
Emulators validate contracts and owner isolation but do not prove deployed IAM.
Production identifiers and the personal Makefile remain gitignored.

The private profile functions use the default Functions runtime identity. The
local production configuration now enables `FUNCTIONS_FIRESTORE_ACCESS=true`:
`make terraform-plan` should show its intentional Firestore role grant. Review
that plan before `make terraform-apply`; no apply is part of this implementation.
If using a custom Functions service account, target that identity instead.

After the runtime permission is provisioned, run `make deploy-functions`, then
`make deploy-websocket`. The local Makefile grants the socket identity invocation
access to all private functions. No static-site deployment is needed.

Manual voice checks: greeting and disclosure once; first director lookup waits;
room-specific pricing stays unknown; Sunday tours rejected; kosher/thermostat/
dementia/large-dog questions retain qualifications; contact spelling and digits
confirmed before saves; corrections, interruptions and failures do not claim
success; a returning identity gets a first-name greeting; tour/callback success
is described only as a pending request.
