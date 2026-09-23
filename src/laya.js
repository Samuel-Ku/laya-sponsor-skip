// Shared local Laya integration.
// Used by the extension service worker and by the Node scripts under test/.
// The model runs locally (Apple Silicon, MLX); the extension talks to
// http://127.0.0.1:8765/judge served by ../laya-adblock/server/server.py.
// No cloud, no key.
//
// The server contract is narrow and worth spelling out, because everything here
// exists to satisfy it without touching that server:
//   POST /judge { model?, state, candidates[1..30], questions? }
//     -> { model, answers: { ad_i: { type: "noul", noul } }, probabilities[], usage, latencyMs }
// Only `page` and `candidates` from `state` reach the model, and every answer is
// read back as a `noul` probability under the key `ad_<i>`. So each transcript
// line travels as its own self-contained candidate card, and the questions array
// is always keyed the same way.

export const LAYA_ENDPOINT = "http://127.0.0.1:8765/judge";
export const LAYA_HEALTH_ENDPOINT = "http://127.0.0.1:8765/health";
export const DEFAULT_MODEL = "multilingual";

// The service refuses more than 30 candidates per request (see judge_request).
export const MAX_CANDIDATES_PER_REQUEST = 30;

/**
 * Build one judge request. `cards[i]` is the compact description of the thing
 * being judged and `questions[i]` is its Noul question, so the whole batch is a
 * single local call (speculative fan-out pattern).
 */
export function buildRequest({ model = DEFAULT_MODEL, state, candidates, questions }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("buildRequest: candidates must be a non-empty array");
  }
  if (candidates.length > MAX_CANDIDATES_PER_REQUEST) {
    throw new Error(`buildRequest: at most ${MAX_CANDIDATES_PER_REQUEST} candidates per request`);
  }
  if (!Array.isArray(questions) || questions.length !== candidates.length) {
    throw new Error("buildRequest: one question per candidate is required");
  }
  const keyed = {};
  questions.forEach((q, i) => {
    keyed[`ad_${i}`] = { type: "noul", instructions: q.instructions, criteria: q.criteria };
  });
  return { model, state, candidates, questions: keyed };
}

/** Extract the per-candidate probabilities from a response body. */
export function parseResponse(body, count) {
  const probabilities = [];
  for (let i = 0; i < count; i++) {
    const answer = body?.answers?.[`ad_${i}`];
    if (!answer || answer.type !== "noul" || typeof answer.noul !== "number") {
      throw new Error(`parseResponse: missing noul answer for candidate ${i}`);
    }
    probabilities.push(answer.noul);
  }
  return { model: body.model, probabilities, usage: body.usage, latencyMs: body.latencyMs };
}

const RETRYABLE = new Set([429, 529, 500, 502, 503, 504]);

function backoffMs(attempt) {
  return 300 * 2 ** attempt + Math.random() * 200;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postWithRetry({ url, payload, fetchImpl, attempts = 3 }) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      lastError = err;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (res.ok) return res.json();

    const text = await res.text().catch(() => "");
    lastError = new Error(`Local judge ${res.status}: ${text.slice(0, 300)}`);
    if (!RETRYABLE.has(res.status)) throw lastError;

    await sleep(backoffMs(attempt));
  }
  throw lastError;
}

/**
 * Judge one batch through the local server.
 * Returns { model, probabilities, usage, latencyMs }; probabilities[i] answers
 * questions[i] / candidates[i] with a probability in [0, 1].
 */
export async function judgeBatch({ state, candidates, questions, model, endpoint = LAYA_ENDPOINT, fetchImpl = globalThis.fetch }) {
  const payload = buildRequest({ model, state, candidates, questions });
  const t0 = Date.now();
  const body = await postWithRetry({ url: endpoint, payload, fetchImpl });
  const parsed = parseResponse(body, candidates.length);
  return { ...parsed, latencyMs: parsed.latencyMs ?? Date.now() - t0 };
}

/** GET /health – used by the popup's "Test" button and by the panel status line. */
export async function checkServer({ endpoint = LAYA_HEALTH_ENDPOINT, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(endpoint);
  if (!res.ok) throw new Error(`Local server ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** The heuristic stand-in answers everything with its DOM-ad vocabulary; we do better locally. */
export function isHeuristic(model) {
  return typeof model === "string" && model.includes("heuristic");
}
