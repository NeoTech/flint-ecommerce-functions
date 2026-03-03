/**
 * Route aggregator.
 *
 * Importing this module causes all api/* modules to execute, registering
 * their routes in the central registry before the first request is dispatched.
 *
 * Platform entry points (cloudflare.ts, vercel.ts) import this file.
 * Add new api/* imports here as each LOPC phase is implemented.
 */

// LOPC-05
import './api/auth.js';

import './api/products.js';
import './api/categories.js';
import './api/customers.js';
import './api/orders.js';
import './api/logistics.js';
import './api/discovery.js';

// LOPC-13
import './api/webhooks.js';
import './api/admin-sync.js';

// LOPC-19
import './api/admin-data-health.js';
