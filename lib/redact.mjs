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
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["card", /\b\d(?:[ -]?\d){12,18}\b/g, (match) => luhn(match.replace(/[^0-9]/g, ""))],
  ["iban", /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g],
  ["phone", /\+\d[\d ()-]{6,}\d|\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g],
  ["ip", /\b\d{1,3}(?:\.\d{1,3}){3}\b/g],
  ["token", /[A-Za-z0-9_-]{32,}/g],
];

export function scrub(text, values = []) {
  let hits = 0;
  let out = text;
  for (const value of values) {
    const parts = out.split(value);
    hits += parts.length - 1;
    out = parts.join("[redacted:env]");
  }
  for (const [label, pattern, valid] of PATTERNS) {
    out = out.replace(pattern, (match) => {
      if (valid && !valid(match)) return match;
      hits += 1;
      return `[redacted:${label}]`;
    });
  }
  return { text: out, hits };
}

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) { value *= 2; if (value > 9) value -= 9; }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}
