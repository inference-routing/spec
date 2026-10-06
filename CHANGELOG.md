# Changelog

Versions follow [Semantic Versioning](https://semver.org/). Before 1.0, any
change to the protocol bumps the minor version; editorial fixes bump the patch.
The version appears in `SPEC.md`, `README.md`, `openapi.yaml` and `package.json`.

## 0.3.0-draft (2026-10-06)

Breaking:

- `cqt` is renamed `cost_quality_tradeoff`, the name Not Diamond and OpenRouter use
  for the same 0–10 scale. Scale, direction and default (`5`) are unchanged.

Added:

- `extra`: one namespaced member, allowed on every IRP object, where clients
  and routers put data the spec does not define. Senders add nothing else outside
  the spec's fields.
- Authors: Marco De Rossi (Levanto Labs), Shahaf Antwarg (AntSeed), Alexander Ludwig (AntSeed).

## 0.2.1-draft (2026-10-06)

Clarified:

- In suggest-only mode, the client decides how much of the conversation
  `request.messages` contains: the whole conversation, the last few turns or only
  the latest message. Predictions describe the request as sent. In proxy mode the
  request is forwarded to the model, so it carries the whole conversation. No new
  fields.

## 0.2.0-draft (2026-10-06)

Breaking:

- Suggest-only ranking moves from `POST /v1/model-routing` to
  `POST /v1/routing/rank`. The response `object` is now `"routing.ranking"`.
- `GET /v1/routing/models` replaces `GET /v1/model-routing/candidates` and serves
  both modes: the models a router can score, plus, for proxy routers, the router's
  own candidates for each model.

Added:

- Optional `reasoning_effort` on ranked entries: the suggested value for the Chat
  Completions `reasoning_effort` parameter when calling that candidate.

Changed:

- In ranked entries, only `candidate_id` is required. `expected_quality`,
  `expected_cost_usd` and `expected_usage` are optional.

## 0.1.0-draft (2026-10-03)

First public draft: suggest-only and proxy modes, candidates, `cqt`, JSON Schemas,
OpenAPI description and validated examples.
