# Customers

Customer profile management and address book. Customers can read and edit their own data; admins can access and modify all customers.

---

## GET /customers

List all customers with pagination and optional search. Admin only.

**Auth:** `admin`

### Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `search` | `string` | Partial match on email, firstName, or lastName |
| `page` | `number` | Default `1` |
| `pageSize` | `number` | Default `20` |

### Response `200`

```json
{
  "data": [
    {
      "id": "uuid",
      "userId": "uuid",
      "email": "user@example.com",
      "firstName": "Jane",
      "lastName": "Doe",
      "phone": "+46700000000",
      "role": "customer",
      "createdAt": "2025-01-01 00:00:00"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "total": 5 }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Customer UUID |
| `userId` | `string` | Linked user UUID |
| `email` | `string` | From the `users` table |
| `firstName` | `string` | |
| `lastName` | `string` | |
| `phone` | `string\|null` | |
| `role` | `string` | `customer`, `admin`, or `inactive` |

---

## GET /customers/:id

Get a customer profile. The customer can fetch their own profile; admins can fetch any.

**Auth:** `customer`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Customer UUID |

### Response `200`

Same fields as the list response above (single object, no pagination meta).

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 403 | `FORBIDDEN` | Authenticated as a different customer |
| 404 | `NOT_FOUND` | Customer not found |

---

## PUT /customers/:id

Update a customer profile. Customers can update `firstName`, `lastName`, `phone`. Only admins can change `role`.

**Auth:** `customer`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Customer UUID |

### Request Body (all optional)

| Field | Type | Description |
|---|---|---|
| `firstName` | `string` | |
| `lastName` | `string` | |
| `phone` | `string` | |
| `role` | `string` | Admin only: `customer`, `admin`, or `inactive` |

### Response `200`

Updated customer object.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 403 | `FORBIDDEN` | Non-admin attempting to change role, or accessing another customer |
| 404 | `NOT_FOUND` | Customer not found |
| 422 | `VALIDATION_ERROR` | Invalid body |

---

## DELETE /customers/:id

Deactivate a customer by setting `users.role = 'inactive'`. Does not hard-delete — order history is preserved. Admin only.

**Auth:** `admin`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Customer UUID |

### Response `204`

No content.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Customer not found |

---

## GET /customers/:id/orders

List orders belonging to a customer. Returns `lineCount` per order. The customer can fetch their own orders; admins can fetch any.

**Auth:** `customer`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Customer UUID |

### Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `page` | `number` | Default `1` |
| `pageSize` | `number` | Default `20` |

### Response `200`

```json
{
  "data": [
    {
      "id": "uuid",
      "customerId": "uuid",
      "status": "confirmed",
      "subtotal": 49.99,
      "tax": 0,
      "shippingCost": 0,
      "total": 49.99,
      "refundedAmount": 0,
      "notes": null,
      "lineCount": 2,
      "createdAt": "2025-01-01 00:00:00",
      "updatedAt": "2025-01-01 00:00:00"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "total": 3 }
}
```

| Field | Type | Description |
|---|---|---|
| `lineCount` | `number` | Number of line items in the order |

---

## GET /customers/:id/addresses

List all addresses for a customer.

**Auth:** `customer`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Customer UUID |

### Response `200`

```json
{
  "data": [
    {
      "id": "uuid",
      "customerId": "uuid",
      "type": "shipping",
      "street": "1 Sample Street",
      "city": "Stockholm",
      "state": null,
      "postalCode": "11122",
      "country": "SE",
      "isDefault": true
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `type` | `string` | `shipping` or `billing` |
| `isDefault` | `boolean` | Whether this is the default address for its type |

---

## POST /customers/:id/addresses

Add a new address to a customer's address book. If `isDefault: true`, unsets any existing default of the same type.

**Auth:** `customer`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Customer UUID |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `street` | `string` | Yes | Street address, min 1 character |
| `city` | `string` | Yes | Min 1 character |
| `postalCode` | `string` | Yes | Min 1 character |
| `type` | `string` | No | `shipping` (default) or `billing` |
| `state` | `string` | No | State/province |
| `country` | `string` | No | ISO country code, default `US` |
| `isDefault` | `boolean` | No | Default `false` |

### Response `201`

New address object.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 403 | `FORBIDDEN` | Accessing another customer's address book |
| 404 | `NOT_FOUND` | Customer not found |
| 422 | `VALIDATION_ERROR` | Invalid body |

---

## PUT /customers/:id/addresses/:addressId

Update an existing address. All fields optional.

**Auth:** `customer`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Customer UUID |
| `addressId` | `string` | Address UUID |

### Request Body (all optional)

| Field | Type | Description |
|---|---|---|
| `type` | `string` | `shipping` or `billing` |
| `street` | `string` | |
| `city` | `string` | |
| `state` | `string` | |
| `postalCode` | `string` | |
| `country` | `string` | |
| `isDefault` | `boolean` | Unsettles prior default of the same type |

### Response `200`

Updated address object.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 403 | `FORBIDDEN` | Accessing another customer's address |
| 404 | `NOT_FOUND` | Customer or address not found |
| 422 | `VALIDATION_ERROR` | Invalid body |

---

## DELETE /customers/:id/addresses/:addressId

Delete an address from a customer's address book.

**Auth:** `customer`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Customer UUID |
| `addressId` | `string` | Address UUID |

### Response `204`

No content.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 403 | `FORBIDDEN` | Accessing another customer's address |
| 404 | `NOT_FOUND` | Customer or address not found |
