# Tracework Phase 6C1: Authentication Architecture & Authenticated Principal Contract

Status: planning/audit only; uncommitted for review
Date: 2026-08-13
Checkpoint: cc6c833 / Phase 6B formally closed
Live database contract: POST_6B2C

This document freezes the identity and request-principal architecture needed
before authentication implementation. It does not install an Auth package,
create users, change Supabase Auth settings, change the database, add RLS
policies, modify RPCs or routes, call a provider, or change the application.

Required boundary for this phase:

~~~
Supabase mutations:      0
Auth users created:      0
Auth settings changed:   0
RLS changes:             0
Production changes:      0
Provider calls:          0
~~~

## Executive decisions

| Decision | Phase 6C1 contract |
| --- | --- |
| Runtime shape | React/Vite SPA plus stateless API handlers; no SSR request/session layer |
| Browser Auth client | @supabase/supabase-js with a public/publishable key |
| API transport | Authorization: Bearer <Supabase access token> on each authenticated API request |
| Server Auth package | @supabase/server, using its authenticated request context for header-based requests |
| Server validation | Package-verified user context; never an unverified JWT decode; getSession() is not a server authorization primitive |
| Principal root | Verified Supabase Auth subject, user.id / JWT sub supplied by the verified context |
| Database user path | Caller-scoped Supabase client so later RLS sees the caller; privileged client only for explicit system operations |
| First sign-in surface | Email plus password, email confirmation, sign in, local-session sign out, password reset |
| Signup bootstrap | Create the Auth identity only; no automatic workspace and no public/moderator/admin rights |
| Anonymous mode | Explicit local/bundled demo surface only; no generic user library, writes, or unrestricted provider-cost routes |
| Profile table | None for 6C; auth.users is sufficient for identity and account UX |

The server package choice is a design freeze, not an implementation claim. The
first implementation task must pin and verify the current package API against
the Vercel handler shape before changing package.json.

## 1. Actual Tracework runtime audit

### 1.1 Runtime classification

Tracework is currently:

