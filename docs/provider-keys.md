# Provider API key pools

Each provider has one shared Base URL and up to 10 encrypted API keys. In **API & Models**, edit the provider URL/name and open its key manager to add, replace, disable, test, delete or reorder keys.

## Selection

- **Priority / failover** (default): new requests start with the first available key by priority.
- **Round-robin**: new requests alternate among available keys in the saved order. Selection state is persisted across restarts.
- Disabled keys, keys rejected for authentication, and keys under rate-limit cooldown are skipped for new requests.
- Testing one key always tests that key directly, not a sibling.

## Charge safety

Automatic switching after a POST is allowed only after an explicit HTTP **401, 403 or 429** response. The application will not silently resubmit an image, video or chat request after a timeout, network disconnect, HTTP 5xx, or unreadable successful response: the upstream may have accepted and billed the first request.

Video polling, downloading and retry-download stay on the key and URL used to submit the job. Disabling/reordering keys does not move existing jobs. Replacing/deleting a key that is still required by an active or recoverable job is blocked; change its label/priority or disable it for future requests instead.

A 429 response temporarily pauses the key according to a valid Retry-After (up to one hour; otherwise 60 seconds). A 401/403 authentication failure skips the key until it is replaced or explicitly tested successfully.

## Secret handling

Keys are write-only and encrypted using the existing application master key. API responses expose only metadata and a masked suffix. Existing secrets are never loaded into edit forms. Leaving the secret blank while editing keeps it unchanged. A provider uses the same URL and model catalog for every key; keys can belong to separate upstream accounts, so polling never fails over to a different key.

The default language is English; all key-management labels and application-owned errors also support Tiếng Việt. Generated content and raw third-party diagnostics are not translated.
