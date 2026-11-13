import { selected } from "../contract.mjs";

// A chat app's history for the live store tests: users writing in English and Arabic, conversations
// of different lengths across forty days, system prompts and tool results the reader must leave out.
const EN = ["Where is my order 1042?", "Can I change the delivery address?", "What does the premium plan include?", "My card was charged twice.", "How do I reset my password?", "Is the blue one back in stock?"];
const AR = ["أين طلبي رقم ١٠٤٢؟", "هل يمكنني تغيير عنوان التوصيل؟", "ما الذي تتضمنه الباقة المميزة؟", "تم خصم المبلغ مرتين من بطاقتي.", "كيف أعيد تعيين كلمة المرور؟"];
const REPLY_EN = ["It left our warehouse yesterday and arrives Thursday.", "Yes, until it ships. Which address should I use?", "Unlimited projects and priority support.", "I see both charges; the second is refunded within five days."];
const REPLY_AR = ["غادر طلبك المستودع أمس ويصل يوم الخميس.", "نعم، قبل الشحن. ما العنوان الجديد؟", "مشاريع غير محدودة ودعم ذو أولوية."];
const DAY = 86_400_000;

function random(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1_664_525 + 1_013_904_223) >>> 0; return s / 2 ** 32; };
}

// { conversations: [{ id, user, messages: [{ role, text, at }] }] }, times in ms, oldest message first.
// `extra` messages (a system prompt, a tool result) carry role "system" or "tool".
export function chats({ count = 80, now = Date.now(), seed = 7 } = {}) {
  const r = random(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const conversations = [];
  for (let i = 0; i < count; i += 1) {
    const arabic = i % 3 === 0;
    const user = `user-${1 + (i % 9)}`;
    let at = now - Math.floor(r() * 40 * DAY) - 3_600_000;
    const messages = [{ role: "system", text: "You are the shop's assistant.", at }];
    const turns = 1 + Math.floor(r() * 6);
    for (let t = 0; t < turns; t += 1) {
      at += 1_000 + Math.floor(r() * 120_000);
      messages.push({ role: "user", text: `${pick(arabic ? AR : EN)} (${i}.${t})`, at });
      if (t === 1) { at += 500; messages.push({ role: "tool", text: '{"order":"1042","status":"shipped"}', at }); }
      at += 1_000 + Math.floor(r() * 30_000);
      messages.push({ role: "assistant", text: `${pick(arabic ? REPLY_AR : REPLY_EN)} (${i}.${t})`, at });
    }
    conversations.push({ id: `conv-${String(i).padStart(3, "0")}`, user, messages });
  }
  return conversations;
}

// The same conversations as Cortad receives them from --stdin.
export const asSent = (conversations, cap, now = Date.now()) => selected(conversations.map((c) => ({
  id: c.id, user: c.user, messages: c.messages.map((m) => ({ ...m, at: new Date(m.at).toISOString() })),
})), { key: "ct_ing_test", cap, now }).conversations;

export const flatMessages = (conversations) => conversations.flatMap((c) => c.messages.map((m, n) => ({ conversation: c.id, user: c.user, n, ...m })));
