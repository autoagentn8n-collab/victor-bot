import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import http from "http";

const VICTOR_TELEGRAM_TOKEN = process.env.VICTOR_TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const MIMI_TELEGRAM_TOKEN = process.env.MIMI_TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3000;

if (!VICTOR_TELEGRAM_TOKEN) throw new Error("VICTOR_TELEGRAM_TOKEN is required");
if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");

const victorBot = new TelegramBot(VICTOR_TELEGRAM_TOKEN, { polling: true });
const mimiBot = new TelegramBot(MIMI_TELEGRAM_TOKEN, { polling: false });
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Victor is online.");
}).listen(PORT, () => console.log("Port " + PORT));

const conversations = {};
const pendingPermissions = {};
let permissionCounter = 0;

const VICTOR_PROMPT = "You are Victor, Finance Director at Company T. CL2. Company T owns Company C (cosmetics). Team: Joe (CL3), Mimi (CL4, GM of Company C), Lara/Zoe/Kai (CL5). You use Claude for strategy and ChatGPT for writing. Personality: precise, financially rigorous, authoritative. Keep responses 3-6 sentences.";

function detectAI(text) {
  if (/\b(write|copy|caption|post|content|email|message|script|slogan|tagline|ad|campaign|brief|draft)\b/i.test(text)) return "chatgpt";
  return "claude";
}

async function handleChatGPT(text) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o", max_tokens: 1000,
    messages: [
      { role: "system", content: "You are a professional writing assistant for Victor, Finance Director at Company T." },
      { role: "user", content: text }
    ]
  });
  return r.choices[0].message.content;
}

async function handleVictor(chatId, text) {
  if (!conversations[chatId]) conversations[chatId] = [];
  victorBot.sendChatAction(chatId, "typing");
  conversations[chatId].push({ role: "user", content: text });
  if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);
  try {
    const r = await client.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 1000,
      system: VICTOR_PROMPT, messages: conversations[chatId]
    });
    const reply = r.content.find(b => b.type === "text")?.text || "Error.";
    conversations[chatId].push({ role: "assistant", content: reply });
    victorBot.sendMessage(chatId, reply);
  } catch (err) {
    victorBot.sendMessage(chatId, "Something went wrong. Try again.");
  }
}

victorBot.onText(/\/start/, msg => {
  conversations[msg.chat.id] = [];
  victorBot.sendMessage(msg.chat.id, "Good morning. I'm Victor — Finance Director, CL2.\n\n🧠 Claude — Strategy & analysis\n✍️ ChatGPT — Writing & content\n\nI route automatically. /help for commands.", { parse_mode: "Markdown" });
});

victorBot.onText(/\/help/, msg => {
  victorBot.sendMessage(msg.chat.id,
    "Victor's commands:\n\n📊 /performance\n💰 /budget\n📈 /expansion\n✍️ /write [brief]\n📋 /clearance\n📨 /brief_mimi [msg]\n🔄 /reset\n\nOr type freely — auto-routes to Claude or ChatGPT."
  );
});

victorBot.onText(/\/performance/, msg => handleVictor(msg.chat.id, "Give me a performance overview of Company C."));
victorBot.onText(/\/budget/, msg => handleVictor(msg.chat.id, "What budget items need my sign-off from Company C?"));
victorBot.onText(/\/expansion/, msg => handleVictor(msg.chat.id, "Assess Company C expansion readiness."));
victorBot.onText(/\/reset/, msg => { conversations[msg.chat.id] = []; victorBot.sendMessage(msg.chat.id, "Reset."); });

victorBot.onText(/\/clearance/, msg => {
  victorBot.sendMessage(msg.chat.id, "CL2 Victor · CL3 Joe · CL4 Mimi · CL5 Lara/Zoe/Kai");
});

victorBot.onText(/\/write (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  victorBot.sendMessage(chatId, "✍️ Sending to ChatGPT...");
  try {
    const reply = await handleChatGPT(match[1]);
    victorBot.sendMessage(chatId, "✍️ *ChatGPT:*\n\n" + reply, { parse_mode: "Markdown" });
  } catch (err) { victorBot.sendMessage(chatId, "ChatGPT error: " + err.message); }
});

victorBot.onText(/\/brief_mimi (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    await mimiBot.sendMessage(OWNER_CHAT_ID, "🏢 *From Victor (CL2):*\n\n" + match[1], { parse_mode: "Markdown" });
    victorBot.sendMessage(chatId, "📨 Sent to Mimi.");
  } catch (err) { victorBot.sendMessage(chatId, "Could not reach Mimi: " + err.message); }
});

victorBot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const text = msg.text;
  if (/^(tell|ask|brief) mimi/i.test(text)) {
    const directive = text.replace(/^(tell|ask|brief)\s+mimi\s*/i, "");
    try {
      await mimiBot.sendMessage(OWNER_CHAT_ID, "🏢 *From Victor (CL2):*\n\n" + directive, { parse_mode: "Markdown" });
      victorBot.sendMessage(chatId, "📨 Sent to Mimi.");
    } catch (err) { victorBot.sendMessage(chatId, "Could not reach Mimi."); }
    return;
  }
  const ai = detectAI(text);
  victorBot.sendChatAction(chatId, "typing");
  try {
    if (ai === "chatgpt") {
      victorBot.sendMessage(chatId, "✍️ Routing to ChatGPT...");
      const reply = await handleChatGPT(text);
      victorBot.sendMessage(chatId, "✍️ *ChatGPT:*\n\n" + reply, { parse_mode: "Markdown" });
    } else {
      await handleVictor(chatId, text);
    }
  } catch (err) { victorBot.sendMessage(chatId, "Something went wrong."); }
});

console.log("Victor online — Claude + ChatGPT only.");
