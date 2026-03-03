INSERT OR IGNORE INTO users (
  id,
  email,
  password_hash,
  role,
  stripe_customer_id,
  created_at,
  updated_at
) VALUES (
  '00000000-0000-0000-0000-00000000a001',
  'system+missing-address@local.invalid',
  '',
  'customer',
  NULL,
  datetime('now'),
  datetime('now')
);
--> statement-breakpoint
INSERT OR IGNORE INTO customers (
  id,
  user_id,
  first_name,
  last_name,
  phone,
  created_at
) VALUES (
  '00000000-0000-0000-0000-00000000a002',
  '00000000-0000-0000-0000-00000000a001',
  'Missing',
  'Address',
  NULL,
  datetime('now')
);
--> statement-breakpoint
INSERT OR IGNORE INTO addresses (
  id,
  customer_id,
  type,
  street,
  city,
  state,
  postal_code,
  country,
  is_default
) VALUES (
  '00000000-0000-0000-0000-00000000a003',
  '00000000-0000-0000-0000-00000000a002',
  'shipping',
  'Missing address',
  'No city',
  NULL,
  '00000',
  'XX',
  0
);
