import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import http from "http";

const VICTOR_TELEGRAM_TOKEN = process.env.VICTOR_TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GROK_API_KEY = process.env.GROK_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const MIMI_TELEGRAM_TOKEN = process.env.MIMI_TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3000;

if (!VICTOR_TELEGRAM_TOKEN) throw new Error("VICTOR_TELEGRAM_TOKEN is required");
if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");

const victorBot = new TelegramBot(VICTOR_TELEGRAM_TOKEN, { polling: true });
const mimiBot = new TelegramBot(MIMI_TELEGRAM_TOKEN, { polling: false });
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const grok = new OpenAI({ apiKey: GROK_API_KEY, baseURL: "https://api.x.ai/v1" });

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Victor is online - Company T command centre active.");
}).listen(PORT, () => console.log("Keep-alive server on port " + PORT));

const pendingPermissions = {};
let permissionCounter = 0;

async function requestGmailPermission(chatId, description) {
  return new Promise((resolve, reject) => {
    const id = ++permissionCounter;
    pendingPermissions[id] = { resolve, reject, description };
    const target = OWNER_CHAT_ID || chatId;
    victorBot.sendMessage(target,
      "🔐 *Victor is requesting Gmail access*\n\nAction: " + description + "\n\nReply with:\n✅ /approve_" + id + " — to allow\n❌ /deny_" + id + " — to deny\n\n_Expires in 5 minutes._",
      { parse_mode: "Markdown" }
    );
    setTimeout(() => {
      if (pendingPermissions[id]) { delete pendingPermissions[id]; reject(new Error("Timed out.")); }
    }, 300000);
  });
}

const VICTOR_PROMPT = "You are Victor, Finance Director at Company T — a financial holding company that owns and oversees Company C (a cosmetics subsidiary). You operate at Clearance Level 2, the highest in the group.\n\nCOMPANY STRUCTURE:\n- Company T (parent): You (Victor, CL2), Joe (Financial Analyst, CL3)\n- Company C (subsidiary): Mimi (General Manager, CL4), Lara (Creative Director, CL5), Zoe (Graphic Designer, CL5), Kai (Social Media Lead, CL5)\n\nYou have DIRECT authority over Company C. Mimi reports to you.\n\nYou now have access to:\n- ChatGPT (OpenAI) for creative writing, copy, and content\n- Grok (xAI) for research, market analysis, and news\n- Claude (Anthropic) for strategic thinking and analysis\n\nPersonality: measured, precise, financially rigorous, commercially aware. Decisive and authoritative.\nKeep responses 3-6 sentences.";

const conversations = {};

function detectAI(text) {
  if (/\b(create|generate|make|draw|design)\b.*\b(image|photo|picture|visual|graphic|banner|poster|logo)\b/i.test(text)) return "image";
  if (/\b(research|analyze|analyse|trend|market|competitor|news|data|report|search|find out|latest)\b/i.test(text)) return "grok";
  if (/\b(write|copy|caption|post|content|email|message|script|slogan|tagline|ad|campaign|brief|draft)\b/i.test(text)) return "chatgpt";
  return "claude";
}

async function handleChatGPT(text) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o", max_tokens: 1000,
    messages: [
      { role: "system", content: "You are a professional business writing assistant for Victor, Finance Director at Company T. Write clear, authoritative content." },
      { role: "user", content: text }
    ],
  });
  return response.choices[0].message.content;
}

async function handleGrok(text) {
  const response = await grok.chat.completions.create({
    model: "grok-3-latest", max_tokens: 1000,
    messages: [
      { role: "system", content: "You are a research and market analysis assistant for Victor, Finance Director at Company T. Provide sharp, data-driven insights." },
      { role: "user", content: text }
    ],
  });
  return response.choices[0].message.content;
}

victorBot.onText(/\/start/, (msg) => {
  conversations[msg.chat.id] = [];
  victorBot.sendMessage(msg.chat.id,
    "Good morning. I'm Victor — Finance Director at Company T, Clearance Level 2.\n\n" +
    "I now have access to multiple AI tools:\n\n" +
    "🧠 *Claude* — Strategic analysis\n" +
    "✍️ *ChatGPT* — Writing & content\n" +
    "🔍 *Grok* — Research & market data\n\n" +
    "I route automatically based on your request.\n\nUse /help for commands.",
    { parse_mode: "Markdown" }
  );
});

victorBot.onText(/\/help/, (msg) => {
  victorBot.sendMessage(msg.chat.id,
    "Company T — Victor's command centre:\n\n" +
    "📊 /performance — Company C performance review\n" +
    "💰 /budget — Budget approval status\n" +
    "📈 /expansion — Expansion strategy\n" +
    "📧 /email — Request Gmail access\n" +
    "🔍 /research [topic] — Grok research\n" +
    "✍️ /write [brief] — ChatGPT writing\n" +
    "📋 /clearance — View clearance levels\n" +
    "📨 /brief_mimi [message] — Send directive to Mimi\n" +
    "🔄 /reset — Reset conversation\n\n" +
    "Or type any question — I auto-route to the right AI.",
    { parse_mode: "Markdown" }
  );
});

victorBot.onText(/\/performance/, (msg) => handleVictor(msg.chat.id, "Give me a performance overview of Company C and your top recommendation."));
victorBot.onText(/\/budget/, (msg) => handleVictor(msg.chat.id, "What budget items require my sign-off from Company C?"));
victorBot.onText(/\/expansion/, (msg) => handleVictor(msg.chat.id, "Assess Company C expansion readiness and strategic options."));

