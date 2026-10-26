# Sophie: grounded voice sales demo

Sophie uses the existing Realtime voice model with a modular behavioral prompt.
`assignment.md` is the source for the canonical community cards and room layouts.
Availability and community responses omit mock markers. Callbacks save pending requests without scheduling a call.
The prompt describes how to converse and when to use tools; it does not duplicate
the pricing table or full amenities list.

## Community facts and appointments

The community information tool returns one card: pricing, amenities, care,
payments, policies, contact, or careers. `notProvided` is distinct from false.
Unknown fields stay internal unless the visitor specifically asks for that detail.
When that happens, Sophie briefly acknowledges the gap and immediately offers a
team-member callback using the existing pending-request flow. Tool names and API
mechanics are not spoken. Live transfer is not implemented or promised.
Starting monthly prices are $2,000 Independent Living and $3,000 Assisted Living;
the entrance fee is $3,500. Layouts are Studio, 1 Bedroom / 1 Bath, and
2 Bedroom / 1.5 Bath. Studio bathrooms, room sizes, room prices, and inventory
counts are unknown.

HUD and Medicaid participation are stated without promising eligibility or
claiming Section 8 participation. Kosher meals, individual thermostats, memory
care, speech therapy, and lease-term units remain unknown. Skilled nursing is
listed as provided but does not establish memory care or clinical suitability.
The assignment's address spelling and careers URL are preserved verbatim.

Tours use the explicitly configured `appConfig/appointments` Firestore slots,
interpreted in America/New_York, with thirty-minute durations. The admin page
edits a JSON array of date/time objects; the service returns future slots in
chronological order without generating business hours or asking for a date first.
The first substantive inquiry, including tours, attempts the sales-director lookup.
Community, floor-plan, and appointment tools remain gated until that attempt
finishes, including failure. Then appointment options are retrieved immediately.
Configured slots may include Sundays. Selected slots are
revalidated transactionally when a pending request is saved and do not reserve
inventory.

If a successful lookup is empty, or none of the offered options suit the visitor,
Sophie offers an optional callback rather than transferring or automatically ending.
Callbacks require a confirmed saved phone number; email alone remains sufficient
for a tour request. The visitor may decline and continue asking questions.
Callback preparation takes only `{kind: "callback"}` and reads back the arrangement:
a sales representative will call as soon as one is available during normal operating
hours. Sophie never asks for or offers callback dates, times, or deadlines, and does
not invent operating hours. A volunteered time is not recorded as an agreed schedule;
she checks whether the standard arrangement works instead.

Only after separate request confirmation and a successful write does Sophie say the
callback request is saved and explain the arrangement. This demo does not place calls
or notify staff. Lookup failures remain errors rather than empty availability.
The normal explicit-stop and natural-ending flows remain available throughout.

## Session memory and action confirmation

The socket backend prefetches a profile after Firebase authentication, with a
two-second deadline and bounded short-lived cache. A saved first name
appears in the first greeting. Otherwise the greeting is generic; a late response
does not trigger another greeting. Recognition requires the same persisted
Firebase visitor identity, not merely the same physical visitor or device.

Contact collection collects missing fields separately without a permission-to-remember gate.
Preparation returns exact values and an opaque read-back token; saving is available throughout the session but execution is blocked until a later user speech turn. Corrected values require a new token and another
confirmation. Tokens expire after five minutes. All writes require confirmation,
are serialized, and use stable idempotency keys. The model still interprets spoken
assent; token/phase validation is not a proof that an utterance semantically meant
"yes." Ordinary tests and manual voice checks cover this limitation; prompt
engineering cannot guarantee zero hallucinations.

The root `sessions/{uid}` document stores `contact.profile` and
`contact.updatedAt`, merged without replacing call metadata. Pending tour/callback
requests live in `followUpRequests`; private retry receipts live in `toolWrites`.
The model never supplies a UID or path: the trusted, authenticated socket backend
injects identity. IAM-private Cloud Functions perform writes, and Firestore rules
allow only owner reads of profiles/requests and deny direct client writes.

Cancelled work produces no subsequent acknowledgment. An already committed write
can remain, so retries reuse the same token/receipt. Tool errors are not treated
as proof of unavailability or proof that an uncertain write did not commit.

## Reviewed prompt publication and closing

The canonical six-section prompt is `apps/socket-server/src/ai/sophie-prompt.ts`.
Existing Firestore prompts are never overwritten by startup. Review the current
revision in `/admin`, then explicitly publish the full reviewed prompt:

```sh
node tools/publish-sophie-prompt.mjs --project <project-id> --expected-revision <current-revision>
```

The transaction refuses stale revisions and is idempotent when content matches.
For an emulator, explicitly set `FIRESTORE_EMULATOR_HOST` and use a demo project.
New calls load the published prompt.

Foreground tool descriptions require a brief courtesy notice, followed immediately
by invocation without awaiting a visitor reply. Background profile prefetch is exempt.
A successful empty appointment lookup offers an optional callback; lookup errors
remain errors. A bounded extra terminal execution for call ending remains available
after the four normal tool executions per turn.

`end_call` handles explicit visitor stops immediately, without courtesy or goodbye,
clearing capture and playback before saving. Natural completion follows the final
anything-else question and a negative answer, then plays a server-owned localized
goodbye before saving (15-second fallback). Saved end reasons are
`visitor_requested` and `conversation_complete`. Existing contact/new-turn
confirmation and same-token uncertain-write recovery remain required.
