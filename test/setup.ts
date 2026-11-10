import { timingSafeEqual } from "node:crypto";

// Node Web Crypto lacks this Workers extension. Use Node's native comparator
// for unit tests; the deployed application calls the Workers implementation.
Object.defineProperty(crypto.subtle, "timingSafeEqual", {
  value: timingSafeEqual,
  configurable: true,
  writable: true,
});