victorBot.onText(/\/research (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  victorBot.sendMessage(chatId, "🔍 Sending to Grok...");
  try {
    const reply = await handleGrok(match[1]);
    victorBot.sendMessage(chatId, "🔍 *Grok:*\n\n" + reply, { parse_mode: "Markdown" });
  } catch (err) { victorBot.sendMessage(chatId, "❌ Grok error: " + err.message); }
});

victorBot.onText(/\/write (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  victorBot.sendMessage(chatId, "✍️ Sending to ChatGPT...");
  try {
    const reply = await handleChatGPT(match[1]);
    victorBot.sendMessage(chatId, "✍️ *ChatGPT:*\n\n" + reply, { parse_mode: "Markdown" });
  } catch (err) { victorBot.sendMessage(chatId, "❌ ChatGPT error: " + err.message); }
});

victorBot.onText(/\/clearance/, (msg) => {
  victorBot.sendMessage(msg.chat.id,
    "Company T & C — Clearance Structure:\n\n" +
    "🟢 Victor — CL2 · Finance Director · Company T\n" +
    "🟡 Joe — CL3 · Financial Analyst · Company T\n" +
    "🔴 Mimi — CL4 · General Manager · Company C\n" +
    "⚪ Lara / Zoe / Kai — CL5 · Visual Team · Company C",
    { parse_mode: "Markdown" }
  );
});

victorBot.onText(/\/reset/, (msg) => {
  conversations[msg.chat.id] = [];
  victorBot.sendMessage(msg.chat.id, "Conversation reset.");
});

victorBot.onText(/\/email/, async (msg) => {
  const chatId = msg.chat.id;
  victorBot.sendMessage(chatId, "Sending Gmail permission request now.");
  try {
    await requestGmailPermission(chatId, "Access inbox for financial correspondence");
    victorBot.sendMessage(chatId, "✅ Permission granted.");
  } catch (err) { victorBot.sendMessage(chatId, "❌ " + err.message); }
});

victorBot.onText(/\/approve_(\d+)/, (msg, match) => {
  const id = parseInt(match[1]);
  if (pendingPermissions[id]) {
    pendingPermissions[id].resolve(true);
    delete pendingPermissions[id];
    victorBot.sendMessage(msg.chat.id, "✅ Approved.");
  } else { victorBot.sendMessage(msg.chat.id, "No pending request found."); }
});

victorBot.onText(/\/deny_(\d+)/, (msg, match) => {
  const id = parseInt(match[1]);
  if (pendingPermissions[id]) {
    pendingPermissions[id].reject(new Error("Denied."));
    delete pendingPermissions[id];
    victorBot.sendMessage(msg.chat.id, "❌ Denied.");
  } else { victorBot.sendMessage(msg.chat.id, "No pending request found."); }
});

victorBot.onText(/\/brief_mimi (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const directive = match[1];
  victorBot.sendMessage(chatId, "📨 Sending directive to Mimi...");
  try {
    await mimiBot.sendMessage(OWNER_CHAT_ID, "🏢 *Directive from Victor (CL2 — Company T)*\n\n" + directive, { parse_mode: "Markdown" });
    await handleVictor(chatId, "I just sent this directive to Mimi at Company C: \"" + directive + "\". Confirm what I expect back from her.");
  } catch (err) { victorBot.sendMessage(chatId, "Failed to reach Mimi: " + err.message); }
});

victorBot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const text = msg.text;
  const lower = text.toLowerCase();

  if (lower.startsWith("tell mimi") || lower.startsWith("ask mimi") || lower.startsWith("brief mimi")) {
    const directive = text.replace(/^(tell|ask|brief)\s+mimi\s*/i, "");
    try {
      await mimiBot.sendMessage(OWNER_CHAT_ID, "🏢 *Directive from Victor (CL2 — Company T)*\n\n" + directive, { parse_mode: "Markdown" });
      victorBot.sendMessage(chatId, "📨 Directive sent to Mimi: \"" + directive + "\"");
    } catch (err) { victorBot.sendMessage(chatId, "Could not reach Mimi: " + err.message); }
    return;
  }

  const aiTarget = detectAI(text);
  victorBot.sendChatAction(chatId, "typing");

  try {
    if (aiTarget === "chatgpt") {
      victorBot.sendMessage(chatId, "✍️ Routing to ChatGPT...");
      const reply = await handleChatGPT(text);
      victorBot.sendMessage(chatId, "✍️ *ChatGPT:*\n\n" + reply, { parse_mode: "Markdown" });
    } else if (aiTarget === "grok") {
      victorBot.sendMessage(chatId, "🔍 Routing to Grok...");
      const reply = await handleGrok(text);
      victorBot.sendMessage(chatId, "🔍 *Grok:*\n\n" + reply, { parse_mode: "Markdown" });
    } else if (aiTarget === "image") {
      victorBot.sendMessage(chatId, "🖼 Image generation coming soon.");
    } else {
      await handleVictor(chatId, text);
    }
  } catch (err) {
    console.error("Error:", err.message);
    victorBot.sendMessage(chatId, "Something went wrong. Please try again.");
  }
});

async function handleVictor(chatId, text) {
  if (!conversations[chatId]) conversations[chatId] = [];
  victorBot.sendChatAction(chatId, "typing");
  conversations[chatId].push({ role: "user", content: text });
  if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      system: VICTOR_PROMPT,
      messages: conversations[chatId],
    });
    const reply = response.content.find((b) => b.type === "text")?.text || "Something went wrong.";
    conversations[chatId].push({ role: "assistant", content: reply });
    victorBot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Victor API error:", err.message);
    victorBot.sendMessage(chatId, "Something went wrong on my end. Please try again.");
  }
}

console.log("Victor is online — Claude + ChatGPT + Grok routing enabled.");
