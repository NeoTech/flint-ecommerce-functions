# Products

Product catalog management and variant handling. Public reads; admin-only writes. Product creation/update automatically syncs to Stripe (non-fatal if Stripe is unavailable).

---

## GET /products

List products with optional filtering and pagination. Non-admin callers always see only `active` products. Admins can filter by any status.

**Auth:** `none`

### Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `category` | `string` | Filter by category UUID |
| `minPrice` | `number` | Minimum price (inclusive) |
| `maxPrice` | `number` | Maximum price (inclusive) |
| `search` | `string` | Partial name match (case-insensitive) |
| `inStock` | `boolean` | `true` to return only products with `stock > 0` |
| `status` | `string` | Admin only: `draft`, `active`, `archived` |
| `page` | `number` | Page number, default `1` |
| `pageSize` | `number` | Results per page, default `20` |

### Response `200`

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Product Name",
      "slug": "product-name",
      "description": null,
      "categoryId": null,
      "price": 49.99,
      "comparePrice": 79.99,
      "stock": 100,
      "status": "active",
      "stripeProductId": "prod_abc123",
      "stripePriceId": "price_abc123",
      "createdAt": "2025-01-01 00:00:00",
      "updatedAt": "2025-01-01 00:00:00"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "total": 42 },
  "error": null
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | UUID |
| `name` | `string` | Product name |
| `slug` | `string` | URL-safe unique identifier |
| `description` | `string\|null` | Optional description |
| `categoryId` | `string\|null` | FK to categories |
| `price` | `number` | Selling price |
| `comparePrice` | `number\|null` | Original/crossed-out price |
| `stock` | `number` | Current inventory count |
| `status` | `string` | `draft`, `active`, or `archived` |
| `stripeProductId` | `string\|null` | Stripe Product ID |
| `stripePriceId` | `string\|null` | Stripe Price ID |

---

## GET /products/:id

Get a single product with all its variants. Non-admins cannot access archived products.

**Auth:** `none`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Product UUID |

### Response `200`

Same product fields as above, plus:

| Field | Type | Description |
|---|---|---|
| `variants` | `array` | List of product variants |
| `variants[].id` | `string` | Variant UUID |
| `variants[].productId` | `string` | Parent product UUID |
| `variants[].sku` | `string` | Stock-keeping unit |
| `variants[].name` | `string` | Variant label (e.g. `Size: L`) |
| `variants[].price` | `number\|null` | Override price; falls back to product price if null |
| `variants[].stock` | `number` | Variant stock count |
| `variants[].attributes` | `string\|null` | JSON string of key-value attributes |

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Product not found or archived (non-admin) |

---

## POST /products

Create a new product. Slug is auto-generated from `name` (de-duplicated if needed). A Stripe Product + Price is created in the background and the IDs are stored on the row.

**Auth:** `admin`

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Min 1 character |
| `price` | `number` | Yes | Must be positive |
| `categoryId` | `string` | No | Category UUID |
| `description` | `string` | No | |
| `comparePrice` | `number` | No | Must be positive |
| `stock` | `integer` | No | Default `0` |
| `status` | `string` | No | `draft` (default), `active`, or `archived` |

### Response `201`

Returns the full product object (see `GET /products` fields). Includes `stripeProductId` and `stripePriceId` if Stripe sync succeeded.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 409 | `CONFLICT` | Slug collision (rare) |
| 422 | `VALIDATION_ERROR` | Invalid body |

---

## PUT /products/:id

Update a product. All fields are optional. If `price` changes, a new Stripe Price is created and the old one is archived. `name` change regenerates and de-duplicates the slug.

**Auth:** `admin`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Product UUID |

### Request Body (all optional)

| Field | Type | Description |
|---|---|---|
| `name` | `string` | |
| `price` | `number` | |
| `categoryId` | `string` | |
| `description` | `string` | |
| `comparePrice` | `number` | |
| `stock` | `integer` | |
| `status` | `string` | `draft`, `active`, or `archived` |

### Response `200`

Updated product object.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Product not found |
| 422 | `VALIDATION_ERROR` | Invalid body |

---

## DELETE /products/:id

Soft-delete a product by setting its status to `archived`. The product remains in the DB for order history integrity.

**Auth:** `admin`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Product UUID |

### Response `200`

Updated product object with `status: "archived"`.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Product not found |

---

## GET /products/:id/variants

List all variants for a product.

**Auth:** `none`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Product UUID |

### Response `200`

```json
{
  "data": [
    {
      "id": "uuid",
      "productId": "uuid",
      "sku": "SKU-001-L",
      "name": "Size: L",
      "price": null,
      "stock": 20,
      "attributes": "{\"size\":\"L\"}"
    }
  ],
  "meta": null,
  "error": null
}
```

---

## POST /products/:id/variants

Add a variant to a product.

**Auth:** `admin`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Product UUID |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `sku` | `string` | Yes | Stock-keeping unit |
| `name` | `string` | Yes | Variant label |
| `price` | `number` | No | Override price (uses product price if omitted) |
| `stock` | `integer` | No | Default `0` |
| `attributes` | `string` | No | JSON string, e.g. `{"color":"red","size":"M"}` |

### Response `201`

New variant object.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Product not found |
| 422 | `VALIDATION_ERROR` | Invalid body |

---

## PUT /products/:id/variants/:variantId

Update a variant. All fields optional.

**Auth:** `admin`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Product UUID |
| `variantId` | `string` | Variant UUID |

### Request Body (all optional)

| Field | Type | Description |
|---|---|---|
| `sku` | `string` | |
| `name` | `string` | |
| `price` | `number` | |
| `stock` | `integer` | |
| `attributes` | `string` | |

### Response `200`

Updated variant object.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Variant or product not found |
| 422 | `VALIDATION_ERROR` | Invalid body |
