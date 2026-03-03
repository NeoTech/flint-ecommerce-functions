# Categories

Product category management. Public reads; admin-only writes. Categories support a simple parent-child hierarchy.

---

## GET /categories

List all categories sorted by `sortOrder` then `name`. No pagination — typically a small, stable list.

**Auth:** `none`

### Response `200`

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Apparel",
      "slug": "apparel",
      "parentId": null,
      "description": null,
      "sortOrder": 0,
      "createdAt": "2025-01-01 00:00:00",
      "updatedAt": "2025-01-01 00:00:00"
    }
  ],
  "meta": null,
  "error": null
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | UUID |
| `name` | `string` | Display name |
| `slug` | `string` | URL-safe unique identifier |
| `parentId` | `string\|null` | Parent category UUID for nested categories |
| `description` | `string\|null` | Optional description |
| `sortOrder` | `number` | Sort weight, lower = earlier |

---

## GET /categories/:id

Get a category with its direct children.

**Auth:** `none`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Category UUID |

### Response `200`

Same category fields as above, plus:

| Field | Type | Description |
|---|---|---|
| `children` | `array` | Direct child categories, sorted by `sortOrder` then `name` |

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Category not found |

---

## POST /categories

Create a new category. Slug is auto-generated from `name` and de-duplicated if needed.

**Auth:** `admin`

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Min 1 character |
| `parentId` | `string` | No | Parent category UUID for nesting |
| `description` | `string` | No | |
| `sortOrder` | `integer` | No | Default `0` |

### Response `201`

The new category object.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 409 | `CONFLICT` | Slug collision (rare) |
| 422 | `VALIDATION_ERROR` | Invalid body |

---

## PUT /categories/:id

Update a category. All fields optional. Changing `name` regenerates and de-duplicates the slug.

**Auth:** `admin`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Category UUID |

### Request Body (all optional)

| Field | Type | Description |
|---|---|---|
| `name` | `string` | |
| `parentId` | `string` | |
| `description` | `string` | |
| `sortOrder` | `integer` | |

### Response `200`

Updated category object.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Category not found |
| 422 | `VALIDATION_ERROR` | Invalid body |

---

## DELETE /categories/:id

Hard-delete a category. Blocked if any `active` products reference this category.

**Auth:** `admin`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Category UUID |

### Response `204`

No content.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Category not found |
| 409 | `CONFLICT` | One or more active products reference this category |
