import { spawnSync } from "node:child_process";

// What a conversation brought in from before is cleared of on this machine, before anything about it
// is written down or sent. The first patterns are the ones the SDK and Cortad's own second pass use,
// so the three agree on what a key or a card looks like; the rest are what a student writes about
// themself in Arabic or English: local phone formats, national ID and exam seat numbers, dates of
// birth, social handles, street addresses. A name inside a sentence matches no rule: that is what the
// person's own step (redactWith below) is for.
// ponytail: third copy of the key patterns (SDK, backend src/ingest/redact.ts, here); publish one module when they drift.
const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
  + "|يناير|فبراير|مارس|[أإا]بريل|مايو|يونيو|يوليو|[أا]غسطس|سبتمبر|[أا]كتوبر|نوفمبر|ديسمبر"
  + "|كانون الثاني|شباط|[آا]ذار|نيسان|[أا]يار|حزيران|تموز|[آا]ب|[أا]يلول|تشرين ال[أا]ول|تشرين الثاني|كانون ال[أا]ول";
const YEAR = "(?:19|20)\\d{2}";
const SOCIAL = "instagram\\.com|instagr\\.am|snapchat\\.com|tiktok\\.com|t\\.me|telegram\\.me|facebook\\.com|fb\\.com|fb\\.me|twitter\\.com|x\\.com|wa\\.me|discord\\.gg|threads\\.net|youtube\\.com";
const APP = "snap(?:chat)?|insta(?:gram)?|tik ?tok|telegram|discord|twitter|سناب(?: ?شات)?|[اإ]نستا(?:غرام|جرام)?|تيك ?توك|تل[يغج]+رام|ديسكورد";
const ID_WORDS = "national (?:id|number|no\\.?)|id (?:number|no\\.?)|student (?:id|number|no\\.?)|school id|seat (?:number|no\\.?)|exam number|passport(?: number| no\\.?)?"
  + "|ال?رقم ال?وطني|رقمي الوطني|رقم (?:ال)?هوي[ةت]ي?|البطاقة (?:الوطنية|الموحدة)|رقم البطاقة(?: الموحدة| الوطنية)?|رقم (?:ال)?جلوسي?|رقم جلوسي"
  + "|رقمي الامتحاني|ال?رقم الامتحاني|رقم (?:ال)?امتحاني?|رقم الطالب|ال?رقم الجامعي|رقمي الجامعي|رقم (?:ال)?جوازي?";
const BIRTH = "born(?: (?:in|on))?|date of birth|d\\.?o\\.?b\\.?|birthday(?: is)?|مواليد|تاريخ (?:الميلاد|ميلادي)|ميلادي|ولدت(?: (?:في|سنة|عام))?|مولودة?(?: (?:في|سنة|عام))?";
const AR_PLACE = "شارع|حي|عمار[ةه]|بناي[ةه]|مبنى|منزل|بيت|دار|محل[ةه]|زقاق|شق[ةه]|طابق|فيلا";
const NOT_DIGIT = "(?<![\\d+])";
const END = "(?!\\d)";
const digits = (match) => match.replace(/\D/g, "").length;

