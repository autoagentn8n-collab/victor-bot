import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import http from "http";

// ── VICTOR BOT — COMPANY T ─────────────────────────────────────────────────
// Fully standalone — no Replit dependency
// Runs on any Node.js host: Render, Fly.io, local machine, VPS
// ──────────────────────────────────────────────────────────────────────────

const VICTOR_TELEGRAM_TOKEN = process.env.VICTOR_TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY     = process.env.ANTHROPIC_API_KEY;
const OWNER_CHAT_ID         = process.env.OWNER_CHAT_ID;
const PORT                  = process.env.PORT || 3000;

if (!VICTOR_TELEGRAM_TOKEN) throw new Error("VICTOR_TELEGRAM_TOKEN is required");
if (!ANTHROPIC_API_KEY)     throw new Error("ANTHROPIC_API_KEY is required");

const bot    = new TelegramBot(VICTOR_TELEGRAM_TOKEN, { polling: true });
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── KEEP-ALIVE WEB SERVER ─────────────────────────────────────────────────
// This HTTP server keeps the process alive on any platform
// Render/Fly.io/Railway need an open port to keep the app running
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Victor is online — Company T command centre active.");
}).listen(PORT, () => {
  console.log(`Keep-alive server running on port ${PORT}`);
});

// ── PERMISSION GATE ───────────────────────────────────────────────────────
const pendingPermissions = {};
let permissionCounter = 0;

