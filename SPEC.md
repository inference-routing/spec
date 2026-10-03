# Inference Routing Protocol: Specification

**Version:** `0.1.0-draft`

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as
described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they
appear in all capitals.

## 1. Terminology

- **Client:** the party that has an inference request to run.
- **Router:** the party that ranks candidates, and in proxy mode also forwards the
  request to one and relays its response.
- **Candidate:** one concrete inference option: a model delivered by a specific
  seller or endpoint, at a specific price, with a specific cache state. The same
  model offered by two sellers is two candidates.
- **Inference request:** an [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)
  request body.
- **CQT:** the cost/quality trade-off requested by the client (§3.1).

## 2. Conventions

- All bodies are JSON (`application/json`), except errors (§7) and streamed proxy
  responses (§5.2).
- All prices are in **USD per 1,000,000 tokens**. All costs are in **USD**.
- `input_tokens` always counts the whole prompt, *including* tokens read from
  cache. `cache_read_tokens` is the part of it served from cache.
- Receivers MUST ignore object members they do not recognise, so that later
  versions can add fields without breaking existing implementations.
- The protocol version is carried in the path (`/v1/`). Breaking changes require
  a new path version.

## 3. Shared objects

### 3.1 Routing object

Sent by the client in both modes.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `cqt` | integer, 0–10 | no, default `5` | Cost/quality trade-off. `0` asks for the best quality regardless of price, `10` for the cheapest acceptable candidate, `5` for a balance |
| `candidates` | array | suggest: yes · proxy: no | The candidates the router may choose from (§3.2, §5.1) |