~~~
React 19 + Vite 7 + TypeScript browser SPA
        |
        +-- browser-local index in localStorage
        |
        +-- same-origin POST /api/* calls
                    |
                    +-- Vercel serverless handlers in api/* (deployment)
                    |
                    +-- Vite middleware in vite.config.ts (local development)
~~~

It is not SSR and does not currently use a hybrid cookie/session framework.
index.html loads src/main.tsx; src/main.tsx renders App directly with React
createRoot. There is no server-rendered document, server router, or
server-owned browser session in the repository.

### 1.2 Relevant entry points and responsibilities

| Area | Current evidence and behavior |
| --- | --- |
| Browser entry | index.html -> src/main.tsx -> src/App.tsx |
| Local persistence | src/App.tsx stores the local tracework.documents.v1 index in window.localStorage; the initial sample corpus is local/demo data |
| Browser API wrappers | src/lib/vectorDb.ts, src/lib/knowledgeLibrary.ts, src/lib/semantic.ts, and src/lib/generation.ts use same-origin fetch with JSON bodies and no Auth header |
| Production API entry points | api/embed.ts, api/generate.ts, api/library/collections.ts, api/library/documents.ts, api/vector/search.ts, api/vector/sync.ts, and api/vector/delete.ts export handlers from server/traceworkApi.ts |
| Local API implementation | vite.config.ts installs Vite middleware for the same /api/* contracts; it delegates generation to the shared server handler and implements the embedding/vector/library middleware |
| Deployment target | The repository documents the api/* files as Vercel serverless functions. No vercel.json or alternate deployment adapter is present in the repository. |
| Database transport | Current server code sends REST RPC POST requests to SUPABASE_URL/rest/v1/rpc/... using SUPABASE_SERVICE_ROLE_KEY as both apikey and bearer credential |
| Browser Supabase client | None. There is no createClient, @supabase/supabase-js, @supabase/ssr, or @supabase/server dependency or browser Auth module. |
| Server Supabase client | None as an SDK client; current code uses direct fetch with the service-role key |
| Environment variables | .env.example contains server-only SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, OpenAI secrets/models, and the shared-write gate. There is no browser VITE_SUPABASE_* configuration. Values in .env.local were not printed or changed. |
| Database state | Phase 6B closeout independently verified the Tracework database as POST_6B2C; this phase does not re-query or mutate it. |

The existing Vite plugin reads .env.local through loadEnv for local middleware,
while deployed handlers read process.env. That split must remain explicit during
implementation; an Auth client must not accidentally receive a server-only
secret through Vite environment exposure.

### 1.3 Current identity and security audit

There is currently no authenticated principal. No request header, cookie,
request body field, query parameter, or server context identifies a caller.
The current server database bridge therefore has this shape:

~~~
anonymous browser request
        |
        v
Tracework API handler
        |
        +-- service-role key for Supabase RPC
        |
        +-- OpenAI key for /api/embed or /api/generate
~~~

The current code does not trust a client userId; it has no user identity at
all. That is still not an authorization model: every Supabase database call
made by a route is privileged because it uses the service role.

The current TRACEWORK_ALLOW_SHARED_WRITES setting is only a deployment gate.
Deployed sync/delete handlers refuse unless it is exactly true; local Vite
middleware allows writes unless it is exactly false. This reduces accidental
anonymous shared writes but does not identify, authenticate, or authorize a
person. It must not be promoted into the Phase 6C principal contract.

The current public behavior is therefore an anonymous demo/compatibility
surface, not an authenticated application:

- browser-local hashed, lexical, and local state can work without credentials;
- the browser can request the shared library catalog and documents through the
  current unauthenticated API routes;
- pgvector search uses the server service-role bridge;
- sync/delete are deployment-gated but have no caller identity when enabled;
- /api/embed and /api/generate can consume provider budget on an enabled
  deployment without a user principal;
- the browser can add pasted notes and files to its local index without making
  them database-owned records.

Phase 6C must make the distinction intentional rather than allowing these
behaviors to remain anonymous by accident.

## 2. Current official Supabase guidance used for this design

The official Supabase documentation was reviewed on 2026-08-13. The links
below are implementation-sensitive references and should be rechecked during
6C2 because package APIs and key terminology are changing.

### 2.1 Package selection

Supabase's current package-selection guidance maps the transport to the
package:

- header-delivered Authorization: Bearer <jwt> -> @supabase/server;
- cookie-backed sessions in an SSR framework -> @supabase/ssr;
- browser/base client behavior -> @supabase/supabase-js.

The same guide describes @supabase/server as providing an authenticated
request context, a caller-scoped client that respects RLS, and a separate admin
client for privileged operations. It lists framework APIs and Vercel among its
server runtimes. See [Which package to use](https://supabase.com/docs/guides/auth/choosing-a-server-package).

@supabase/server is a relatively new/public-beta package in the current
guidance. 6C2 must pin an exact version and verify its Vercel adapter/context
API before adding it. The architecture does not fall back to trusting decoded
JWT text if that compatibility spike fails.

### 2.2 Token validation and identity

Supabase documents auth.getUser(jwt) as a network-validated operation whose
returned user is authentic and suitable for authorization decisions. It
documents auth.getClaims(jwt) as verification of JWT claims against the JWKS
endpoint when the signing setup permits that path, with a network verification
fallback for symmetric signing keys. See [getUser](https://supabase.com/docs/reference/javascript/auth-getuser) and [getClaims](https://supabase.com/docs/reference/javascript/auth-getclaims).

For Tracework, @supabase/server's authenticated request context is the
primary resolver. It performs the package-level verification and exposes the
verified identity/claims to the handler. Tracework will not manually decode a
JWT and trust its sub.

If a later route needs a current canonical Auth user record rather than only
the verified subject, it may explicitly call auth.getUser(accessToken) as a
user-record lookup. That is not required as a second validation call on every
route. getSession() may restore a browser-owned session for UI state, but its
stored values are not a server authorization proof; the server must validate
the request token through the selected server mechanism.

### 2.3 Keys and RLS

Supabase's current API-key guidance distinguishes application keys from user
identity: a publishable key identifies a public application component, while a
user JWT identifies the authenticated user. Publishable keys are safe to ship
in browser code; secret keys are backend-only and bypass RLS. The same guidance
states that the legacy anon and service_role names are being superseded by
publishable and secret keys. See [Understanding API keys](https://supabase.com/docs/guides/getting-started/api-keys).

Tracework therefore adopts this future naming:

~~~
Browser application:  SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY
Caller-scoped API:    publishable key + validated user access token
Admin/system path:    SUPABASE_SECRET_KEY (or temporary legacy service role)
~~~

No key rotation or environment change is part of 6C1. The current
SUPABASE_SERVICE_ROLE_KEY is documented as a legacy/temporary compatibility
credential until normal user routes are moved off it.

Supabase RLS uses the authenticated Postgres role and helpers such as
auth.uid() to connect database policy to the JWT identity. Supabase also warns
not to use user-editable raw_user_meta_data as authorization truth;
authorization data belongs in database relations or controlled app metadata.
See [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security).
RLS policy implementation remains Phase 6D.

### 2.4 Session and password flows

The current guidance documents onAuthStateChange events including initial
session restoration, sign-in, sign-out, token refresh, user updates, and
password recovery. It also documents email/password signup, password sign-in,
email confirmation redirects, reset-password redirects, and SMTP requirements.
See [onAuthStateChange](https://supabase.com/docs/reference/javascript/auth-onauthstatechange) and [Password-based Auth](https://supabase.com/docs/guides/auth/passwords).

For browser sign-out, current documentation notes that the default scope is
global and recommends signOut({ scope: 'local' }) when only the current
session should be removed. Tracework's first implementation adopts explicit
local sign-out for normal account UX, with a separate deliberate global-signout
action deferred. See [signOut](https://supabase.com/docs/reference/javascript/auth-signout).

## 3. Auth transport decision

### 3.1 Compared models

| Model | Fit for current Tracework | Main concern |
| --- | --- | --- |
| A. Browser Supabase session + bearer token per API request | Strong fit: the UI is a client-rendered SPA, API handlers already receive independent requests, and the current browser wrappers already centralize fetch calls | Browser XSS would be able to use a session available to that browser; standard CSP/input/output protections remain required. The server must validate every token. |
| B. Cookie-based session with @supabase/ssr | Poor fit now: no SSR framework, no server-rendered route tree, and no server-owned HTML/session lifecycle | Adds cookie refresh/response plumbing and CSRF/origin considerations without solving a current runtime need. Reconsider only if Tracework becomes SSR or a server-owned web shell. |

### 3.2 Frozen choice

Tracework will use Model A for the first authentication implementation:

~~~
Browser Supabase Auth session
        |
        +-- access token from the current SDK session
        v
Authorization: Bearer <access_token>
        |
        v
Tracework Vercel/Vite API adapter
        |
        +-- @supabase/server authenticated request context
        +-- verified Supabase user subject
        +-- caller-scoped Supabase client
        v
AuthenticatedPrincipal.userId
        |
        v
Phase 6D RLS and authorization context
        |
        v
Phase 6E authorized retrieval candidates
~~~

No cookie fallback, query-string token, body token, or client-supplied identity
fallback is part of the contract. The browser SDK may persist the session in
its supported storage, but the API contract is explicitly bearer-based.

## 4. AuthenticatedPrincipal contract

The first server-side identity representation is intentionally small:

~~~ts
type AuthenticatedPrincipal = {
  userId: string
  accessToken: string
}
~~~

Contract rules:

- userId is the verified Supabase Auth subject and is the only root identity
  accepted by server authorization code.
- accessToken is request-scoped credential material. It must never be logged,
  returned to the browser in a response body, placed in a URL, or copied into
  a database row. The type exists to construct the caller-scoped client and
  pass validated context, not to create a durable token store.
- A principal is created only after the server Auth mechanism accepts the
  bearer token.
- The request body, query string, localStorage profile, editable user
  metadata, and workspace fields cannot replace or extend this identity.
- A missing principal is not an anonymous authenticated user. It is either an
  explicit anonymous-demo request class or an authentication failure,
  depending on the route.

Authorization is a separate, database-derived value:

~~~ts
type WorkspaceRole = 'owner' | 'member' | 'viewer'

type AuthorizationContext = {
  userId: string
  activeWorkspaceIds: string[]
  workspaceRoles: Record<string, WorkspaceRole[]>
}
~~~

AuthorizationContext.userId must equal AuthenticatedPrincipal.userId.
Active memberships and roles are loaded from workspace_members later; they
are never accepted from the browser. Publication state, collection visibility,
document parentage, and ownership are database facts from Phase 6B/6D, not
claims supplied by the client.

## 5. Server token-validation contract

### 5.1 Request resolver

6C3 will centralize the following behavior in one resolver used by every
auth-required route:

~~~
resolveAuthenticatedPrincipal(request)
        |
        +-- require exactly one Authorization header
        +-- require scheme Bearer and a non-empty token
        +-- create @supabase/server request context with auth: 'user'
        +-- consume the verified user identity/claims from that context
        +-- return AuthenticatedPrincipal
~~~

The context API may be createSupabaseContext or the equivalent Vercel adapter
documented for the pinned package version; withSupabase({ auth: 'user' }) is
the corresponding wrapper model. 6C2/6C3 must verify the exact Node/Vercel
adapter and fail the implementation if the package cannot preserve the
contract. The implementation must not silently substitute a hand-written JWT
decoder.

### 5.2 Status and privacy behavior

| Condition | API result |
| --- | --- |
| No Authorization header on an auth-required route | 401 with stable unauthenticated code; no database query or provider call |
| Wrong scheme, duplicate header, empty bearer value, or malformed header | 401; do not echo the token |
| Expired, revoked, invalid-signature, wrong-project, or otherwise rejected token | 401; generic authentication error; do not reveal validation internals |
| Valid token | Construct trusted principal from the verified context |
| Valid principal but disallowed operation/resource | 403 when existence is already safe to reveal; otherwise existence-safe 404 |
| Anonymous request to explicit demo route | Continue only inside the fixed demo scope; never silently widen to the user catalog |

The resolver runs before request-body interpretation for protected routes where
possible. It must not make provider calls or privileged database calls before
authentication succeeds. A valid user is not automatically authorized for a
collection, workspace, document, source, or chunk.

### 5.3 getUser, getClaims, and getSession decision

~~~
Primary route resolver: @supabase/server authenticated context
Verified identity:     context user identity/claims, not decoded JWT text
Canonical user lookup: auth.getUser(accessToken), only when needed
Claim-only fallback:   getClaims(accessToken), only through a verified SDK path
Never for server auth: getSession() storage values alone
~~~

This avoids two independent validation implementations. The package context
owns normal request verification. getUser(jwt) remains the explicit network
validated method when a route needs the current Auth user record. A future
package compatibility fallback may use getClaims(jwt) only if the current
official API and signing-key behavior are verified at implementation time. In
all cases, the route must use verified output and never merely parse the JWT
payload.

## 6. Caller-scoped Supabase client design

### 6.1 Normal authenticated request

The eventual normal user path is:

~~~
request bearer token
        |
        v
@supabase/server verified context
        |
        v
ctx.supabase / caller-scoped Supabase client
        |
        +-- publishable application key
        +-- caller JWT context
        +-- RLS sees authenticated user
        v
PostgREST / invoker RPC / Phase 6D policies
~~~

The normal route must not call PostgREST with the service-role/secret key and
then pretend the result was caller-scoped. ctx.supabase is the intended
client for user list/read/search/create/update/delete operations after the
corresponding RLS and RPC contracts exist.

The existing route layer uses direct REST RPC calls. During implementation,
those calls must be replaced or wrapped so the caller's Authorization context
reaches Supabase. A route may not accept userId, workspaceId, or membership
claims from the body as a substitute for the caller context.

### 6.2 System operation

Privileged access is a separate class:

~~~
explicit system/admin operation
        |
        +-- authenticated operator or trusted job authorization
        +-- secret/service key in server-only environment
        +-- narrowly named system function or job
        +-- audit evidence
~~~

The privileged client must never be the default for an ordinary authenticated
request. A system key bypasses RLS; application code must perform explicit
authorization before using it, and user-controlled input must not turn a
normal route into an admin route.

## 7. Browser Supabase client contract

There is no browser Supabase client today. 6C2 will add one in a dedicated
module such as src/lib/supabase.ts after the plan is approved:

~~~
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
        |
        v
@supabase/supabase-js browser client
        |
        +-- persistSession: true
        +-- autoRefreshToken: true
        +-- detectSessionInUrl: true for confirmation/recovery handling
~~~

The exact SDK options must be checked against the pinned package. The browser
may contain only the project URL and publishable key. It must never contain or
receive:

~~~
SUPABASE_SECRET_KEY
SUPABASE_SERVICE_ROLE_KEY
database password
OpenAI API key
~~~

The future API fetch wrapper will obtain the current SDK access token and set:

~~~
Authorization: Bearer <access_token>
~~~

It must not put tokens in query strings, local application records, error
messages, analytics payloads, or console logs. The SDK owns session storage;
Tracework will not invent a second token store.

The public key is not an authorization grant. Supabase's anon/authenticated
database roles and later RLS policies still determine what a user can access.

## 8. Initial sign-in methods

6C2 should implement only the smallest useful learning surface:

~~~
signUp({ email, password, options.emailRedirectTo })
signInWithPassword({ email, password })
signOut({ scope: 'local' })
resetPasswordForEmail(email, { redirectTo })
updateUser({ password }) on an authenticated recovery screen
~~~

Email confirmation should be required for the first production-oriented flow.
The hosted project's exact confirmation configuration and redirect allowlist
must be checked before enabling the flow, but 6C1 does not change those
settings or send any email.

Defer Google, GitHub, magic link/OTP, phone/SMS, SSO, passkeys, identity
linking, and MFA. Passkeys and MFA may be valuable later, but adding them now
would expand the principal/session acceptance surface before the bearer path is
proven.

## 9. Signup and workspace bootstrap

Signup creates only a Supabase Auth identity:

~~~
auth.users.id -> authenticated principal root
~~~

Signup does not automatically grant:

~~~
public publication rights
moderator or admin rights
ownership of existing workspaces
membership in an existing workspace
~~~

Tracework will create no automatic personal/default workspace during 6C. This
matches the Phase 6B contract in which private ownership is distinct from
workspace scope. A user may deliberately create a private collection without a
workspace later, or deliberately create a workspace through a separate
workflow.

The later workspace bootstrap contract is:

~~~
create workspace
  -> creator becomes one active owner in the same transaction
invite member
  -> pending invitation tied to the workspace and inviter
accept invitation
  -> active membership after authenticated acceptance
remove member / change role
  -> owner/editor authorization and final-owner protection
~~~

These operations are Phase 6D/6F work. 6C only makes the authenticated
principal available to implement them safely.

## 10. Explicit anonymous demo boundary

The anonymous experience must be a named request class, not the accidental
absence of Auth:

~~~
ANONYMOUS_DEMO
  -> fixed bundled/public demo corpus only
  -> local hashed retrieval may remain available without credentials
  -> no user collection or workspace resolution
  -> no shared writes
  -> no arbitrary shared catalog access
  -> no /api/vector/sync or /api/vector/delete
  -> no normal /api/embed or /api/generate provider budget
~~~

The current local pasted/file index is browser-local and is not itself a
database authorization grant. It may remain an explicitly offline scratch
feature only when the operation stays local and does not send the content to a
remote embedding, generation, or Supabase route. A future anonymous demo must
not silently turn that scratch content into shared knowledge.

For the first authenticated transition:

~~~
anonymous user
  -> bundled demo + local credential-free retrieval

authenticated user
  -> own private content
  -> authorized workspace content
  -> published community content
  -> provider routes subject to authentication and later quota controls
~~~

The exact public demo collection allowlist and whether a separate demo API
path is retained are unresolved 6D/6E decisions. The invariant is already
frozen: anonymous access cannot mean “all public rows” and cannot be used to
consume unlimited provider budget.

## 11. Route-auth matrix

The current route behavior is recorded to make the transition measurable. All
current routes have no Auth requirement and use POST, even for read operations.

| Route | Current auth and credential | Future anonymous/demo rule | Future authenticated rule | Provider-cost risk | Final responsibility |
| --- | --- | --- | --- | --- | --- |
| /api/library/collections | Anonymous; service-role tracework_list_collections | Only an explicit fixed demo catalog, if retained; never generic all-collection listing | Caller-scoped authorized catalog; public/private/workspace filtering | None directly | 6C4 auth gate; 6D catalog authorization |
| /api/library/documents | Anonymous; service-role tracework_collection_documents | Only documents in the fixed demo scope, with existence-safe behavior | Caller-scoped document read after collection authorization | None directly | 6C4 auth gate; 6D authorization |
| /api/vector/search | Anonymous; service-role tracework_match_chunks | Only explicit demo corpus/search path | Authenticated caller-scoped search; authorized candidate set before ranking | Query vector may have been provider-generated elsewhere | 6C4 auth gate; 6D scope; 6E pre-retrieval isolation |
| /api/vector/sync | Anonymous when the deployment write gate is enabled; service-role tracework_replace_source | Never available | Authenticated principal plus ownership/workspace/contribution authorization | May persist provider-generated embeddings | 6C4 auth gate; 6D/6F write authorization |
| /api/vector/delete | Anonymous when the deployment write gate is enabled; service-role tracework_delete_sources | Never available | Authenticated principal plus document/collection ownership or admin authorization; never arbitrary source-ID deletion | No direct provider call | 6C4 auth gate; 6D/6F write authorization |
| /api/embed | Anonymous OpenAI proxy using OPENAI_API_KEY; no Supabase client | No normal anonymous path; a future separate demo endpoint would require an explicit tiny budget/rate limit | Authenticated principal required before provider call; per-user/workspace quota later | High: direct embedding cost | 6C4 auth gate; quota/rate limit later |
| /api/generate | Anonymous OpenAI Responses proxy using OPENAI_API_KEY; no Supabase client | No normal anonymous path; a future separate demo endpoint would require explicit budget/rate limit | Authenticated principal required before provider call; quota/rate limit later | High: generation cost | 6C4 auth gate; quota/rate limit later |

Authentication is not authorization: a signed-in caller still cannot read every
collection or workspace. Phase 6D must supply the resource checks and RLS;
Phase 6E must put those checks before vector/lexical/fusion candidate
selection. The current Phase 5 retrieval logic is not changed by this plan.

## 12. Provider-cost boundary

/api/embed and /api/generate are currently cost-bearing routes with no caller
identity. The first secured contract is:

~~~
normal /api/embed      authenticated principal required
normal /api/generate   authenticated principal required
~~~

The Auth check must happen before input processing that could trigger a
provider call, and before any provider request. Missing or invalid Auth must
return 401 with stable providerCalled = false test instrumentation where that
field exists.

An anonymous demo provider path is not part of the first implementation. If a
demo needs remote embeddings or generation later, it must be a separate,
explicitly named path with a small server-enforced budget, rate limit, input
cap, and no access to user/workspace data. “Anonymous” must never mean free,
unlimited provider use.

## 13. Auth state and UX contract

The future browser Auth state machine must expose behavior, not just a boolean:

| State | Meaning and required behavior |
| --- | --- |
| initializing | SDK is restoring or resolving the local session; do not render private/user-scoped results as authorized yet |
| signed-out | No usable session; show the explicit demo boundary and sign-in entry point |
| signing-in | Credentials are being submitted; disable duplicate submission and preserve generic error semantics |
| signed-in | Verified browser session exists; API wrappers attach the current access token |
| email-verification-pending | Signup returned without a usable session because confirmation is required; provide resend/retry UX without revealing account enumeration details |
| session-expired | API or SDK indicates the session cannot be refreshed; clear protected UI state and require sign-in again |
| signing-out | Stop or invalidate protected work and prevent stale results from being displayed as current |
| auth-network-error | Auth service/network failure; preserve no false signed-in state and offer retry |
| password-recovery | Recovery event exposes only the password update surface; do not treat it as normal application authorization until session state is valid |

The visual design is deferred. The behavioral invariant is that private,
workspace, or user-specific application state is not rendered before Auth
initialization resolves, and a sign-out/expiry cannot leave stale protected
results looking current.

## 14. Session lifecycle

### Initial load and restoration

1. Create one browser Supabase client.
2. Subscribe to onAuthStateChange before rendering auth-dependent surfaces.
3. Treat INITIAL_SESSION as the end of the initial restoration gate.
4. Keep initializing until the event/session handling is complete.
5. Do not treat a local session object as proof to the server; API calls still
   carry a token that the server validates.

### Sign in, refresh, and multiple tabs

- SIGNED_IN sets the authenticated UI state and causes later API wrappers to
  read the current access token.
- TOKEN_REFRESHED updates the session reference used for subsequent API calls;
  it must not be logged.
- Supabase client storage/event behavior is the cross-tab synchronization
  mechanism to verify in 6C2. Tracework must not implement a second ad hoc tab
  bus or copy tokens into application storage.
- A request that starts during a token transition must either use the token
  captured for that request or be retried once with the current session after a
  401; it must not mix user identities within one request.

### Expiry and sign out

- A server 401 marks the request unauthenticated, aborts or ignores stale
  protected results, and gives the SDK a chance to refresh once where safe.
- If refresh fails, transition to session-expired/signed-out; do not loop
  retries.
- Normal sign out uses signOut({ scope: 'local' }), clears the local
  authenticated UI state, and prevents protected API calls until a new
  principal exists.
- A global sign-out action, session revocation policy, and forced logout after
  compromise remain later security decisions.

### Email confirmation and password reset

- Signup supplies an explicit confirmation redirect URL from an allowlisted
  application origin.
- A confirmation callback returns to the SPA and lets the browser SDK resolve
  the session; the API still validates the bearer token.
- Password reset uses a public request screen and an allowlisted redirect to a
  protected update-password screen.
- The reset request must use generic messaging so it does not reveal whether an
  email exists.

## 15. Authentication versus authorization boundary

~~~
Phase 6C: WHO are you?
  -> validate Supabase identity and propagate a principal

Phase 6D: WHAT may you access or mutate?
  -> RLS, ownership, active workspace membership, roles, publication rules

Phase 6E: WHICH authorized knowledge may enter retrieval?
  -> pre-ranking candidate isolation across vector, lexical, fusion, and routes
~~~

A successful login does not imply:

~~~
read all collections
write all public knowledge
access all workspaces
publish contributions
moderate content
call providers without quota
~~~

Frontend route guards are UX only. They cannot be the authorization boundary.
The server and database must derive authorization from the verified principal
and database state.

## 16. Identity propagation and future code locations

The intended end-to-end path is:

~~~
Supabase Auth signUp/signIn
        |
        v
browser session managed by supabase-js
        |
        v
current access token
        |
        v
shared API fetch wrapper adds Authorization header
        |
        v
api/* Vercel adapter / Vite dev adapter
        |
        v
server/traceworkApi.ts principal resolver
        |
        +-- @supabase/server verified context
        +-- AuthenticatedPrincipal.userId
        +-- caller-scoped Supabase client
        v
Phase 6D RLS and database authorization
        |
        v
Phase 6E authorized retrieval isolation
~~~

Expected future modification sites, without changing them in 6C1:

| Location | Future responsibility |
| --- | --- |
| package.json / package-lock.json | Pin @supabase/supabase-js and @supabase/server after package/API spike |
| src/lib/supabase.ts or src/auth/* | One browser client, session state, sign-in/out/password flows |
| src/main.tsx / src/App.tsx | Auth initialization gate and account/demo state; preserve local retrieval behavior |
| src/lib/vectorDb.ts | Attach bearer token through the shared request wrapper and handle 401 without stale results |
| src/lib/knowledgeLibrary.ts | Same authenticated request transport and catalog privacy semantics |
| src/lib/semantic.ts / src/lib/generation.ts | Require authenticated provider route calls and expose auth/quota errors separately from provider errors |
| server/traceworkApi.ts | Central principal resolver, request auth gate, caller-scoped Supabase context, and stable 401/403/404 behavior |
| api/*.ts | Preserve thin deployment adapters; do not duplicate Auth logic per route |
| vite.config.ts | Apply the same resolver to local middleware, using Vite env only for server-only local configuration |
| .env.example / deployment environment | Add public browser variables and future server publishable/secret names without exposing secrets |
| scripts/seed-library.mjs | Remain a deliberate operator/system path, never a browser user path |

## 17. Service-role reduction plan

| Current operation | Current privilege | Future classification |
| --- | --- | --- |
| Library collections read route | Service-role RPC | Must become caller-scoped or explicit demo-scoped; final catalog authorization is 6D |
| Library documents read route | Service-role RPC | Must become caller-scoped or explicit demo-scoped; final document authorization is 6D |
| Vector search route | Service-role RPC | Must become caller-scoped; authorized candidate isolation is 6D/6E |
| Vector sync route | Service-role RPC, deployment-gated | Must become authenticated caller-scoped; ownership/workspace/contribution rules are 6D/6F |
| Vector delete route | Service-role RPC, deployment-gated | Must become authenticated scoped deletion; arbitrary source-ID deletion should be removed from the user contract |
| /api/embed | OpenAI server key; no Supabase call | Require principal before provider call; quota/rate limiting later |
| /api/generate | OpenAI server key; no Supabase call | Require principal before provider call; quota/rate limiting later |
| scripts/seed-library.mjs | Direct service-role RPC from operator environment | Legitimate system seed/import path; keep outside normal user routes and audit explicitly |
| Migration/preflight/inventory tooling | Server/CLI credential as needed for controlled read-only or migration operations | Legitimate tooling path; never expose to browser; keep separate from user request context |
| Current raw service-role route bridge | Privileged compatibility path | Temporary compatibility only; remove from normal user operations after caller-scoped/RLS cutover |

The service role is not a user identity. The transition is not complete if a
route verifies a user and then performs an unrestricted service-role query with
the same request data.

## 18. User/profile data decision

Phase 6C does not need a separate profile table. The first product surface only
needs:

~~~
auth.users.id       principal identity
auth.users.email    account UX where Supabase exposes it
~~~

Do not duplicate email merely for authorization. Do not put roles, workspace
membership, ownership, moderation state, or other authorization truth in
editable user metadata. If a future profile table becomes necessary, it must
contain product-owned display/preferences data and have an explicit RLS design;
that is a separate reviewed decision.

## 19. Failure and privacy semantics

The external API contract will use these distinctions:

~~~
401  no usable authenticated principal
403  principal is valid but the operation is disallowed and existence is safe
404  resource is absent or belongs to an inaccessible private/workspace scope
400  authenticated request is malformed
429  authenticated provider/quota limit later
5xx  internal, database, Auth service, or provider failure without secrets
~~~

Private and workspace resource probes should generally return an
existence-safe 404 for guessed collection/document/source/chunk IDs. A known
public resource may return 403 for a disallowed operation where revealing its
existence is already intentional. Error payloads must not contain JWTs, keys,
database URLs with credentials, raw Postgres errors, or membership details that
reveal another user's scope.

## 20. Authentication-specific threat model

| Threat | Design mitigation |
| --- | --- |
| Stolen access token | TLS/deployment hygiene, no token logging or URLs, short access-token lifetime where project policy permits, server validation on every request, later session/revocation review |
| Expired token replay | Verified resolver returns 401; refresh once through SDK, then require sign-in; never accept expired claims locally |
| JWT decoded but not validated | Use @supabase/server verified context or a documented verified SDK method; never trust JSON.parse of the JWT payload |
| Client-supplied userId | Ignore it for identity; derive user ID only from the verified Auth subject |
| Client-supplied workspace membership/role | Ignore it; query active workspace_members later under RLS/authorization rules |
| Service role used as user context | Caller-scoped client is mandatory for normal user operations; admin client is explicitly named and isolated |
| Secret key leaked into frontend | Only publishable key receives VITE_ exposure; secret/service/OpenAI keys remain unprefixed server env |
| Anonymous provider-cost abuse | Protect normal embed/generate before provider call; any future demo path has an independent budget/rate limit |
| Session confusion between users | One SDK client, one request token snapshot, no shared mutable principal, clear protected state on identity changes |
| Sign-out leaves privileged UI state | Handle SIGNED_OUT, abort/ignore in-flight protected results, reset user-scoped state and require reinitialization |
| Cross-tab stale auth state | Use Supabase SDK storage/events, test SIGNED_IN/SIGNED_OUT/TOKEN_REFRESHED across tabs, avoid a second token store |
| Email/account enumeration | Generic signup/reset messaging and Supabase's documented non-disclosure behavior for reset requests |
| Confirmation/recovery redirect abuse | Allowlist exact application origins; never accept arbitrary redirect URLs from the browser |
| Authenticated but unauthorized user | Keep 6C identity separate from 6D authorization; enforce database-derived scope before reads/writes/retrieval |

## 21. Phase 6C acceptance tests

The following tests are designed before implementation. They should use mocked
Auth/context and local request handlers wherever possible; no provider call or
real user creation is required for the core Auth contract.

### Resolver and transport

- A signed-out request to an auth-required route returns 401 before any
  Supabase privileged call or provider call.
- A missing, empty, duplicate, wrong-scheme, or malformed bearer header returns
  401.
- An expired, invalid-signature, wrong-project, or otherwise invalid token
  returns 401.
- A valid token resolves the exact corresponding auth.users.id/verified
  subject.
- A JWT with a client-chosen sub cannot impersonate another user because the
  resolver does not trust an unverified decode.
- A body/query userId cannot override the principal.
- A body/query workspaceId, role, or membership list cannot override database
  authorization context.
- Server logs and error bodies contain no access token, secret key, or database
  credential.
- A caller-scoped Supabase client carries the caller identity; a normal user
  request never uses the unrestricted admin client.

### Browser/session lifecycle

- The browser bundle contains no service-role/secret/database/OpenAI key.
- Initial session restoration shows initializing and does not render private
  application state before resolution.
- Email/password sign-in reaches signed-in only after the SDK reports a valid
  session.
- Email-confirmation-pending is distinguishable from signed-in without account
  enumeration.
- TOKEN_REFRESHED updates later request headers without logging the token.
- signOut({ scope: 'local' }) clears the current session and protected UI.
- A protected API 401 causes one safe refresh/retry decision, then a stable
  expired/signed-out state without an infinite loop.
- Cross-tab sign-in/sign-out does not leave the other tab presenting stale
  privileged state.
- Password-reset request messaging does not reveal whether an account exists.

### Anonymous/demo and route boundaries

- Anonymous access remains limited to the explicit bundled demo/local
  credential-free path.
- Anonymous access cannot list/fetch arbitrary user public, private, or
  workspace content.
- Anonymous access cannot call sync or delete.
- Anonymous access cannot call the normal embed or generate route.
- No anonymous request can use a client-supplied flag to activate shared writes.
- Valid authentication alone does not bypass workspace/document authorization.
- Private/workspace probes use the agreed existence-safe error semantics.

### Regression boundary

- Existing local Phase 5 retrieval behavior remains unchanged for the
  authorized/demo test path.
- Auth failures are distinct from database, retrieval, generation, and provider
  failures.
- Auth tests make zero OpenAI/provider calls.
- Auth tests create zero live Supabase users and make zero live Auth setting or
  database changes.

## 22. Implementation sequence after 6C1 approval

The safe sequence is:

~~~
6C1  architecture, runtime audit, principal contract       this document
6C2  package spike + browser Supabase session layer          install/pin only after approval
6C3  server principal resolver and caller context           bearer validation, 401 contract
6C4  protect provider and write routes                      auth gates before cost/mutation
6C5  auth UI and lifecycle                                  sign-in/signup/reset/session states
6C6  anonymous demo compatibility                           explicit demo scope and regression
6C7  adversarial authentication verification                tests, logs, token/session boundaries
~~~

Do not start Phase 6D RLS in the same implementation task. 6D should begin only
after 6C proves that a request can reliably identify the caller and that normal
routes no longer silently depend on missing identity.

## 23. Deferred decisions

These items remain intentionally unresolved or implementation-gated:

- exact pinned versions and Vercel adapter API for the current public-beta
  @supabase/server package;
- whether the deployed project should migrate from legacy
  SUPABASE_SERVICE_ROLE_KEY to a new SUPABASE_SECRET_KEY immediately or in a
  separately reviewed credential transition;
- exact Auth email-confirmation, SMTP, Site URL, and redirect allowlist
  settings;
- session expiry, inactivity timeout, refresh-token rotation, and compromised
  session revocation policy;
- whether a separate, budgeted anonymous demo provider path is needed at all;
- exact fixed public demo collection/route allowlist;
- Phase 6D collection/document ownership policies and workspace role matrix;
- workspace invitation persistence and notification delivery;
- moderation/publication workflow for public contributions;
- profile/display-name/preferences requirements;
- MFA, passkeys, OAuth, magic links, SSO, and identity linking.

None of these deferred choices permits a future implementation to trust
client-supplied identity or use the service role as a normal user context.

## 24. 6C1 verification and stop boundary

This planning phase is complete only when the following local checks pass after
the document is created:

~~~
npm.cmd run check
git diff --check
~~~

Expected repository result:

~~~
HEAD: cc6c833
origin/main: synchronized
Only docs/phase6c-authentication-plan.md is uncommitted
~~~

No application, package, environment, Supabase, Auth, RLS, RPC, route,
deployment, or provider state is changed by 6C1. Stop after reporting the
frozen architecture and unresolved decisions. Do not begin 6C2.

## Official references

- [Which Supabase package to use](https://supabase.com/docs/guides/auth/choosing-a-server-package)
- [JavaScript getUser](https://supabase.com/docs/reference/javascript/auth-getuser)
- [JavaScript getClaims](https://supabase.com/docs/reference/javascript/auth-getclaims)
- [JavaScript getSession](https://supabase.com/docs/reference/javascript/auth-getsession)
- [JavaScript onAuthStateChange](https://supabase.com/docs/reference/javascript/auth-onauthstatechange)
- [JavaScript signOut](https://supabase.com/docs/reference/javascript/auth-signout)
- [Password-based Auth](https://supabase.com/docs/guides/auth/passwords)
- [User sessions](https://supabase.com/docs/guides/auth/sessions)
- [Understanding Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase changelog: breaking changes](https://supabase.com/changelog?types=breaking-change)
