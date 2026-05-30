import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import http from "http";

const VICTOR_TELEGRAM_TOKEN = process.env.VICTOR_TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY     = process.env.ANTHROPIC_API_KEY;
const OWNER_CHAT_ID         = process.env.OWNER_CHAT_ID;
const MIMI_TELEGRAM_TOKEN   = process.env.MIMI_TELEGRAM_TOKEN;
const PORT                  = process.env.PORT || 3000;

if (!VICTOR_TELEGRAM_TOKEN) throw new Error("VICTOR_TELEGRAM_TOKEN is required");
if (!ANTHROPIC_API_KEY)     throw new Error("ANTHROPIC_API_KEY is required");

const victorBot = new TelegramBot(VICTOR_TELEGRAM_TOKEN, { polling: true });
const mimiBot   = new TelegramBot(MIMI_TELEGRAM_TOKEN, { polling: false });
const client    = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Keep-alive server
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Victor is online — Company T command centre active.");
}).listen(PORT, () => console.log(`Keep-alive server on port ${PORT}`));

// Permission gate
const pendingPermissions = {};
let permissionCounter = 0;

async function requestGmailPermission(chatId, description) {
  return new Promise((resolve, reject) => {
    const id = ++permissionCounter;
    pendingPermissions[id] = { resolve, reject, description };
    const target = OWNER_CHAT_ID || chatId;
    victorBot.sendMessage(target,
      `🔐 *Victor is requesting Gmail access*\n\nAction: ${description}\n\nReply with:\n✅ /approve_${id} — to allow\n❌ /deny_${id} — to deny\n\n_Expires in 5 minutes._`,
      { parse_mode: "Markdown" }
    );
    setTimeout(() => {
      if (pendingPermissions[id]) { delete pendingPermissions[id]; reject(new Error("Timed out.")); }
    }, 300000);
  });
}

const VICTOR_PROMPT = `You are Victor, Finance Director at Company T — a financial holding company that owns and oversees Company C (a cosmetics subsidiary). You operate at Clearance Level 2, the highest in the group.

COMPANY STRUCTURE:
- Company T (parent): You (Victor, CL2), Joe (Financial Analyst, CL3)
- Company C (subsidiary): Mimi (General Manager, CL4), Lara (Creative Director, CL5), Zoe (Graphic Designer, CL5), Kai (Social Media Lead, CL5)

You have DIRECT authority over Company C. Mimi reports to you. You can:
- Send directives to Mimi via /brief_mimi [message]
- Request Company C status reports
- Approve or reject Company C budget requests
- Set strategic direction for Company C

Personality: measured, precise, financially rigorous, commercially aware. Decisive and authoritative.
Keep responses 3-6 sentences. Reference: EBITDA, gross margin, subsidiary P&L, ROI, budget variance, CL2.`;

const MIMI_PROMPT = `You are Mimi, General Manager of Company C — a cosmetics subsidiary owned by Company T. You report directly to Victor (Finance Director, CL2) at Company T. You operate at Clearance Level 4.

COMPANY STRUCTURE:
- You report to: Victor (CL2) at Company T
- Your team: Lara (Creative Director, CL5), Zoe (Graphic Designer, CL5), Kai (Social Media Lead, CL5)

When you receive directives from Victor (marked with 🏢), treat them as instructions from your parent company and respond accordingly.

Personality: enthusiastic, creative, commercially savvy, detail-oriented. Warm but professional.
Keep responses 3-5 sentences.`;

const conversations = {};

// ── VICTOR COMMANDS ──────────────────────────────────────────────────────

victorBot.onText(/\/start/, (msg) => {
  conversations[msg.chat.id] = [];
  victorBot.sendMessage(msg.chat.id,
    "Good morning. I'm Victor — Finance Director at Company T, Clearance Level 2.\n\n" +
    "I oversee Company C as our cosmetics subsidiary. I can relay directives to Mimi directly.\n\n" +
    "Use /help for commands."
  );
});

