# worker-model-catalog

Keeps the model catalogue in step with [models.dev](https://models.dev).

On each tick it asks for the published catalogue, conditionally on the ETag it
saw last, narrows the result to the providers this gateway can actually reach,
and upserts them.

Prices are US dollars per million tokens, matching the upstream.