// [label, pattern, valid]. A pattern with a group named v takes out only that group, so "my seat
// number is [redacted:id]" still says what was there. Order matters: a date before a phone, a card
// before an ID run, an email before a handle.
const PATTERNS = [
  ["key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["aws", /\b(?:AKIA|ASIA|AIDA|AROA|AGPA)[0-9A-Z]{16}\b/g],
  ["github", /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g],
  ["slack", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["gcp", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["apikey", /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g],
  ["auth", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi],
  ["url-cred", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/g],
  ["social", new RegExp(`(?<![\\w.-])(?:https?://)?(?:www\\.|m\\.|vm\\.)?(?:${SOCIAL})/[^\\s,،)]+`, "gi")],
  ["email", /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu],
  ["handle", /(?<![\p{L}\p{N}_.@])@[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?/gu],
  ["handle", new RegExp(`(?<![\\p{L}])(?:${APP})(?:\\s*(?:is|id|:|-|=|هو|حسابي|يوزري)\\s*|\\s+(?=[A-Za-z0-9_.]*[_.\\d]))(?<v>[A-Za-z0-9_.]{3,30})`, "giud")],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["date", new RegExp(`(?<![\\d/.-])(?:\\d{1,2}[/.-]\\d{1,2}[/.-]${YEAR}|${YEAR}[/.-]\\d{1,2}[/.-]\\d{1,2}|\\d{1,2}/\\d{1,2}/\\d{2})(?![\\d/])`, "g")],
  ["date", new RegExp(`(?<!\\d)\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTH})\\.?,?\\s+${YEAR}${END}`, "giu")],
  ["date", new RegExp(`(?<![\\p{L}])(?:${MONTH})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+${YEAR}${END}`, "giu")],
  ["birth", new RegExp(`(?<![\\p{L}])(?:${BIRTH})\\s*:?\\s*(?<v>\\d{1,4}(?:[/.-]\\d{1,2}){0,2}(?:[/.-]\\d{2,4})?)${END}`, "giud")],
  ["card", /\b\d(?:[ -]?\d){12,18}\b/g, (match) => luhn(match.replace(/[^0-9]/g, ""))],
  ["iban", /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g],
  ["id", new RegExp(`(?<![\\p{L}])(?:${ID_WORDS})\\s*(?:is|هو|تبعي|:|#|-)?\\s*(?<v>[A-Z]?\\d[\\d -]{2,}\\d)`, "giud")],
  ["phone", /\+\d[\d ()-]{6,}\d/g],
  ["phone", new RegExp(`${NOT_DIGIT}00[1-9][\\d ().-]{6,}\\d`, "g"), (match) => digits(match) >= 10 && digits(match) <= 15],
  ["phone", new RegExp(`${NOT_DIGIT}\\(?0\\d{1,3}\\)?[ .-]?\\d{2,4}(?:[ .-]?\\d{2,4}){1,3}${END}`, "g"), (match) => digits(match) >= 9 && digits(match) <= 11],
  ["phone", /\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g],
  ["phone", /(?<![\d-])\d{3}[ -]\d{4}(?![\d-])/g],
  ["id", /(?<![\d.])[A-Z]?\d{9,12}(?![\d.])/g],
  ["address", /\b\d{1,5}[A-Za-z]?\s+(?:[A-Za-z][\w'-]*\.?\s+){1,4}(?:street|road|avenue|lane|boulevard|drive)\b/gi],
  ["address", /\b\d{1,5}\s+(?:[A-Z][\w'-]*\s+){1,4}(?:St|Rd|Ave|Ln|Blvd|Dr)\b\.?/g],
  ["address", /\b(?:street|st\.|road|building|bldg|apartment|apt|flat|house|villa|block)\s*(?:no\.?|number|#)?\s*\d{1,5}[A-Za-z]?\b/gi],
  ["address", new RegExp(`(?<![\\p{L}])(?:${AR_PLACE})\\s+(?:رقم\\s*)?(?:\\p{L}+\\s+){0,3}?\\d{1,5}${END}`, "gu")],
  ["address", /(?<![\p{L}])م\s?\d{1,4}\s+ز\s?\d{1,4}(?:\s+د\s?\d{1,4})?/gu],
  ["ip", /\b\d{1,3}(?:\.\d{1,3}){3}\b/g],
  ["token", /[A-Za-z0-9_-]{32,}/g],
];

// Arabic-Indic and Persian digits read as 0 to 9. Each is one UTF-16 unit, like its ASCII digit, so a
// match found in the plain copy sits at the same place in the text itself.
const plain = (text) => text.replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) % 16));

// The text with each match replaced by what it was, and how many there were. `values`: this
// machine's own credential-shaped env values, which match no pattern when they are a password.
export function scrub(text, values = []) {
  let hits = 0;
  let out = text;
  for (const value of values) {
    const parts = out.split(value);
    hits += parts.length - 1;
    out = parts.join("[redacted:env]");
  }
  for (const [label, pattern, valid] of PATTERNS) {
    let next = "";
    let last = 0;
    for (const m of plain(out).matchAll(pattern)) {
      if (valid && !valid(m[0])) continue;
      const [start, end] = m.indices?.groups?.v ?? [m.index, m.index + m[0].length];
      next += `${out.slice(last, start)}[redacted:${label}]`;
      last = end;
      hits += 1;
    }
    out = next + out.slice(last);
  }
  return { text: out, hits };
}

// A tool call's arguments or a tool's result, cleared before it is written out as text: a value under
// a name that says what it is (phone, password, national_id) goes whole, every other string by the
// patterns above. JSON text is opened first, so a result kept as a string is read the same way.
const PRIVATE_KEY = /^(?:.*(?:password|passwd|secret|token|api_?key|phone|mobile|email|e_?mail|address|street|national_?id|id_?number|passport|seat|ssn|dob|birth|first_?name|last_?name|full_?name|surname|guardian|parent))$|^(?:name|username|user_?name)$/i;
export function scrubValue(value, values = []) {
  if (typeof value === "string") {
    const s = value.trim();
    if (/^[[{]/.test(s)) { try { return JSON.stringify(scrubValue(JSON.parse(s), values)); } catch { /* text that starts with a bracket */ } }
    return scrub(value, values).text;
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, PRIVATE_KEY.test(k) && v != null && typeof v !== "object" ? `[redacted:${k}]` : scrubValue(v, values)]));
  }
  return value;
}

// The person's own redaction step, run on every text before anything is written or sent: `command`
// reads one JSON line per text ({"text": "..."}) on its input and writes the same number of lines
// back, in the same order, each with the text as it may leave this machine. Anything else stops the
// send: a step that failed is not a step that ran.
const HOOK_MS = 15 * 60_000;
export function redactWith(command, texts, run = spawnSync) {
  const input = texts.map((text) => JSON.stringify({ text })).join("\n");
  const done = run(command, { shell: true, input: `${input}\n`, encoding: "utf8", maxBuffer: 1 << 30, timeout: HOOK_MS, stdio: ["pipe", "pipe", "inherit"] });
  if (done.error) throw new Error(`${command} did not run: ${done.error.message}`);
  if (done.status !== 0) throw new Error(`${command} ended with code ${done.status ?? done.signal}`);
  const lines = String(done.stdout).split("\n").filter((line) => line.trim());
  if (lines.length !== texts.length) throw new Error(`${command} gave back ${lines.length} lines for ${texts.length}`);
  return lines.map((line, i) => {
    let value;
    try { value = JSON.parse(line); } catch { throw new Error(`${command} gave back line ${i + 1} that is not JSON`); }
    if (typeof value?.text !== "string") throw new Error(`${command} gave back line ${i + 1} with no text`);
    return value.text;
  });
}

function luhn(digitsOnly) {
  let sum = 0;
  let double = false;
  for (let i = digitsOnly.length - 1; i >= 0; i -= 1) {
    let value = digitsOnly.charCodeAt(i) - 48;
    if (double) { value *= 2; if (value > 9) value -= 9; }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}