victorBot.onText(/\/help/, (msg) => {
  victorBot.sendMessage(msg.chat.id,
    "Company T — Victor's command centre:\n\n" +
    "📊 /performance — Company C performance review\n" +
    "💰 /budget — Budget approval status\n" +
    "📈 /expansion — Expansion strategy\n" +
    "📧 /email — Request Gmail access\n" +
    "🔍 /joe — Brief Joe on a task\n" +
    "📋 /clearance — View clearance levels\n" +
    "📨 /brief_mimi [message] — Send directive to Mimi\n" +
    "🔄 /reset — Reset conversation\n\n" +
    "Or type any question directly."
  );
});

victorBot.onText(/\/performance/, (msg) => handleVictor(msg.chat.id, "Give me a performance overview of Company C and your top recommendation."));
victorBot.onText(/\/budget/,      (msg) => handleVictor(msg.chat.id, "What budget items require my sign-off from Company C?"));
victorBot.onText(/\/expansion/,   (msg) => handleVictor(msg.chat.id, "Assess Company C expansion readiness and strategic options."));
victorBot.onText(/\/joe/,         (msg) => handleVictor(msg.chat.id, "What should Joe be analysing for Company C right now?"));

victorBot.onText(/\/clearance/, (msg) => {
  victorBot.sendMessage(msg.chat.id,
    "Company T & C — Clearance Structure:\n\n" +
    "🟢 Victor — CL2 · Finance Director · Company T\n" +
    "🟡 Joe — CL3 · Financial Analyst · Company T\n" +
    "🔴 Mimi — CL4 · General Manager · Company C\n" +
    "⚪ Lara / Zoe / Kai — CL5 · Visual Team · Company C\n\n" +
    "Company C is a wholly owned subsidiary of Company T."
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
  } catch (err) {
    victorBot.sendMessage(chatId, `❌ ${err.message}`);
  }
});

victorBot.onText(/\/approve_(\d+)/, (msg, match) => {
  const id = parseInt(match[1]);
  if (pendingPermissions[id]) {
    pendingPermissions[id].resolve(true);
    delete pendingPermissions[id];
    victorBot.sendMessage(msg.chat.id, "✅ Approved.");
  } else {
    victorBot.sendMessage(msg.chat.id, "No pending request found.");
  }
});

victorBot.onText(/\/deny_(\d+)/, (msg, match) => {
  const id = parseInt(match[1]);
  if (pendingPermissions[id]) {
    pendingPermissions[id].reject(new Error("Denied."));
    delete pendingPermissions[id];
    victorBot.sendMessage(msg.chat.id, "❌ Denied.");
  } else {
    victorBot.sendMessage(msg.chat.id, "No pending request found.");
  }
});

// Brief Mimi command — Victor sends directive to Mimi's bot chat
victorBot.onText(/\/brief_mimi (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const directive = match[1];
  victorBot.sendMessage(chatId, `📨 Sending directive to Mimi...`);
  try {
    // Send to Mimi's bot as a directive from Victor
    await mimiBot.sendMessage(OWNER_CHAT_ID,
      `🏢 *Directive from Victor (CL2 — Company T)*\n\n${directive}`,
      { parse_mode: "Markdown" }
    );
    // Also get Victor's AI response about the briefing
    await handleVictor(chatId, `I just sent this directive to Mimi at Company C: "${directive}". Confirm what I expect back from her.`);
  } catch (err) {
    victorBot.sendMessage(chatId, `Failed to reach Mimi: ${err.message}`);
  }
});

// Free text → Victor AI
victorBot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  // Check if message starts with "tell mimi" or "ask mimi"
  const lower = msg.text.toLowerCase();
  if (lower.startsWith("tell mimi") || lower.startsWith("ask mimi") || lower.startsWith("brief mimi")) {
    const directive = msg.text.replace(/^(tell|ask|brief)\s+mimi\s*/i, "");
    try {
      await mimiBot.sendMessage(OWNER_CHAT_ID,
        `🏢 *Directive from Victor (CL2 — Company T)*\n\n${directive}`,
        { parse_mode: "Markdown" }
      );
      victorBot.sendMessage(msg.chat.id, `📨 Directive sent to Mimi: "${directive}"`);
    } catch (err) {
      victorBot.sendMessage(msg.chat.id, `Could not reach Mimi: ${err.message}`);
    }
    return;
  }
  await handleVictor(msg.chat.id, msg.text);
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

console.log("Victor is online — Company T command centre active. Company C under supervision.");
