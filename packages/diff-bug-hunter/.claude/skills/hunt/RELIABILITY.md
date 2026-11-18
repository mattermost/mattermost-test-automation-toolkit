# Mattermost reliability invariants

Diff-triggered invariants for `/hunt` Mode A. `scripts/reliability.py` reads this file from the trusted base ref and
injects a rule only when a changed file matches one of its `paths` globs or a changed line matches its `diff` regex.
Hunters must still back every invariant they test with at least 3 caller citations.

Format per rule: `## Rnn Title`, then `paths:` (comma-separated globs, or `-` for diff-only rules), `diff:` (one regex, case-insensitive, matched
against added and removed lines), `invariant:` and `probe:` (one line each).

## R01 Guest account isolation
paths: server/channels/app/*guest*, server/channels/app/user*.go, server/channels/api4/user*.go, server/channels/app/team*.go
diff: IsGuest\(|SystemGuestRoleId|GuestAccountsSettings|ChannelGuestRoleId|TeamGuestRoleId|\bguest
invariant: A guest sees, mentions, searches and DMs only users and channels they share a channel with; no endpoint (profiles, autocomplete, search, counts, websocket) leaks other users or channels to a guest.
probe: Create a guest in one channel and a regular user elsewhere in the same team; call the changed code path as the guest and assert the other user/channel is absent (not merely sanitized).

## R02 Cross-team and private channel boundaries
paths: server/channels/api4/channel*.go, server/channels/api4/team*.go, server/channels/app/channel*.go, server/channels/app/team*.go, server/channels/app/search*.go
diff: SessionHasPermissionTo(Channel|Team)|PermissionReadChannel|ChannelTypePrivate|GetChannelsForTeamForUser|\bTeamId\b|IsTeamMember|GetChannelMember
invariant: A user who is not a member of a team or private channel can neither read nor infer its content (posts, members, names, counts) through any endpoint; ids from another team in a request are refused with 403/404, never used silently.
probe: Pass a channel or team id the session user does not belong to (private channel, other team, archived channel) to the changed handler; assert 403/404 and no data in the body.

## R03 ClientConfig hash compatibility
paths: server/config/client.go, server/channels/app/platform/config.go, server/channels/web/handlers.go
diff: ClientConfig|ClientConfigHash|regenerateClientConfig|GenerateClientConfig|GenerateLimitedClientConfig|X-Version-Id
invariant: The client config hash changes if and only if a client-visible value changes; per-node fields are excluded; the limited (logged-out) config never exposes a field that only the full config may carry.
probe: Toggle each changed setting and a per-node setting; compare hashes and both config maps (prime the cache with one real config change after Setup(t) first).

## R04 WebSocket payload safety
paths: server/channels/app/platform/web_*.go, server/channels/app/platform/websocket_*.go, server/public/model/websocket_message.go, server/channels/wsapi/*.go
diff: NewWebSocketEvent|WebSocketEvent|Broadcast|BroadcastHook|SanitizeInput|Publish\(|ReliableClusterSend
invariant: An event reaches only connections whose user may see it (channel/team membership, guest rules) and its payload carries no field the receiver may not read (emails, auth data, other users' private props).
probe: Register web connections for a member, a non-member and a guest; trigger the changed event and assert who received it and that sanitized fields are blank for each receiver.

## R05 Mention, HTML and NULL sanitization
paths: server/public/model/post.go, server/channels/app/post*.go, server/channels/app/notification*.go, server/channels/app/mention*.go, webapp/channels/src/utils/text_formatting*, webapp/channels/src/utils/markdown/*
diff: mention|@channel|@here|@all|\\x00|\\u0000|(?-i:\bNUL\b)|sanitiz|escape|dangerouslySetInnerHTML|innerHTML|SanitizeUnicode
invariant: Text with NUL bytes is rejected or stripped before storage; escaped, backslashed or code-fenced mentions never notify; rendered output never executes or injects user-supplied HTML.
probe: Property-test the changed function with random text mixing `@channel`/`@here`, `\_`, backslashes, code fences, NUL and `<script>`; assert notification sets and rendered output against a reference.

## R06 Store transaction atomicity
paths: server/channels/store/sqlstore/*.go, server/channels/store/localcachelayer/*.go
diff: \.Begin(x)?\(|Commit\(|Rollback\(|finalizeTransaction|\btx\.|transaction
invariant: A multi-row write either fully applies or leaves no trace; every Begin is finalized on every error path; caches are invalidated only after commit.
probe: Make the second write fail (duplicate key, closed tx, cancelled context) and assert the first write is absent and the cached value still matches the database.

## R07 Migration safety
paths: server/channels/db/migrations/**, server/channels/store/sqlstore/upgrade*.go, server/channels/app/migrations*.go
diff: ALTER TABLE|CREATE (UNIQUE )?INDEX|DROP (TABLE|COLUMN|INDEX)|NOT NULL|migration
invariant: Up and down migrations are idempotent and reversible; a new NOT NULL column has a default; Postgres indexes on large tables are created CONCURRENTLY; data migrations can resume after interruption.
probe: Run the migration twice, run down then up, and run it against a table holding pre-existing rows; assert schema and data match after each run.

## R08 Concurrency under -race
paths: -
diff: go func|sync\.|atomic\.|Mutex|RWMutex|\bchan\b|\.Store\(|\.Load\(|errgroup
invariant: Shared state touched by more than one goroutine is synchronized; no goroutine outlives Stop/Close; concurrent callers of the changed API see consistent results under `go test -race`.
probe: Drive the changed API from several goroutines with a seeded interleaving plus a concurrent shutdown; run with -race and assert final state and no leaked goroutines.

## R09 React async form error recovery
paths: -
diff: async |await |\.then\(|\.catch\(|isSubmitting|setSaving|saving|serverError|onSubmit|handleSubmit
invariant: After a failed request the form shows the server error, re-enables submit and keeps the user's input; a pending request blocks double submit; nothing updates state after unmount.
probe: Mock the Client4/action call to reject, then resolve; assert error text, enabled submit, preserved input, single call on double click, and no act() warning after unmount.

## R10 Redux selector memoization
paths: webapp/channels/src/selectors/**, webapp/channels/src/packages/mattermost-redux/src/selectors/**
diff: createSelector|makeGet|useSelector|reselect|createIdsSelector|memoize
invariant: A selector returns the same reference while its inputs are unchanged and a new value when they change; factory selectors (makeGet*) are created per component instance.
probe: Call the changed selector twice on identical state and once on state with an unrelated slice changed (expect identical references), then change a real input (expect a new value).
