// Validates every example against its schema, then checks the SPEC rules that
// JSON Schema cannot express across the matching request/response examples.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
for (const file of readdirSync(join(root, 'schemas'))) ajv.addSchema(read(`schemas/${file}`));

const cases = {
  'suggest-request.json': 'model-routing-request.schema.json',
  'suggest-response.json': 'model-routing-response.schema.json',
  'proxy-request.json': 'chat-completion-request.schema.json',
  'proxy-response.json': 'chat-completion-response.schema.json',
  'candidate-list.json': 'candidate-list.schema.json',
  'error-no-scorable-candidate.json': 'problem.schema.json',
};

let failed = false;
const fail = (msg) => { failed = true; console.error(`✗ ${msg}`); };

for (const file of readdirSync(join(root, 'examples'))) {
  const schemaId = cases[file];
  if (!schemaId) { fail(`examples/${file} has no schema mapping in scripts/validate.mjs`); continue; }
  const validate = ajv.getSchema(schemaId);
  if (validate(read(`examples/${file}`))) console.log(`✓ examples/${file}`);
  else fail(`examples/${file}\n${ajv.errorsText(validate.errors, { separator: '\n  ' })}`);
}

// Suggest-only (SPEC §3.2, §3.4, §4.2).
const request = read('examples/suggest-request.json');
const response = read('examples/suggest-response.json');
const byId = new Map(request.routing.candidates.map((c) => [c.id, c]));
if (byId.size !== request.routing.candidates.length) fail('suggest-request: duplicate candidate id');
const ranked = response.ranked.map((r) => r.candidate_id);
if (new Set(ranked).size !== ranked.length) fail('suggest-response: duplicate candidate_id');
for (const entry of response.ranked) {
  const candidate = byId.get(entry.candidate_id);
  if (!candidate) { fail(`suggest-response: unknown candidate_id ${entry.candidate_id}`); continue; }
  const u = entry.expected_usage;
  const p = candidate.pricing;
  const cost = ((u.input_tokens - u.cache_read_tokens) * p.input + u.cache_read_tokens * p.cache_read
    + u.output_tokens * p.output) / 1e6;
  if (Math.abs(cost - entry.expected_cost_usd) > 0.00005) {
    fail(`suggest-response: ${entry.candidate_id} expected_cost_usd ${entry.expected_cost_usd} != ${cost.toFixed(4)} from pricing`);
  }
}

// Proxy (SPEC §5.1, §5.2, §5.3).
const listed = new Map(read('examples/candidate-list.json').data.map((c) => [c.id, c]));
const proxyRequest = read('examples/proxy-request.json');
const proxyResponse = read('examples/proxy-response.json');
const allowed = proxyRequest.routing.candidates.map((c) => c.id);
for (const id of allowed) if (!listed.has(id)) fail(`proxy-request: candidate ${id} is not in candidate-list`);
const chosen = proxyResponse.routing.candidate_id;
if (!allowed.includes(chosen)) fail(`proxy-response: candidate_id ${chosen} was not allowed by the request`);
else if (listed.get(chosen).model !== proxyResponse.model) fail(`proxy-response: model does not match candidate ${chosen}`);

if (failed) process.exit(1);
console.log('All examples valid.');