The scale and direction are those of the `cost_quality_tradeoff` parameter that
OpenRouter introduced for its Auto Router, where 0 "always picks the most capable
model regardless of price" and 10 means "the cheapest model wins"
([announcement](https://x.com/OpenRouter/status/2061476882470580329)). OpenRouter
has since deprecated that parameter in favour of named `cost_tier` bands
([docs](https://openrouter.ai/docs/guides/routing/routers/auto-router)); IRP keeps
the numeric scale because it is finer-grained and already in use.

The router decides how to map `cqt` onto its own objective, but the mapping MUST be
monotonic: for the same request and candidates, raising `cqt` MUST NOT raise the
expected cost of the top-ranked candidate.

### 3.2 Candidate object

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string, 1–128 chars | yes | Identifier for this candidate. Unique within the list |
| `model` | string | yes | Model identifier. SHOULD be the model's OpenRouter ID (see below) |
| `pricing` | object | yes | Current prices: `input`, `cache_read`, `output`, each a number ≥ 0 |
| `expected_usage` | object | no | What the client already knows about usage. Currently only `cache_read_tokens`, an integer ≥ 0 |

`expected_usage.cache_read_tokens` is the number of prompt tokens the client expects
this candidate to serve from its prompt cache, typically observed from the
candidate's reported usage on earlier turns of the same conversation. A prompt cache
belongs to one model at one seller, so this value is per candidate. Absent means `0`.

`model` names the model in a namespace shared by clients and routers, so that a
router recognises the same model whichever seller offers it. It SHOULD be the
model's [OpenRouter](https://openrouter.ai/models) ID, in `author/slug` form (for
example `anthropic/claude-opus-5` or `moonshotai/kimi-k3`), which is the most widely
used cross-vendor model naming. For a model OpenRouter does not list, such as a
private fine-tune, any stable identifier MAY be used; a router that does not
recognise it omits the candidate (§4.2).

This is not necessarily the name the candidate's seller expects in its own API.
Mapping a candidate to its seller and the seller's model name is the client's job,
typically keyed by the candidate's `id`.

A router MUST NOT assume two candidates are interchangeable because they share a
`model`; they can differ in price, cache state and seller.

### 3.3 Router object

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Identifies the routing service |
| `version` | string | yes | Identifies the version of the ranking logic that produced the decision |

### 3.4 Ranked entry

| Field | Type | Required | Meaning |
|---|---|---|---|
| `candidate_id` | string | yes | The `id` of a candidate from the request |
| `expected_quality` | number, 0–1 | yes | Predicted quality of this candidate's answer |
| `expected_cost_usd` | number ≥ 0 | yes | Predicted total cost of running the inference request on this candidate |
| `expected_usage` | object | yes | Predicted `input_tokens`, `cache_read_tokens` and `output_tokens`, integers ≥ 0 |

`expected_quality` is calibrated by each router and is only comparable between
entries of the same response.

`expected_cost_usd` SHOULD equal the candidate's prices applied to `expected_usage`:

```text
(input_tokens − cache_read_tokens) × pricing.input
  + cache_read_tokens × pricing.cache_read
  + output_tokens × pricing.output
  ─────────────────────────────────────────── ÷ 1,000,000
```

## 4. Suggest-only mode

### 4.1 Request

`POST /v1/model-routing`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `request` | object | yes | The inference request, unchanged |
| `routing` | object | yes | Routing object (§3.1). `candidates` is required, with 1–512 entries |

The router MUST ignore `request.model` and `request.stream`; it does not forward
the request.

### 4.2 Response

`200 OK`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Decision identifier |
| `object` | string | yes | Always `"model_routing"` |
| `created` | integer | yes | Unix timestamp, seconds |
| `router` | object | yes | Router object (§3.3) |
| `ranked` | array | yes | Ranked entries (§3.4), best first for the requested `cqt` |

The router:

- MUST only return `candidate_id` values that appear in the request.
- MUST NOT return the same `candidate_id` twice.
- SHOULD include every candidate it can score, so that the client can apply its own
  limits (such as a per-request budget) to the predictions.
- MAY omit candidates it cannot score (for example, an unknown model).
- MUST return a `422` error (§7) instead of an empty `ranked` list.

### 4.3 Client behaviour

The client SHOULD send `request` to the first ranked candidate, setting `model` to
the name that candidate's seller expects (§3.2). If the call fails with a retryable
error, the client MAY continue down the list. The client SHOULD reject any response entry whose
`candidate_id` it did not send.

## 5. Proxy mode

### 5.1 Request

`POST /v1/chat/completions`

An ordinary inference request with one optional extra member, `routing` (§3.1).
The router MUST route the request when either:

- the body contains `routing`, or
- `model` equals one of the router's routing aliases. Routers SHOULD accept `"auto"`.

In proxy mode, `routing.candidates` is optional. When present, each entry needs only
`id`, which MUST match a candidate listed by the router (§5.3); the router MUST
restrict its choice to those candidates. When absent, every candidate the router
lists is eligible. Clients do not send pricing or usage in proxy mode; the router
already holds that information.

### 5.2 Response

A standard Chat Completions response, unchanged except for:

- `model` MUST be the model that actually produced the answer, not the routing alias,
  identified the same way as a candidate's `model` (§3.2).
- One extra member, `routing`, containing only `candidate_id`: the `id` of the
  candidate that produced the answer. `model` alone cannot say this when two
  candidates offer the same model.

```json
"routing": { "candidate_id": "kimi@seller-c" }
```

When `stream` is `true`, the response is a stream of `chat.completion.chunk` server-sent
events, as in the OpenAI API, and `routing` MUST appear on every chunk, like `model`.

The router MAY forward to further candidates when one fails before producing output.
It MUST NOT switch candidates after output has started streaming.

### 5.3 Listing candidates

`GET /v1/model-routing/candidates`

Returns the candidates a proxy router can forward to, as an OpenAI-style list:

```json
{ "object": "list", "data": [ { "id": "…", "model": "…", "pricing": { … } } ] }
```

Each entry is a candidate object (§3.2) without `expected_usage`.

## 6. Conversation state

The protocol is stateless. A client that wants to keep the same candidate across a
tool-call loop SHOULD reuse the previous decision itself rather than calling the
router again on every step. A client SHOULD call the router when a new user message
arrives.

## 7. Errors

Errors use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) Problem Details
(`application/problem+json`):

```json
{
  "type": "urn:irp:problem:no-scorable-candidate",
  "title": "No scorable candidate",
  "status": 422,
  "detail": "None of the 3 candidates use a model this router can score."
}
```

| Status | `type` | When |
|---|---|---|
| 400 | `urn:irp:problem:invalid-request` | Malformed body, duplicate candidate `id`, unknown proxy candidate |
| 402 | `urn:irp:problem:payment-required` | The routing service requires payment that was not made |
| 422 | `urn:irp:problem:no-scorable-candidate` | No candidate can be scored or, in proxy mode, reached |
| 503 | `urn:irp:problem:unavailable` | Temporarily unavailable. SHOULD include `Retry-After` |

In proxy mode, when every candidate the router tried failed, the router MAY instead
relay the last candidate's error in the OpenAI error format.

## 8. Security and privacy considerations

- In both modes the router receives the full inference request, including the
  conversation. Clients SHOULD only use routers they would trust with that content.
- Predictions are advisory. Actual cost and quality depend on the candidate, and
  this protocol does not verify that a candidate runs the model it claims (see
  [What it does not cover: trust](README.md#what-it-does-not-cover-trust)).
