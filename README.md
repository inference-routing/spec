# Inference Routing Protocol (IRP)

**Status:** `0.1.0-draft`. Open for comment; expect breaking changes.

An open wire protocol for asking a router *where* an LLM request should run.

## Why

Model routing — sending each request to the model that gives the best answer for
the money — is now offered by many products: hosted gateways with an "auto" model,
dedicated routing APIs, cloud-provider prompt routers, open-source gateways and
peer-to-peer inference networks. Each one invented its own request shape, its own
way of expressing a cost/quality preference, its own way of naming what it picked,
and its own way of reporting predicted cost.

The result is that a client written for one router cannot use another, a router
cannot be swapped without rewriting integrations, and routing decisions cannot be
compared across vendors. IRP defines one small, neutral contract for that exchange.

## What it routes across: candidates

IRP does not route across *models*. It routes across **candidates**: concrete
inference options the client could buy. A candidate is a model *delivered under
specific conditions*: a given seller or endpoint, at a given price, with a given
cache state.

The same model can therefore appear as several candidates:

```text
anthropic/claude-opus-5   via seller A   $15 / $75 per 1M     16k tokens already cached
anthropic/claude-opus-5   via seller B   $12 / $70 per 1M     cold
moonshotai/kimi-k3        via seller C   $0.6 / $2.5 per 1M   cold
```

These are three different choices with three different expected costs, and a
router should rank all three, not just the two models. This is what makes IRP fit
multi-provider gateways and open inference marketplaces, not only single-vendor
model pickers.

