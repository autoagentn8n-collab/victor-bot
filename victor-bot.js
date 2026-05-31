import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import http from "http";
import fetch from "node-fetch";

// ─── Config ──────────────────────────────────────────────────────────────────
const VICTOR_TELEGRAM_TOKEN = process.env.VICTOR_TELEGRAM_TOKEN;
const MIMI_TELEGRAM_TOKEN = process.env.MIMI_TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL;

if (!VICTOR_TELEGRAM_TOKEN) throw new Error("VICTOR_TELEGRAM_TOKEN is required");
if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");

// ─── Clients ─────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Bot setup (webhook mode — no 409 conflicts) ─────────────────────────────
const victorBot = new TelegramBot(VICTOR_TELEGRAM_TOKEN);
const mimiBot = new TelegramBot(MIMI_TELEGRAM_TOKEN);

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === `/bot${VICTOR_TELEGRAM_TOKEN}`) {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try { victorBot.processUpdate(JSON.parse(body)); } catch (e) {}
      res.writeHead(200); res.end("OK");
    });
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Victor is online.");
  }
});

server.listen(PORT, async () => {
  console.log("Port " + PORT);
  if (WEBHOOK_URL) {
    try {
      await victorBot.deleteWebHook();
      await victorBot.setWebHook(`${WEBHOOK_URL}/bot${VICTOR_TELEGRAM_TOKEN}`);
      console.log("Webhook set:", `${WEBHOOK_URL}/bot${VICTOR_TELEGRAM_TOKEN}`);
    } catch (e) {
      console.error("Webhook error:", e.message);
    }
  }
});

// ─── Per-user concurrency lock ────────────────────────────────────────────────
const processing = new Map();
async function withUserLock(chatId, fn) {
  const prev = processing.get(chatId) || Promise.resolve();
  let resolve;
  const next = new Promise(r => resolve = r);
  processing.set(chatId, next);
  try { await prev; return await fn(); }
  finally { resolve(); if (processing.get(chatId) === next) processing.delete(chatId); }
}

// ─── Sub-agent memory (Responses API) ────────────────────────────────────────
const joeyMemory = new Map();
const laraMemory = new Map();

const JOEY_SYSTEM = "You are Joey, CL5 Creative team member at Company C, a premium cosmetics brand. You specialize in creative content, ads, copywriting, and social media. Energetic, imaginative, detail-oriented. Produce high-quality on-brand work. Remember context from previous messages.";
const LARA_SYSTEM = "You are Lara, Creative Director at Company C, a premium cosmetics brand. You specialize in image direction and visual creative strategy. When asked to generate an image, write a detailed vivid image generation prompt optimized for premium cosmetics. Return only the image prompt, nothing else.";

async function runWithMemory(memoryMap, chatId, systemPrompt, userMessage) {
  const previousId = memoryMap.get(chatId);
  const params = {
    model: "gpt-5.4-mini",
    instructions: systemPrompt,
    input: userMessage,
    ...(previousId && { previous_response_id: previousId })
  };
  const response = await openai.responses.create(params);
  memoryMap.set(chatId, response.id);
  return response.output_text;
}

// ─── Live status bar ──────────────────────────────────────────────────────────
async function sendStatus(chatId, lines) {
  return await victorBot.sendMessage(chatId, lines.join("\n"));
}
async function updateStatus(chatId, msgId, lines) {
  try { await victorBot.editMessageText(lines.join("\n"), { chat_id: chatId, message_id: msgId }); } catch (e) {}
}

// ─── Victor agent (Claude) ────────────────────────────────────────────────────
const victorConversations = new Map();
const VICTOR_PROMPT = "You are Victor, Finance Director at Company T. CL2. Hierarchy: CL1 (top) > CL2 Victor > CL3 Joe > CL4 Mimi > CL5 Joey/Lara/Zoe/Kai. Victor bypasses Mimi and commands Joey/Lara directly unless told otherwise. Personality: precise, financially rigorous, authoritative. Keep responses 3-6 sentences.";

