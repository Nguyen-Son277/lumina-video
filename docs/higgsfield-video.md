# Higgsfield Seedance 2.5 video

Seedance 2.5 runs on the Higgsfield asynchronous request API. It is a third video API style next to the [OI]-compatible and Agnes styles, selected per model with `videoApiStyle: 'higgsfield'`.

## Setup

1. In **API & Models**, add a provider, choose protocol **Higgsfield · Seedance 2.5** and paste the complete `KEY_ID:KEY_SECRET` value into the single **Higgsfield API credential** field. Do not split the value into two fields. Use the same full format when adding or replacing a key; leaving it blank while editing keeps the existing key.
2. The application trims outer whitespace, validates the format, encrypts the complete value with the application master key and sends `Authorization: Key KEY_ID:KEY_SECRET`. Neither part is returned to the browser again. Never paste a real credential into chat or logs; revoke any credential that was exposed.
3. Base URL defaults to `https://api.higgsfield.ai`. Model `bytedance/seedance-2.5` is created automatically with `video_api_style = higgsfield`.
4. There is no free credential test. **Test** and **Sync** are rejected for this protocol so that configuring a provider never submits a paid request; credentials are verified by the first generation you start.

## Modes

| | Text to video | Image to video |
| --- | --- | --- |
| Endpoint | `POST /bytedance/seedance-2.5/text-to-video` | `POST /bytedance/seedance-2.5/image-to-video` |
| Prompt | Required, nonblank | Optional; blank is omitted from the body |
| Frames | Rejected | `image_url` required, `end_image_url` optional |
| `aspect_ratio` | `16:9` `4:3` `1:1` `3:4` `9:16` `21:9` (default `16:9`) | Not sent |
| `output_format` | `mp4` (default) or `mov` | Not sent |

Both modes send `duration` (integer 4–30, default 5), `resolution` (`480p`/`720p`/`1080p`, default `720p`), `bitrate_mode` (`standard`/`high`, default `high`) and `generate_audio` (default `true`). Unsupported fields are rejected instead of being dropped silently. Image-to-video never receives library reference images implicitly: the user picks the start and end frame explicitly.

## Input frames

A frame is one of: an uploaded file, an existing image asset from the library, or a public HTTPS URL.

Uploaded files and assets are not exposed publicly. At submit time the backend asks Higgsfield for a presigned upload URL, PUTs the bytes with the returned `upload_headers` and then sends the returned `public_url` as the frame. The presigned request is sent without any provider credential, only allow-listed `Content-Type`/`x-amz-*`/`x-goog-*`/`x-ms-*` headers are forwarded, redirects are refused and private or rebinding addresses are blocked. Uploading a frame therefore shares that image with Higgsfield storage; the UI says so before the job starts.

The uploaded URL is persisted with the job. If the process restarts mid-job the frame is not uploaded twice.

## Async lifecycle, retry and idempotency

- A stable `Idempotency-Key` and the immutable endpoint/body/frame URLs are persisted **before** the first POST.
- A timeout, network error or 5xx leaves the outcome unknown. The worker replays the *same* key, endpoint and body (never a new key), up to 6 sends and a 10-minute deadline, with 2–30 s jittered backoff and `Retry-After` respected. Exhausting that budget ends in `unknown`; the UI tells the user not to create another video.
- 401/403/404/422 stop the job with the provider's reason. 423/429 are treated as temporary.
- `status_url` and `cancel_url` are accepted only when they match the pinned origin and the expected `/requests/{request_id}/{status|cancel}` path; otherwise the job fails closed.
- Polling starts at 2 s, grows ×1.5 up to 10 s with jitter. Upstream `queued` is shown as "in queue" while the local status stays `running`, so the worker never resubmits.
- `completed` downloads the video with **no** provider credential, verifies it is MP4/MOV by magic bytes and stores it in the app's own media storage. `failed`, `nsfw` and `canceled` are terminal and run no logo post-processing.
- After a restart: a job with a request ID keeps polling; a job that was POSTed but lost its receipt replays the immutable request; a job that never POSTed continues with upload and submit.

## Stopping a queued video

The **Stop** button appears while a video can still be stopped.

- Not yet sent: the row is cancelled atomically with no provider call.
- Sent but still `queued` upstream: the cancel is recorded and the single worker calls the pinned cancel endpoint. HTTP 202 means cancelled, 400 means rendering already started and the job continues.
- Cancel requested during an in-flight submit: the request is reconciled with the same idempotency key first, then cancelled only if still queued.
- A cancel is never reported as successful while the outcome is unknown.

## Security notes

Provider-returned URLs are never used as authenticated request targets, so a malicious or compromised response cannot redirect the API key. Diagnostics redact the key ID, key secret, the joined credential and signed frame URLs. Higgsfield jobs pin one credential for upload, submit, replay, poll, download and cancel: the 401/403/429 key-failover used by other providers is disabled for this style, because idempotency keys are scoped per account and 403 can mean missing credit rather than a bad key.
