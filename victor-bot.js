import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import http from "http";
import fetch from "node-fetch";

const VICTOR_TELEGRAM_TOKEN = process.env.VICTOR_TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const MIMI_TELEGRAM_TOKEN = process.env.MIMI_TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3000;
const VICTOR_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

if (!VICTOR_TELEGRAM_TOKEN) throw new Error("VICTOR_TELEGRAM_TOKEN is required");
if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");

const victorBot = new TelegramBot(VICTOR_TELEGRAM_TOKEN, { polling: true });
const mimiBot = new TelegramBot(MIMI_TELEGRAM_TOKEN, { polling: false });
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Victor is online.");
}).listen(PORT, () => {
  console.log("Port " + PORT);
  setInterval(() => {
    http.get(VICTOR_URL, (res) => {
      console.log("Keep-alive ping sent. Status:", res.statusCode);
    }).on("error", (err) => {
      console.error("Keep-alive error:", err.message);
    });
  }, 10 * 60 * 1000);
});

const conversations = {};

const VICTOR_PROMPT = "You are Victor, Finance Director at Company T. CL2. Company T owns Company C (cosmetics). Team: Joe (CL3), Mimi (CL4, GM of Company C), Lara/Zoe/Kai/Joey (CL5). You use Claude for strategy and Joey (ChatGPT) for writing. Personality: precise, financially rigorous, authoritative. Keep responses 3-6 sentences.";

const JOEY_PROMPT = "You are Joey, CL5 Creative team member at Company C, a premium cosmetics brand. You work under Mimi (GM) and specialize in creative content, ads, copywriting, and social media. You are energetic, imaginative, and detail-oriented. Always produce high-quality, on-brand creative work.";

function detectAI(text) {
  if (/\b(write|copy|caption|post|content|email|message|script|slogan|tagline|ad|campaign|brief|draft)\b/i.test(text)) return "joey";
  return "claude";
}

async function readImageText(fileId) {
  try {
    const fileUrl = await victorBot.getFileLink(fileId);
    const imageResponse = await fetch(fileUrl);
    const buffer = await imageResponse.buffer();
    const base64Image = buffer.toString("base64");
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
          { type: "text", text: "Please read and extract all text, numbers, and letters visible in this image. If there is no text, describe what you see briefly." }
        ]
      }]
    });
    return response.choices[0].message.content;
  } catch (err) {
    return null;
  }
}

// Joey handles all ChatGPT writing work
async function handleJoey(text, extraSystem) {
  const sys = extraSystem || JOEY_PROMPT;
  const r = await openai.chat.completions.create({
    model: "gpt-4o", max_tokens: 1000,
    messages: [{ role: "system", content: sys }, { role: "user", content: text }]
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
    victorBot.sendMessage(chatId, "🧠 Victor:\n\n" + reply);
  } catch (err) {
    victorBot.sendMessage(chatId, "Something went wrong. Try again.");
  }
}

victorBot.onText(/\/start/, msg => {
  conversations[msg.chat.id] = [];
  victorBot.sendMessage(msg.chat.id, "Good morning. I'm Victor — Finance Director, CL2.\n\n🧠 Victor (me) — Strategy via Claude\n🎨 Joey — Writing & creative via ChatGPT\n📷 Vision — Image & text reading\n\nI route automatically. /help for commands.", { parse_mode: "Markdown" });
});

victorBot.onText(/\/help/, msg => {
  victorBot.sendMessage(msg.chat.id,
    "Victor's commands:\n\n📊 /performance\n💰 /budget\n📈 /expansion\n✍️ /write [brief]\n📋 /clearance\n📨 /brief_mimi [msg]\n🔄 /reset\n\nAuto-routes:\n🧠 Strategy → Victor (Claude)\n🎨 Writing/creative → Joey (ChatGPT)\n\nSend an image to read text from it!"
  );
});

victorBot.onText(/\/performance/, msg => handleVictor(msg.chat.id, "Give me a performance overview of Company C."));
victorBot.onText(/\/budget/, msg => handleVictor(msg.chat.id, "What budget items need my sign-off from Company C?"));
victorBot.onText(/\/expansion/, msg => handleVictor(msg.chat.id, "Assess Company C expansion readiness."));
victorBot.onText(/\/reset/, msg => { conversations[msg.chat.id] = []; victorBot.sendMessage(msg.chat.id, "Reset."); });

victorBot.onText(/\/clearance/, msg => {
  victorBot.sendMessage(msg.chat.id, "CL2 Victor · CL3 Joe · CL4 Mimi · CL5 Lara/Zoe/Kai/Joey");
});

victorBot.onText(/\/write (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  victorBot.sendMessage(chatId, "🎨 Passing to Joey...");
  try {
    const reply = await handleJoey(match[1]);
    victorBot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { victorBot.sendMessage(chatId, "Joey error: " + err.message); }
});

victorBot.onText(/\/brief_mimi (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    await mimiBot.sendMessage(OWNER_CHAT_ID, "🏢 *From Victor (CL2):*\n\n" + match[1], { parse_mode: "Markdown" });
    victorBot.sendMessage(chatId, "📨 Sent to Mimi.");
  } catch (err) { victorBot.sendMessage(chatId, "Could not reach Mimi: " + err.message); }
});

// Handle images
victorBot.on("photo", async msg => {
  const chatId = msg.chat.id;
  victorBot.sendChatAction(chatId, "typing");
  victorBot.sendMessage(chatId, "🎨 Joey is reading the image...");
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const imageText = await readImageText(photo.file_id);
    if (!imageText) {
      victorBot.sendMessage(chatId, "Sorry, I couldn't read that image. Please try again.");
      return;
    }
    const caption = msg.caption || "What is in this image?";
    const fullText = `${caption}\n\n[Image content: ${imageText}]`;
    await handleVictor(chatId, fullText);
  } catch (err) {
    victorBot.sendMessage(chatId, "Something went wrong reading the image. Please try again.");
  }
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
    if (ai === "joey") {
      victorBot.sendMessage(chatId, "🎨 Passing to Joey...");
      const reply = await handleJoey(text);
      victorBot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
    } else {
      await handleVictor(chatId, text);
    }
  } catch (err) { victorBot.sendMessage(chatId, "Something went wrong."); }
});

console.log("Victor online — Claude (Victor) + ChatGPT (Joey).");