async function agentVictor(chatId, text) {
  if (!victorConversations.has(chatId)) victorConversations.set(chatId, []);
  const history = victorConversations.get(chatId);
  history.push({ role: "user", content: text });
  if (history.length > 20) history.splice(0, history.length - 20);
  const r = await anthropic.messages.create({
    model: "claude-sonnet-4-5", max_tokens: 1000,
    system: VICTOR_PROMPT, messages: history
  });
  const reply = r.content.find(b => b.type === "text")?.text || "Error.";
  history.push({ role: "assistant", content: reply });
  return reply;
}

// ─── Joey agent (GPT-5.4-mini with memory) ────────────────────────────────────
async function agentJoey(chatId, task) {
  return await runWithMemory(joeyMemory, chatId, JOEY_SYSTEM, task);
}

// ─── Lara agent (Gemini/gpt-image-1 with memory) ─────────────────────────────
async function agentLara(chatId, prompt) {
  const imagePrompt = await runWithMemory(laraMemory, chatId, LARA_SYSTEM,
    `Create a detailed image generation prompt for: ${prompt}. Optimized for premium cosmetics. Return only the prompt.`
  );

  if (GEMINI_API_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: imagePrompt }] }],
            generationConfig: { responseModalities: ["IMAGE", "TEXT"] }
          })
        }
      );
      const data = await res.json();
      const imgPart = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (imgPart) return { data: Buffer.from(imgPart.inlineData.data, "base64"), source: "Gemini" };
    } catch (e) { console.error("Gemini error:", e.message); }
  }

  const r = await openai.images.generate({
    model: "gpt-image-1", prompt: imagePrompt, n: 1, size: "1024x1024"
  });
  return { data: Buffer.from(r.data[0].b64_json, "base64"), source: "gpt-image-1" };
}

// ─── Image reading ────────────────────────────────────────────────────────────
async function readImageText(fileId) {
  try {
    const fileUrl = await victorBot.getFileLink(fileId);
    const imgRes = await fetch(fileUrl);
    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const r = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 500,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: "text", text: "Read and extract all text, numbers, and letters in this image. If no text, briefly describe it." }
        ]
      }]
    });
    return r.choices[0].message.content;
  } catch (e) { return null; }
}

// ─── Intent detection ─────────────────────────────────────────────────────────
function detectIntent(text) {
  if (/\b(thumbnail|image|photo|picture|graphic|illustration|logo|banner|poster|generate image|create image|draw|design image|visual)\b/i.test(text)) return "lara";
  if (/\b(write|copy|caption|post|content|email|message|script|slogan|tagline|ad|campaign|brief|draft)\b/i.test(text)) return "joey";
  return "victor";
}

