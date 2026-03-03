# Orders

Order lifecycle from creation through delivery and refund. Stock is reserved atomically on order creation and released on cancellation.

---

## GET /orders

List orders with pagination. Customers see only their own orders. Admins see all orders and can filter by additional parameters.

**Auth:** `customer`

### Query Parameters

| Parameter | Type | Auth Required | Description |
|---|---|---|---|
| `status` | `string` | Admin | Filter by status: `pending`, `confirmed`, `processing`, `shipped`, `delivered`, `cancelled`, `refunded` |
| `customerId` | `string` | Admin | Filter by customer UUID |
| `from` | `string` | Admin | ISO date string, orders created on or after this date |
| `to` | `string` | Admin | ISO date string, orders created on or before this date |
| `page` | `number` | — | Default `1` |
| `pageSize` | `number` | — | Default `20` |

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
  "meta": { "page": 1, "pageSize": 20, "total": 8 }
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `string` | Current order status |
| `subtotal` | `number` | Sum of line item totals |
| `tax` | `number` | Tax amount (currently `0`) |
| `shippingCost` | `number` | Shipping cost (currently `0`) |
| `total` | `number` | `subtotal + tax + shippingCost` |
| `refundedAmount` | `number` | Cumulative amount refunded |
| `lineCount` | `number` | Number of line items |

---

## GET /orders/:id

Get a single order with its line items and associated shipments. The owner or any admin may access.

**Auth:** `customer`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Order UUID |

### Response `200`

All order fields plus:

| Field | Type | Description |
|---|---|---|
| `lines` | `array` | Order line items |
| `lines[].id` | `string` | Line UUID |
| `lines[].productId` | `string` | Product UUID |
| `lines[].variantId` | `string\|null` | Variant UUID if applicable |
| `lines[].quantity` | `number` | Quantity ordered |
| `lines[].unitPrice` | `number` | Price at time of order |
| `lines[].lineTotal` | `number` | `unitPrice * quantity` |
| `shipments` | `array` | Associated shipments (see [logistics.md](./logistics.md)) |

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 403 | `FORBIDDEN` | Authenticated as a different customer |
| 404 | `NOT_FOUND` | Order not found |

---

## POST /orders

Create a new order. Validates product availability and stock, calculates totals, and runs an atomic DB transaction (insert order + lines + decrement stock).

**Auth:** `customer`

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `lines` | `array` | Yes | Min 1 item |
| `lines[].productId` | `string` | Yes | Must be an active product |
| `lines[].variantId` | `string` | No | Must belong to the product |
| `lines[].quantity` | `integer` | Yes | Must be positive |
| `shippingAddressId` | `string` | Yes | Must belong to the authenticated customer |
| `notes` | `string` | No | Optional order notes |

### Response `201`

Full order object with embedded `lines` array.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Customer profile not found |
| 422 | `VALIDATION_ERROR` | Missing fields, product not found or not active, insufficient stock, address not found or not owned |

---

## PUT /orders/:id/status

Update order status. Admin only. Only valid transitions are permitted.

**Auth:** `admin`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Order UUID |

### Valid Status Transitions

| From | Allowed transitions |
|---|---|
| `pending` | `confirmed`, `cancelled` |
| `confirmed` | `processing`, `cancelled` |
| `processing` | `shipped`, `cancelled` |
| `shipped` | `delivered` |
| `delivered` | `refunded` |
| `cancelled` | _(none)_ |
| `refunded` | _(none)_ |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | `string` | Yes | Target status (see valid transitions) |

### Response `200`

Updated order object.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Order not found |
| 422 | `VALIDATION_ERROR` | Invalid or disallowed status transition |

---

## DELETE /orders/:id

Cancel an order. Restores stock atomically.

- **Admin:** can cancel any order in `pending`, `confirmed`, or `processing` status.
- **Customer:** can cancel only their own `pending` orders within 30 minutes of creation.

**Auth:** `customer`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Order UUID |

### Response `204`

No content.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 403 | `FORBIDDEN` | Order already shipped, too late to cancel, or not owner |
| 404 | `NOT_FOUND` | Order not found |

---

## POST /orders/:id/refund

Apply a (partial or full) refund amount to a delivered or already-partially-refunded order. When `refundedAmount >= subtotal`, the order status automatically becomes `refunded`. Admin only.

**Auth:** `admin`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Order UUID |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `amount` | `number` | Yes | Refund amount, must be positive |
| `reason` | `string` | Yes | Reason for the refund |

### Response `200`

Updated order object with new `refundedAmount` and potentially updated `status`.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Order not found |
| 422 | `VALIDATION_ERROR` | Order not in `delivered` or `refunded` status |
