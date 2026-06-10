# ClaudeSessionManager

Tampermonkey userscript for cross-account Claude.ai session management.

## Purpose

Solves the problem of managing ~50 Gmail accounts used to work around Claude's free-tier quota limits. Tracks conversations across accounts, enables one-click session swapping via Google Account Chooser, and syncs data via GitHub Gist.

## Architecture

Single self-contained userscript: `claude_session_manager.user.js`

No build step. Install directly via Tampermonkey.

### Key discoveries from source analysis

- `sessionKeyLC` cookie: not HttpOnly and writable via JS, but **only a localStorage cache namespace key** (`conversations_v2:${sessionKeyLC}`). Writing it does NOT change the authenticated session — confirmed broken in live testing.
- `sessionKey` cookie: HttpOnly — the real auth token, completely inaccessible to JS.
- **Session swap mechanism**: redirect to `/login?login_hint=<email>&returnTo=<path>&reauth=1&from=logout`. The `reauth=1&from=logout` flags force Claude's login page to go through Google OAuth even when already logged in — without them, Claude just bounces the user back to `returnTo` immediately. Google then pre-selects the hinted account. Confirmed: plain `login_hint` alone is broken; Google AccountChooser URL returns 400.
- Chat input: ProseMirror `contenteditable` div with `data-testid="chat-input"`.
- Account email: fetched from `/api/bootstrap` or `/api/account` API responses (not reliably in localStorage at page load — fetch interceptor captures it).
- Hard limit strings: "You've reached your usage limit", "You are out of free messages until", "Usage limit reached", "You're out of extra usage/usage credits".
- Soft warning strings (must NOT trigger swap): "almost out of usage", percentage warnings, peak hours notices.

### Data model

Stored in `GM_setValue` (Tampermonkey storage), optionally synced to a private GitHub Gist.

```
{
  accounts: { [email]: { label, sessionKeyLC, lastSeen, uuid } },
  conversations: { [convId]: { title, url, accountEmail, model, lastMessage, parentConvId, childConvIds[], notes, updatedAt } },
  settings: { gistToken, gistId, autoSwap }
}
```

`sessionKeyLC` is still stored per account for legacy reasons but is not used for swapping.

## Key workflows

**Account registration**: Auto-detected via fetch interceptor on bootstrap/account API calls. Falls back to localStorage regex scan.

**Session swap**: Redirect to Google Account Chooser with target email. Silent SSO if already signed in. No JS cookie manipulation needed.

**Limit detection**: Two-layer check — bail early on soft warning patterns, then match hard limit patterns only.

**Gist sync**: Push/pull JSON blob to a private Gist. Auto-push every 30s if dirty.

**Conversation chaining**: Manual linking via UI — marks `parentConvId` / `childConvIds` to trace multi-account transcript chains.

## Version

Current: 1.0.9

## Known unknowns

- Whether Google Account Chooser silent SSO works reliably across all browsers when accounts are pre-authenticated (needs live testing at quota hit).
- ProseMirror programmatic text injection not yet implemented (Phase 2).
- Auto context injection after swap not yet implemented (Phase 2).