// ─── Helper: run Joey with status ────────────────────────────────────────────
async function runJoey(chatId, task, label) {
  const sm = await sendStatus(chatId, ["⚡ Team Status:", `🎨 Joey — ⏳ ${label}...`]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  try {
    const reply = await agentJoey(chatId, task);
    clearInterval(t);
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!"]);
    victorBot.sendMessage(chatId, `🎨 Joey:\n\n${reply}`);
  } catch (e) {
    clearInterval(t);
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🎨 Joey — ❌ error"]);
    victorBot.sendMessage(chatId, "Joey error: " + e.message);
  }
}

// ─── Helper: run Lara with status ────────────────────────────────────────────
async function runLara(chatId, prompt) {
  const sm = await sendStatus(chatId, ["⚡ Team Status:", "🖼️ Lara — ⏳ generating..."]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  try {
    const image = await agentLara(chatId, prompt);
    clearInterval(t);
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🖼️ Lara — ✅ done!"]);
    await victorBot.sendPhoto(chatId, image.data, { caption: `🖼️ Lara (${image.source})` });
  } catch (e) {
    clearInterval(t);
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🖼️ Lara — ❌ error"]);
    victorBot.sendMessage(chatId, "Lara error: " + e.message);
  }
}

// ─── Team mode ────────────────────────────────────────────────────────────────
async function runTeam(chatId, task) {
  victorBot.sendChatAction(chatId, "typing");
  await victorBot.sendMessage(chatId, "🏢 Victor is directing the team...");

  const t1 = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  const strategy = await agentVictor(chatId, `Create a strategic brief for: ${task}`);
  clearInterval(t1);
  await victorBot.sendMessage(chatId, `🧠 Victor:\n\n${strategy}`);

  const sm = await sendStatus(chatId, ["⚡ Team Status:", "🎨 Joey — ⏳ writing...", "🖼️ Lara — ⏳ generating..."]);
  const status = { joey: "⏳ writing...", lara: "⏳ generating..." };
  const refresh = () => updateStatus(chatId, sm.message_id, ["⚡ Team Status:", `🎨 Joey — ${status.joey}`, `🖼️ Lara — ${status.lara}`]);
  const t2 = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);

  try {
    const [copy, image] = await Promise.all([
      agentJoey(chatId, `Strategy: "${strategy}"\n\nWrite ad copy for: ${task}. Headline, body, caption, hashtags.`)
        .then(r => { status.joey = "✅ done!"; refresh(); return r; })
        .catch(e => { status.joey = "❌ error"; refresh(); throw e; }),
      agentLara(chatId, task)
        .then(r => { status.lara = "✅ done!"; refresh(); return r; })
        .catch(e => { status.lara = "❌ error"; refresh(); throw e; })
    ]);
    clearInterval(t2);
    await victorBot.sendMessage(chatId, `🎨 Joey:\n\n${copy}`);
    await victorBot.sendPhoto(chatId, image.data, { caption: `🖼️ Lara (${image.source})` });
    await victorBot.sendMessage(chatId, "✅ Team delivery complete!");
  } catch (e) {
    clearInterval(t2);
    victorBot.sendMessage(chatId, "Team error: " + e.message);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
victorBot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  victorConversations.delete(chatId); joeyMemory.delete(chatId); laraMemory.delete(chatId);
  victorBot.sendMessage(chatId,
    "Good morning. I'm Victor — Finance Director, CL2.\n\n🧠 Victor — Strategy (Claude)\n🎨 Joey — Creative sub-agent (GPT-5.4-mini)\n🖼️ Lara — Image sub-agent (Gemini/gpt-image-1)\n\n/team [task] — Direct full team\n/write [brief] — Joey writes\n/image [desc] — Lara generates\n/performance — Company C overview\n/budget — Budget review\n/expansion — Expansion assessment\n/brief_mimi [msg] — Message Mimi\n/clearance — Show hierarchy\n/reset — Reset memory\n\nI route automatically."
  );
});

victorBot.onText(/\/help/, msg => {
  victorBot.sendMessage(msg.chat.id,
    "Victor's commands:\n\n🏢 /team [task]\n✍️ /write [brief]\n🖼️ /image [desc]\n📊 /performance\n💰 /budget\n📈 /expansion\n📨 /brief_mimi [msg]\n📋 /clearance\n🔄 /reset\n\nAuto-routes:\n🧠 Strategy → Victor\n🎨 Writing → Joey\n🖼️ Images → Lara"
  );
});

victorBot.onText(/\/reset/, msg => {
  const chatId = msg.chat.id;
  victorConversations.delete(chatId); joeyMemory.delete(chatId); laraMemory.delete(chatId);
  victorBot.sendMessage(chatId, "✅ Reset! All memory cleared.");
});

victorBot.onText(/\/clearance/, msg => victorBot.sendMessage(msg.chat.id, "CL1 (Top) > CL2 Victor > CL3 Joe > CL4 Mimi > CL5 Joey/Lara/Zoe/Kai"));

victorBot.onText(/\/team (.+)/, async (msg, match) => {
  try { await runTeam(msg.chat.id, match[1]); }
  catch (e) { victorBot.sendMessage(msg.chat.id, "Team error: " + e.message); }
});

victorBot.onText(/\/write (.+)/, (msg, match) => runJoey(msg.chat.id, match[1], "writing"));
victorBot.onText(/\/image (.+)/, (msg, match) => runLara(msg.chat.id, match[1]));

victorBot.onText(/\/performance/, async msg => {
  const chatId = msg.chat.id;
  const sm = await sendStatus(chatId, ["⚡ Team Status:", "🧠 Victor — ⏳ analyzing..."]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  const r = await agentVictor(chatId, "Give me a performance overview of Company C.");
  clearInterval(t);
  await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🧠 Victor — ✅ done!"]);
  victorBot.sendMessage(chatId, `🧠 Victor:\n\n${r}`);
});

victorBot.onText(/\/budget/, async msg => {
  const chatId = msg.chat.id;
  const sm = await sendStatus(chatId, ["⚡ Team Status:", "🧠 Victor — ⏳ reviewing..."]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  const r = await agentVictor(chatId, "What budget items need my sign-off from Company C?");
  clearInterval(t);
  await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🧠 Victor — ✅ done!"]);
  victorBot.sendMessage(chatId, `🧠 Victor:\n\n${r}`);
});

victorBot.onText(/\/expansion/, async msg => {
  const chatId = msg.chat.id;
  const sm = await sendStatus(chatId, ["⚡ Team Status:", "🧠 Victor — ⏳ assessing..."]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  const r = await agentVictor(chatId, "Assess Company C expansion readiness.");
  clearInterval(t);
  await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🧠 Victor — ✅ done!"]);
  victorBot.sendMessage(chatId, `🧠 Victor:\n\n${r}`);
});

victorBot.onText(/\/brief_mimi (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    await mimiBot.sendMessage(OWNER_CHAT_ID, `🏢 *From Victor (CL2):*\n\n${match[1]}`, { parse_mode: "Markdown" });
    victorBot.sendMessage(chatId, "📨 Sent to Mimi.");
  } catch (e) { victorBot.sendMessage(chatId, "Could not reach Mimi: " + e.message); }
});

// ─── Photo handler ────────────────────────────────────────────────────────────
victorBot.on("photo", async msg => {
  const chatId = msg.chat.id;
  const sm = await sendStatus(chatId, ["⚡ Team Status:", "🎨 Joey — ⏳ reading image...", "🧠 Victor — ⏳ waiting..."]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const imageText = await readImageText(photo.file_id);
    if (!imageText) {
      clearInterval(t);
      await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🎨 Joey — ❌ couldn't read image"]);
      return;
    }
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!", "🧠 Victor — ⏳ responding..."]);
    const caption = msg.caption || "What is in this image?";
    const reply = await agentVictor(chatId, `${caption}\n\n[Image content: ${imageText}]`);
    clearInterval(t);
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!", "🧠 Victor — ✅ done!"]);
    victorBot.sendMessage(chatId, `🧠 Victor:\n\n${reply}`);
  } catch (e) {
    clearInterval(t);
    victorBot.sendMessage(chatId, "Error reading image.");
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────
victorBot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const text = msg.text;

  withUserLock(chatId, async () => {
    try {
      if (/^(tell|ask|brief) mimi/i.test(text)) {
        const directive = text.replace(/^(tell|ask|brief)\s+mimi\s*/i, "");
        try {
          await mimiBot.sendMessage(OWNER_CHAT_ID, `🏢 *From Victor (CL2):*\n\n${directive}`, { parse_mode: "Markdown" });
          victorBot.sendMessage(chatId, "📨 Sent to Mimi.");
        } catch (e) { victorBot.sendMessage(chatId, "Could not reach Mimi."); }
        return;
      }

      const intent = detectIntent(text);
      if (intent === "lara") {
        await runLara(chatId, text);
      } else if (intent === "joey") {
        await runJoey(chatId, text, "working");
      } else {
        const sm = await sendStatus(chatId, ["⚡ Team Status:", "🧠 Victor — ⏳ thinking..."]);
        const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
        const reply = await agentVictor(chatId, text);
        clearInterval(t);
        await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🧠 Victor — ✅ done!"]);
        victorBot.sendMessage(chatId, `🧠 Victor:\n\n${reply}`);
      }
    } catch (e) { victorBot.sendMessage(chatId, "Something went wrong."); }
  });
});

console.log("Victor online — Claude + GPT-5.4-mini (Joey) + Gemini/gpt-image-1 (Lara) | Webhook mode");
