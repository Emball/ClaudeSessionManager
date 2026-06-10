# ClaudeSessionManager

Tampermonkey userscript for cross-account Claude.ai session management.

## Purpose

Solves the problem of managing ~50 Gmail accounts used to work around Claude's free-tier quota limits. Tracks conversations across accounts, enables one-click session swapping by writing the `sessionKeyLC` cookie, and syncs data via GitHub Gist.

## Architecture

Single self-contained userscript: `claude_session_manager.user.js`

No build step. Install directly via Tampermonkey.

### Key discoveries from source analysis

- `sessionKeyLC` cookie: not HttpOnly — readable and writable via JS. This is the session swap mechanism.
- `sessionKey` cookie: HttpOnly — cannot be touched by JS.
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

## Key workflows

**Account registration**: Auto-detected via fetch interceptor on bootstrap/account API calls. Falls back to localStorage regex scan.

**Session swap**: Write target account's `sessionKeyLC` to cookie → reload. Confirmed writable in testing.

**Limit detection**: Two-layer check — bail early on soft warning patterns, then match hard limit patterns only.

**Gist sync**: Push/pull JSON blob to a private Gist. Auto-push every 30s if dirty.

**Conversation chaining**: Manual linking via UI — marks `parentConvId` / `childConvIds` to trace multi-account transcript chains.

## Version

Current: 1.0.1

## Known unknowns

- Whether `sessionKeyLC` swap actually authenticates as the target account (not yet confirmed in live testing — needs a real quota hit to verify).
- ProseMirror programmatic text injection not yet implemented (Phase 2).
- Auto context injection after swap not yet implemented (Phase 2).
