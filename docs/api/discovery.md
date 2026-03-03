# Discovery

Runtime-generated API route manifest. No authentication required.

---

## GET /

Returns metadata for every registered route in the API.

**Auth:** `none`

### Response `200`

```json
{
  "data": {
    "name": "LOPC API",
    "version": "1.0.0",
    "environment": "development",
    "routes": [
      {
        "method": "GET",
        "path": "/products",
        "auth": "none",
        "description": "List products with optional filtering and pagination.",
        "queryParams": ["category", "minPrice", "maxPrice", "search", "inStock", "status", "page", "pageSize"]
      }
    ]
  },
  "meta": null,
  "error": null
}
```

| Field | Type | Description |
|---|---|---|
| `name` | `string` | API name |
| `version` | `string` | API version |
| `environment` | `string` | Runtime environment (`development`, `production`) |
| `routes` | `array` | All registered routes |
| `routes[].method` | `string` | HTTP method |
| `routes[].path` | `string` | URL path pattern |
| `routes[].auth` | `string` | Auth level (`none`, `customer`, `admin`) |
| `routes[].description` | `string` | Human-readable description |
| `routes[].queryParams` | `string[]` | Accepted query parameters |
