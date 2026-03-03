# Logistics

Shipment record management linked to orders. Admins create and update shipment records; customers can look up their own shipments. There is also a public tracking lookup endpoint.

Creating a shipment automatically advances the related order to `shipped` status (unless already in a terminal state). Marking a shipment as `delivered` advances the order to `delivered`.

---

## GET /logistics/shipments

List all shipments with optional filters. Admin only.

**Auth:** `admin`

### Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `orderId` | `string` | Filter by order UUID |
| `status` | `string` | Filter by shipment status |
| `carrier` | `string` | Filter by carrier name |
| `page` | `number` | Default `1` |
| `pageSize` | `number` | Default `20` |

### Response `200`

```json
{
  "data": [
    {
      "id": "uuid",
      "orderId": "uuid",
      "carrier": "DHL",
      "trackingNumber": "1ZA123456789",
      "status": "in_transit",
      "shippedAt": "2025-01-02 10:00:00",
      "deliveredAt": null
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "total": 3 }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Shipment UUID |
| `orderId` | `string` | Related order UUID |
| `carrier` | `string` | Carrier name (e.g. `DHL`, `FedEx`) |
| `trackingNumber` | `string` | Carrier tracking number (unique) |
| `status` | `string` | See status values below |
| `shippedAt` | `string\|null` | Timestamp when tracking began |
| `deliveredAt` | `string\|null` | Timestamp when delivered |

#### Shipment Status Values

| Status | Description |
|---|---|
| `preparing` | Awaiting hand-off to carrier |
| `in_transit` | In transit to destination |
| `out_for_delivery` | With last-mile delivery |
| `delivered` | Delivered to recipient |
| `failed` | Delivery failed |

---

## GET /logistics/shipments/:id

Get a single shipment. Admins can access any; customers must own the related order.

**Auth:** `customer`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Shipment UUID |

### Response `200`

Single shipment object (same fields as list).

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 403 | `FORBIDDEN` | Customer does not own the order this shipment belongs to |
| 404 | `NOT_FOUND` | Shipment not found |

---

## POST /logistics/shipments

Create a new shipment for an order. Automatically advances the order to `shipped` unless already in `shipped`, `delivered`, `cancelled`, or `refunded` state.

**Auth:** `admin`

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `orderId` | `string` | Yes | Order UUID |
| `carrier` | `string` | Yes | Carrier name |
| `trackingNumber` | `string` | Yes | Must be globally unique |
| `status` | `string` | No | Default `preparing` |

### Response `201`

New shipment object.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Order not found |
| 409 | `CONFLICT` | Tracking number already exists |
| 422 | `VALIDATION_ERROR` | Invalid body |

---

## PUT /logistics/shipments/:id

Update a shipment's status or tracking info. Setting `status: "delivered"` automatically advances the related order to `delivered`.

**Auth:** `admin`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Shipment UUID |

### Request Body (all optional)

| Field | Type | Description |
|---|---|---|
| `status` | `string` | New shipment status (see status values above) |
| `trackingNumber` | `string` | Updated tracking number |
| `deliveredAt` | `string` | Delivery timestamp; defaults to current time when `status` is `delivered` |

### Response `200`

Updated shipment object.

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Shipment not found |
| 422 | `VALIDATION_ERROR` | Invalid body |

---

## GET /logistics/tracking/:trackingNumber

Public tracking lookup by carrier tracking number. Returns only carrier-safe fields (no internal IDs).

**Auth:** `none`

### Path Parameters

| Parameter | Type | Description |
|---|---|---|
| `trackingNumber` | `string` | The tracking number from the carrier |

### Response `200`

```json
{
  "data": {
    "carrier": "DHL",
    "status": "in_transit",
    "shippedAt": "2025-01-02 10:00:00",
    "deliveredAt": null
  },
  "meta": null,
  "error": null
}
```

| Field | Type | Description |
|---|---|---|
| `carrier` | `string` | Carrier name |
| `status` | `string` | Current shipment status |
| `shippedAt` | `string\|null` | Shipped timestamp |
| `deliveredAt` | `string\|null` | Delivered timestamp |

### Error Responses

| Status | Code | Condition |
|---|---|---|
| 404 | `NOT_FOUND` | Tracking number not found (returns 404 without revealing whether it exists in the system) |
