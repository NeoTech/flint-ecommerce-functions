# Auth

Account registration, login, logout, token refresh, and password reset.

All routes are public (`auth: none`). Rate limiting applies.

---

## POST /auth/register

Create a new customer account. Also creates a Stripe Customer in the background (non-fatal if Stripe is unreachable). Returns a token pair.

**Auth:** `none`

### Request Body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | `string` | Yes | Valid email format |
| `password` | `string` | Yes | Min 8 characters |
| `firstName` | `string` | Yes | Min 1 character |
| `lastName` | `string` | Yes | Min 1 character |

### Response `201`

| Field | Type | Description |
|---|---|---|
| `user.id` | `string` | UUID |
| `user.email` | `string` | Registered email |
| `user.role` | `string` | Always `customer` on register |
| `user.firstName` | `string` | |
| `user.lastName` | `string` | |
| `accessToken` | `string` | RS256 JWT, 15-minute TTL |
| `refreshToken` | `string` | Opaque token, 7-day TTL |

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 409 | `CONFLICT` | Email already registered |
| 422 | `VALIDATION_ERROR` | Invalid email, password too short, missing name |

---

## POST /auth/login

Authenticate with email and password. Returns a token pair. Backfills missing Stripe Customer ID on the user row if absent.

**Auth:** `none`

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | `string` | Yes | Registered email |
| `password` | `string` | Yes | Account password |

### Response `200`

| Field | Type | Description |
|---|---|---|
| `user.id` | `string` | UUID |
| `user.email` | `string` | |
| `user.role` | `string` | `customer` or `admin` |
| `accessToken` | `string` | RS256 JWT, 15-minute TTL |
| `refreshToken` | `string` | Opaque token, 7-day TTL |

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 401 | `UNAUTHORIZED` | Wrong email, wrong password, or deactivated account |

---

## POST /auth/logout

Revoke a refresh token. Idempotent — returns `204` even if the token was already revoked.

**Auth:** `none`

### Request Body

| Field | Type | Required |
|---|---|---|
| `refreshToken` | `string` | Yes |

### Response `204`

No content.

---

## POST /auth/refresh

Exchange a valid refresh token for a new access token. The old refresh token is invalidated and a new one is issued (rotation).

**Auth:** `none`

### Request Body

| Field | Type | Required |
|---|---|---|
| `refreshToken` | `string` | Yes |

### Response `200`

| Field | Type | Description |
|---|---|---|
| `accessToken` | `string` | New RS256 JWT, 15-minute TTL |
| `refreshToken` | `string` | New opaque token, 7-day TTL (old token revoked) |

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 401 | `UNAUTHORIZED` | Token not found, expired, or already rotated |

---

## POST /auth/forgot-password

Generates a password reset token and (in a real deployment) triggers a reset email. Always returns `200` regardless of whether the email exists to prevent email enumeration.

**Auth:** `none`

### Request Body

| Field | Type | Required |
|---|---|---|
| `email` | `string` | Yes |

### Response `200`

```json
{
  "data": { "message": "If the email exists, a reset link has been sent" },
  "meta": null,
  "error": null
}
```

---

## POST /auth/reset-password

Consume a reset token and set a new password. The reset token is single-use — it is deleted after a successful reset.

**Auth:** `none`

### Request Body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `token` | `string` | Yes | Opaque reset token from the forgot-password flow |
| `newPassword` | `string` | Yes | Min 8 characters |

### Response `200`

```json
{
  "data": { "message": "Password updated" },
  "meta": null,
  "error": null
}
```

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 401 | `UNAUTHORIZED` | Token not found or expired (1-hour TTL) |
| 422 | `VALIDATION_ERROR` | New password too short |
