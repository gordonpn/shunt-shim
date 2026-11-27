# Architecture Decision Records

| ID | Title | Status | Date | Decision |
| --- | --- | --- | --- | --- |
| [0001](0001-runtime-target-and-shared-request-bounds.md) | Runtime Target and Shared Request Bounds | Accepted | 2026-10-12 | Use Cloudflare Workers with bounded request handling. The MVP amendment specifies non-streaming JSON and a 60-second total deadline. |
| [0002](0002-model-fallback-and-provider-adaptation-strategy.md) | Model Fallback and Provider Adaptation Strategy | Accepted | 2026-10-13 | Use bounded primary-fallback routing. The MVP amendment uses Google AI Studio's OpenAI-compatible endpoint. |
| [0003](0003-unified-search-gateway-architecture.md) | Unified Search Gateway Architecture and Interface Boundaries | Accepted | 2026-11-15 | Extend the gateway with provider-neutral search contracts, fail-closed financial policy, and explicit provider boundaries. |
| [0004](0004-preview-compatible-quota-coordinator.md) | Preview-Compatible Quota Coordinator Boundary | Proposed | 2026-11-15 | Provisionally recommend an external coordinator Worker, subject to live preview, accounting, isolation, and rollback gates. |
