import assert from "node:assert/strict";
import { test } from "node:test";
import { exchangesOf, replyOf } from "./proof.mjs";

// Real shapes from one customer (2026-10-06): five flashcards were read as one card's back, and a quiz
// stream as one question's explanation, and the run failed both for not doing what was asked.

const cards = [
  { front: "ما العلاقة بين التكامل والتفاضل؟", back: "التكامل هو العملية العكسية للتفاضل." },
  { front: "أكمل: التكامل هو ______ للتفاضل.", back: "التكامل هو عكس التفاضل." },
  { front: "ما هو ثابت التكامل؟", back: "ثابت يضاف لأن مشتقة الثابت صفر." },
];
const quiz = {
  questions: [
    { question: "ما العلاقة بين التكامل والتفاضل؟", options: ["عمليتان متعاكستان", "عملية واحدة"], correct_answer: "عمليتان متعاكستان", explanation: "التكامل هو العملية العكسية للتفاضل." },
    { question: "ما ناتج تكامل الصفر؟", options: ["ثابت", "صفر"], correct_answer: "ثابت", explanation: "مشتقة أي ثابت صفر." },
  ],
};
const fenced = (doc) => `\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\``;
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
function generationStream(doc) {
  const text = fenced(doc);
  const events = [{ type: "status", message: "جاري إنشاء الاختبار..." }];
  for (let i = 0; i < text.length; i += 7) {
    if (i === 70) events.push({ type: "progress", count: 1, message: "تم إنشاء 1 سؤال..." });
    events.push({ type: "chunk", content: text.slice(i, i + 7) });
  }
  events.push({ type: "done", data: doc });
  return sse(events);
}
const exchange = (path, type, reply, modelSaid) => exchangesOf([
  { ex: "1.1", at: 1000, ms: 900, method: "POST", path, body: JSON.stringify({ content: "التكامل" }), status: 200, type, writes: type.includes("stream") ? 40 : 1, reply, sent: [] },
  { call: { ex: "1.1", host: "api.fireworks.ai", model: "m", status: 200, reply: modelSaid } },
])[0];

test("a JSON list of flashcards is the reply whole, every card with its fields in order", () => {
  const body = JSON.stringify({ success: true, data: { flashcards: cards }, language: "arabic", count: 3, timestamp: "2026-10-06T03:00:00.000Z" });
  const reply = replyOf(exchange("/v1/flashcards", "application/json", body, JSON.stringify({ flashcards: cards })));
  for (const card of cards) for (const line of [`front: ${card.front}`, `back: ${card.back}`]) assert.ok(reply.text.includes(line), reply.text);
  assert.ok(reply.text.indexOf(cards[2].front) > reply.text.indexOf(cards[1].back));
  assert.doesNotMatch(reply.text, /success|timestamp/);
  assert.match(reply.path, /^data\.flashcards\.\d\.(?:front|back)$/, "the run reads the same document from the leaf it is banked at");
});

test("a stream of a fenced JSON quiz is the reply whole, and its status and progress events are not", () => {
  const reply = replyOf(exchange("/v1/quiz/stream", "text/event-stream", generationStream(quiz), fenced(quiz)));
  for (const q of quiz.questions) {
    for (const line of [`question: ${q.question}`, `- ${q.options[0]}`, `- ${q.options[1]}`, `correct_answer: ${q.correct_answer}`, `explanation: ${q.explanation}`]) assert.ok(reply.text.includes(line), reply.text);
  }
  assert.doesNotMatch(reply.text, /جاري إنشاء|تم إنشاء|```/);
  assert.equal(reply.stream, true);
});

test("a mindmap stream is its nodes and edges, not one edge's target", () => {
  const map = { nodes: [{ id: "root", label: "Photosynthesis" }, { id: "light", label: "Light Energy" }, { id: "chem", label: "Chemical Energy" }], edges: [{ source: "root", target: "light" }, { source: "root", target: "chem" }] };
  const reply = replyOf(exchange("/v1/mindmap/stream", "text/event-stream", generationStream(map), fenced(map)));
  for (const line of ["label: Photosynthesis", "label: Light Energy", "label: Chemical Energy", "source: root", "target: chem"]) assert.ok(reply.text.includes(line), reply.text);
});

test("a chat envelope with one answer is still its answer field", () => {
  const said = "Integration reverses differentiation.";
  const reply = replyOf(exchange("/v1/chat", "application/json", JSON.stringify({ reply: said, sources: [{ title: "Unit two notes", text: "Integration is the reverse of differentiation." }] }), said));
  assert.deepEqual([reply.text, reply.path], [said, "reply"]);
  const streamed = replyOf(exchange("/v1/chat/stream", "text/event-stream", sse([{ type: "status", message: "Thinking about it" }, { type: "chunk", content: "Hello " }, { type: "chunk", content: "there." }, { type: "done" }]), "Hello there."));
  assert.equal(streamed.text, "Hello there.");
});
