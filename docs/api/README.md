# LOPC API — Documentation Index

Base URL: `https://lopc-api.***.workers.dev`

## Authentication

All authenticated endpoints require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <accessToken>
```

Access tokens are short-lived JWTs (15 min) issued by `POST /auth/login` or `POST /auth/register`. Use `POST /auth/refresh` to obtain a new access token without re-logging in.

| Auth Level | Description |
|---|---|
| `none` | Public — no token required |
| `customer` | Valid JWT with role `customer` or `admin` |
| `admin` | Valid JWT with role `admin` only |

## Response Envelope

All responses share a consistent JSON envelope:

```json
{
  "data": <payload>,
  "meta": { "page": 1, "pageSize": 20, "total": 100 },
  "error": null
}
```

- `data` — the response payload or `null` on error
- `meta` — pagination metadata for list endpoints, otherwise `null`
- `error` — `null` on success, or `{ "code": "ERROR_CODE", "message": "description" }` on failure

## Common Status Codes

| Status | Meaning |
|---|---|
| 200 | Success |
| 201 | Resource created |
| 204 | No content (delete/logout) |
| 400 | Bad request / missing params |
| 401 | Missing or invalid token |
| 403 | Authenticated but insufficient role |
| 404 | Resource not found |
| 409 | Conflict (duplicate slug, email, tracking number) |
| 422 | Validation failed |
| 500 | Internal server error |

## Endpoint Groups

| Group | File | Endpoints |
|---|---|---|
| Discovery | [discovery.md](./discovery.md) | 1 |
| Auth | [auth.md](./auth.md) | 6 |
| Products | [products.md](./products.md) | 8 |
| Categories | [categories.md](./categories.md) | 5 |
| Customers | [customers.md](./customers.md) | 9 |
| Orders | [orders.md](./orders.md) | 6 |
| Logistics | [logistics.md](./logistics.md) | 5 |
| Admin | [admin.md](./admin.md) | 7 |
| Webhooks | [webhooks.md](./webhooks.md) | 1 |

**Total: 48 endpoints**
