# Redis JSON compatibility fixtures

Handwritten, sanitized contracts verified first on Spring Boot 3.2.4 / Jackson 2 with a real Redis 7.4.11, then on each migration checkpoint. They contain no production data.

- route-boot3.json: normalized route including named-regex replacement syntax.
- runtime-boot3.json: all persisted runtime keys, with boolean and integer types.
- audit-boot3.json: current immutable audit event, long timestamp, Unicode, IPv6 and escaped quotes.
- audit-v1.json: older audit rows without eventId/outcome.

GatewayRedisIntegrationTest uses the application's injected mapper and persistence services. JSON-tree equality deliberately ignores property order but detects added/missing fields, null handling and numeric/string changes. Keep these fixtures stable when changing serializer defaults.