Models are named by their [OpenRouter](https://openrouter.ai/models) ID
(`author/slug`), the most widely used cross-vendor model naming, so a router
recognises the same model whichever seller offers it.

## Two modes

| | Suggest-only | Proxy |
|---|---|---|
| Endpoint | `POST /v1/model-routing` | `POST /v1/chat/completions` |
| The router | ranks candidates and returns the ranking | ranks, forwards the request to the winner, relays its completion |
| Who calls the candidate | the client | the router, forwarding the client's request |
| Typical fit | marketplaces and clients that pay sellers directly | gateways and drop-in "auto" models |

Both modes share the same building blocks: the same `routing` object in the
request and the same candidate object, so a router can serve both with one
ranking engine. Proxy-mode responses are standard completions with a single
extra member.

## Built on the OpenAI Chat Completions format

IRP does not invent a prompt format. The request being routed is a standard
[OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)
body: `messages`, `tools`, `max_tokens` and so on, passed through unchanged. Every
client that can call an OpenAI-compatible API already produces it, and the router
sees exactly what the model will see: system prompt, history, tools and images.

The protocol itself is described with [OpenAPI 3.1](openapi.yaml) and
[JSON Schema 2020-12](schemas/), so client and server code can be generated from it.

## Suggest-only mode

The client sends the request it wants to run and the candidates it is willing to
use. The router returns them ranked, with predictions. The client then calls the
winner itself.

**Request:** `POST /v1/model-routing`

```jsonc
{
  "request": {                         // OpenAI Chat Completions body, unchanged
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Summarise the attached contract." }
    ],
    "max_tokens": 4096
  },
  "routing": {
    "cqt": 5,                          // cost/quality trade-off: 0 = best quality, 10 = cheapest
    "candidates": [
      {
        "id": "opus@seller-a",
        "model": "anthropic/claude-opus-5",
        "pricing": { "input": 15, "cache_read": 1.5, "output": 75 },   // USD per 1M tokens
        "expected_usage": { "cache_read_tokens": 16000 }               // warm: used on earlier turns
      },
      {
        "id": "opus@seller-b",         // same model, cheaper seller, cold cache
        "model": "anthropic/claude-opus-5",
        "pricing": { "input": 12, "cache_read": 1.2, "output": 70 }
      },
      {
        "id": "kimi@seller-c",
        "model": "moonshotai/kimi-k3",
        "pricing": { "input": 0.6, "cache_read": 0.15, "output": 2.5 }
      }
    ]
  }
}
```

**Response:** `200 OK`

```jsonc
{
  "id": "mr_01J9Z3",
  "object": "model_routing",
  "created": 1790000000,
  "router": { "id": "example-router", "version": "2026-09-30" },
  "ranked": [                          // best first for the requested cqt
    {
      "candidate_id": "kimi@seller-c",
      "expected_quality": 0.93,
      "expected_cost_usd": 0.0122,
      "expected_usage": { "input_tokens": 18422, "cache_read_tokens": 0, "output_tokens": 450 }
    },
    {
      "candidate_id": "opus@seller-a",
      "expected_quality": 0.97,
      "expected_cost_usd": 0.0963,
      "expected_usage": { "input_tokens": 18422, "cache_read_tokens": 16000, "output_tokens": 480 }
    },
    {
      "candidate_id": "opus@seller-b",
      "expected_quality": 0.97,
      "expected_cost_usd": 0.2547,
      "expected_usage": { "input_tokens": 18422, "cache_read_tokens": 0, "output_tokens": 480 }
    }
  ]
}
```

Seller B has lower per-token prices than seller A, but seller A already holds this
conversation in its prompt cache, so the same model costs $0.096 there against
$0.255 at seller B. Ranking models alone would miss this.

The client sends `request` to the seller behind `kimi@seller-c`, setting `model`
to whatever name that seller uses for the model. If that call fails, it tries the
next entry.

`cqt` uses the same 0–10 scale and direction as the `cost_quality_tradeoff`
parameter OpenRouter introduced for its Auto Router: 0 picks the most capable model
regardless of price, 10 lets the cheapest model win
([announcement](https://x.com/OpenRouter/status/2061476882470580329)).

## Proxy mode

The client calls the router as if it were an ordinary OpenAI-compatible endpoint
and adds a `routing` object (OpenAI SDKs send extra fields through `extra_body`).
The router picks a candidate from its own pool, forwards the request to it and
relays the candidate's completion unchanged, except that `model` names the model
that answered and one extra member, `routing.candidate_id`, names the candidate.

**Request:** `POST /v1/chat/completions`

```jsonc
{
  "model": "auto",                     // the router's routing alias
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Summarise the attached contract." }
  ],
  "max_tokens": 4096,
  "routing": {
    "cqt": 7,                          // lean towards cheaper
    "candidates": [                    // optional: limit to these router-listed candidates
      { "id": "opus@seller-a" },
      { "id": "kimi@seller-c" }
    ]
  }
}
```

**Response:** `200 OK`

```jsonc
{
  "id": "chatcmpl-8f2c",
  "object": "chat.completion",
  "created": 1790000000,
  "model": "moonshotai/kimi-k3",       // the model that actually ran
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "The contract sets out…" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 18422,
    "completion_tokens": 431,
    "total_tokens": 18853,
    "prompt_tokens_details": { "cached_tokens": 0 }
  },
  "routing": { "candidate_id": "kimi@seller-c" }   // the only addition
}
```

The candidates a proxy router can forward to are listed at `GET /v1/model-routing/candidates`.
A client that sends nothing but `"model": "auto"` gets routed with the defaults.

## What it does not cover: trust

IRP assumes each candidate is what it claims to be: that it really runs the stated
model, at the stated price, unmodified. Verifying that (detecting a substituted or
quantized model, a seller misreporting usage) is a separate problem, handled by
reputation systems, attestation or verifier services outside this protocol.
Clients apply such signals themselves, by only sending candidates they trust. In
suggest-only mode the router never learns which seller is behind a candidate.

Also out of scope: payment and billing, authentication, and how candidates are
discovered.

## Repository layout

| Path | Contents |
|---|---|
| [`SPEC.md`](SPEC.md) | The normative specification |
| [`openapi.yaml`](openapi.yaml) | OpenAPI 3.1 description of all endpoints |
| [`schemas/`](schemas/) | JSON Schema 2020-12 for every object |
| [`examples/`](examples/) | Complete request/response examples, validated in CI |

Validate the examples against the schemas:

```sh
npm install
npm test
```

## Contributing

Open an issue or discussion for design questions, and a pull request for concrete
changes to the spec, schemas or examples. Changes to `SPEC.md` must keep the
schemas and examples in sync.

## License

Specification text, schemas and examples are licensed under the
[Apache License 2.0](LICENSE).
