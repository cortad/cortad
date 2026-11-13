const ARGS_MAX = 300;

const args = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? {});
  return s.length > ARGS_MAX ? `${s.slice(0, ARGS_MAX)}...` : s;
};
const named = (kind, name) => (typeof name === "string" && name ? `[${kind} ${name}]` : `[${kind}]`);
const IMAGE = /^(?:image|image_url|input_image|image_file)$/;
const FILE = /^(?:file|input_file|document)$/;
const AUDIO = /^(?:audio|input_audio)$/;

const INTERNAL = /^(?:thinking|redacted_thinking|reasoning|server_tool_use|mcp_tool_use|\w+_tool_result|(?:web_search|file_search|code_interpreter|image_generation|computer|mcp)_call)$/;
const tool = (value, clean) => (clean ? clean(value) : value);
const mime = (data) => String(data?.mimeType ?? data?.mime_type ?? "");

function partText(part, clean) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const type = typeof part.type === "string" ? part.type : "";
  if (INTERNAL.test(type)) return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.refusal === "string") return part.refusal;
  if (IMAGE.test(type) || part.image) return "[image]";
  if (AUDIO.test(type) || part.audio) return "[audio]";
  if (FILE.test(type) || part.document) return named("file", part.file?.filename ?? part.filename ?? part.title ?? part.document?.name);
  const inline = part.inlineData ?? part.inline_data ?? part.fileData ?? part.file_data;
  if (inline) return /^image\//.test(mime(inline)) ? "[image]" : /^audio\//.test(mime(inline)) ? "[audio]" : named("file", mime(inline));
  const call = type === "tool_use" || type === "function_call" ? part : part.toolUse ?? part.functionCall;
  if (call) return `[tool call ${call.name ?? "?"} ${args(tool(call.input ?? call.args ?? call.arguments, clean))}]`;
  if (type === "tool_result" || type === "function_call_output") return tool(messageText(part.content ?? part.output, clean), clean);
  const result = part.toolResult ?? part.functionResponse;
  if (result) return tool(messageText(result.content ?? result.response, clean), clean);
  if (type === "message" || (!type && "content" in part)) return messageText(part.content, clean);
  return type ? `[${type}]` : "";
}

function messageText(content, clean) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => partText(part, clean)).filter(Boolean).join("\n");
  if (typeof content === "object") return partText(content, clean) || JSON.stringify(clean ? clean(content) : content);
  return String(content);
}

module.exports = { messageText };
