import { net } from "./net.mjs";
// One way to reach a model, used by the writer and by the judge. Their key or their machine; we are
// never required for either.
const OLLAMA = "http://localhost:11434/v1";

export function pickModel(said, what) {
  // Offline is not checked here. Resolving a model sends nothing, and a suite whose questions are
  // all answered by code or the trace never reaches one. The refusal belongs at the request, in
  // lib/net.mjs, so an airgapped run that needs no model still runs.
  if (!said || said === "cortad") return { kind: "cortad", name: "Cortad" };
  if (said.startsWith("ollama/")) return { kind: "openai", name: said, base: OLLAMA, model: said.slice("ollama/".length), key: "ollama" };
  const base = process.env.CORTAD_JUDGE_URL ?? "https://openrouter.ai/api/v1";
  const key = process.env.CORTAD_JUDGE_KEY;
  if (!key) throw new Error(`set CORTAD_JUDGE_KEY to the key for ${base}, or use --${what} ollama/<model> to run it on this machine`);
  return { kind: "openai", name: said, base, model: said, key };
}

export async function askJson(model, system, user, maxTokens) {
  const res = await net(`${model.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${model.key}` },
    body: JSON.stringify({
      model: model.model,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`${model.name} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const said = (await res.json())?.choices?.[0]?.message?.content ?? "";
  try { return JSON.parse(said); } catch { throw new Error(`${model.name} did not answer with JSON`); }
}
