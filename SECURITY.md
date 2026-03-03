# Security

## Reporting Vulnerabilities

To report a security vulnerability, open a GitHub issue marked `[SECURITY]` or email the maintainer directly. Do not disclose details publicly until a fix is released.

## Authentication Model

- Access tokens: RS256 JWT, 15-minute TTL. Contains `userId` (sub claim) and `role` claim.
- Refresh tokens: 64-character opaque hex strings, SHA-256 hashed before storage. 7-day TTL. Rotated on every use (old token deleted, new token issued).
- Password reset tokens: separate opaque tokens, 1-hour TTL, single-use (deleted on consumption).
- Passwords: bcrypt via `bcryptjs` (cost factor 12).

## Known Limitations

- No email delivery in scope: forgot-password generates a reset token but does not send email. Clients must implement their own delivery mechanism using the returned token.
- Turso/LibSQL is a single-writer database. High write throughput (>1000 orders/day sustained) may require migration to a multi-writer solution.
- Admin Worker (`functions/admin/`) is deployed separately and has no rate limiting. Deploy behind a Cloudflare Access policy for production use.
- Refresh token rotation does not invalidate all sessions for a user simultaneously. Use the `/auth/logout` endpoint to revoke individual tokens.

## Security Headers

All responses include:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: interest-cohort=()`

CORS: only origins listed in `ALLOWED_ORIGINS` (comma-separated) receive CORS headers. Requests from unlisted origins receive a 403 response.