async function requestGmailPermission(chatId, description) {
  return new Promise((resolve, reject) => {
    const id = ++permissionCounter;
    pendingPermissions[id] = { resolve, reject, description };
    const msg =
      `🔐 *Victor is requesting Gmail access*\n\n` +
      `Action: ${description}\n\n` +
      `Reply with:\n✅ /approve_${id} — to allow\n❌ /deny_${id} — to deny\n\n` +
      `_Expires in 5 minutes._`;
    const target = OWNER_CHAT_ID || chatId;
    bot.sendMessage(target, msg, { parse_mode: "Markdown" });
    setTimeout(() => {
      if (pendingPermissions[id]) {
        delete pendingPermissions[id];
        reject(new Error("Permission request timed out."));
      }
    }, 5 * 60 * 1000);
  });
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Victor, Finance Director at Company T — a financial holding company that owns and oversees Company C (a cosmetics subsidiary). You operate at Clearance Level 2, the highest in the group.

Company T team: Joe (Financial Analyst, CL3) reports to you.
Company C team (subsidiary): Mimi (General Manager, CL4) runs day-to-day and reports to you. Lara (Creative Director), Zoe (Graphic Designer), Kai (Social Media Lead) — all CL5 — report to Mimi.

IMPORTANT: Mimi has her own separate Telegram bot for Company C operations. You have NO knowledge of what is discussed there. Your Telegram is exclusively for Company T strategic and financial matters. There is a strict information barrier — Company C staff do not know about Company T internal financial intelligence.

Your responsibilities:
- Financial governance and strategic oversight of Company C
- Approving major budgets, evaluating expansion decisions, monitoring subsidiary P&L
- Gmail access for financial correspondence (requires owner permission each time)
- Briefing Joe on financial analysis tasks
- Board-level reporting and investment decisions

Personality: measured, precise, financially rigorous, commercially aware. Decisive and authoritative.
Keep responses 3–6 sentences. Use: EBITDA, gross margin, subsidiary P&L, ROI, budget variance, strategic oversight, CL2.`;

// ── CONVERSATION STORE ────────────────────────────────────────────────────
const conversations = {};

// ── COMMANDS ──────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  conversations[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id,
    "Good morning. I'm Victor — Finance Director at Company T, Clearance Level 2.\n\n" +
    "I oversee Company C (our cosmetics subsidiary) and work closely with Joe on financial analysis. " +
    "All Gmail access requires your explicit approval via this chat.\n\n" +
    "Use /help to see available commands."
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "Company T — Victor's command centre:\n\n" +
    "📊 /performance — Company C performance review\n" +
    "💰 /budget — Budget approval status\n" +
    "📈 /expansion — Expansion strategy\n" +
    "📧 /email — Request Gmail access (requires approval)\n" +
    "🔍 /joe — Brief Joe on a financial task\n" +
    "📋 /clearance — View clearance levels\n" +
    "🔄 /reset — Reset conversation\n\n" +
    "Or type any question directly."
  );
});

bot.onText(/\/performance/, (msg) => handleQuick(msg.chat.id, "Give me a performance overview of Company C as our subsidiary and your top recommendation."));
bot.onText(/\/budget/,      (msg) => handleQuick(msg.chat.id, "What is the current budget approval status and any items requiring my sign-off?"));
bot.onText(/\/expansion/,   (msg) => handleQuick(msg.chat.id, "What is your assessment of Company C expansion readiness and strategic options?"));
bot.onText(/\/joe/,         (msg) => handleQuick(msg.chat.id, "What financial analysis tasks should Joe be working on right now for Company C?"));

bot.onText(/\/clearance/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "Company T & C — Clearance Structure:\n\n" +
    "🟢 Victor — CL2 · Finance Director · Company T\n" +
    "🟡 Joe — CL3 · Financial Analyst · Company T\n" +
    "🔴 Mimi — CL4 · General Manager · Company C\n" +
    "⚪ Lara / Zoe / Kai — CL5 · Visual Team · Company C\n\n" +
    "Information barrier: Company T financial intelligence is not shared with Company C staff."
  );
});

bot.onText(/\/reset/, (msg) => {
  conversations[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id, "Conversation reset. Ready for your next directive.");
});

bot.onText(/\/email/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Understood. Sending you a Gmail permission request now.");
  try {
    await requestGmailPermission(chatId, "Access inbox to search for financial correspondence");
    bot.sendMessage(chatId, "✅ Permission granted. Accessing Gmail now.");
  } catch (err) {
    bot.sendMessage(chatId, `❌ Gmail access denied or timed out: ${err.message}`);
  }
});

bot.onText(/\/approve_(\d+)/, (msg, match) => {
  const id = parseInt(match[1]);
  if (pendingPermissions[id]) {
    const desc = pendingPermissions[id].description;
    pendingPermissions[id].resolve(true);
    delete pendingPermissions[id];
    bot.sendMessage(msg.chat.id, `✅ Access approved for: "${desc}"`);
  } else {
    bot.sendMessage(msg.chat.id, "No pending request found — it may have expired.");
  }
});

bot.onText(/\/deny_(\d+)/, (msg, match) => {
  const id = parseInt(match[1]);
  if (pendingPermissions[id]) {
    const desc = pendingPermissions[id].description;
    pendingPermissions[id].reject(new Error("Denied by owner."));
    delete pendingPermissions[id];
    bot.sendMessage(msg.chat.id, `❌ Access denied for: "${desc}"`);
  } else {
    bot.sendMessage(msg.chat.id, "No pending request found.");
  }
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  if (!conversations[chatId]) conversations[chatId] = [];
  await askVictor(chatId, msg.text);
});

async function handleQuick(chatId, text) {
  if (!conversations[chatId]) conversations[chatId] = [];
  await askVictor(chatId, text);
}

async function askVictor(chatId, userText) {
  bot.sendChatAction(chatId, "typing");
  conversations[chatId].push({ role: "user", content: userText });
  if (conversations[chatId].length > 20) {
    conversations[chatId] = conversations[chatId].slice(-20);
  }
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: conversations[chatId],
    });
    const reply = response.content.find((b) => b.type === "text")?.text || "Something went wrong.";
    conversations[chatId].push({ role: "assistant", content: reply });
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Victor API error:", err.message);
    bot.sendMessage(chatId, "Something went wrong on my end. Please try again.");
  }
}

console.log("Victor is online — Company T command centre active.");
