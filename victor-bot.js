import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import http from "http";
import fetch from "node-fetch";

const VICTOR_TELEGRAM_TOKEN = process.env.VICTOR_TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const MIMI_TELEGRAM_TOKEN = process.env.MIMI_TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3000;
const VICTOR_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace("https://", "http://");

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
      console.log("Keep-alive ping. Status:", res.statusCode);
    }).on("error", (err) => console.error("Keep-alive error:", err.message));
  }, 10 * 60 * 1000);
});

// ─── Per-user concurrency lock ───────────────────────────────────────────────
const processing = new Map();
async function withUserLock(chatId, fn) {
  const prev = processing.get(chatId) || Promise.resolve();
  let resolve;
  const next = new Promise(r => resolve = r);
  processing.set(chatId, next);
  try { await prev; return await fn(); }
  finally { resolve(); if (processing.get(chatId) === next) processing.delete(chatId); }
}

// ─── Persistent sub-agent threads (memory per user) ─────────────────────────
const joeyThreads = new Map();
const laraThreads = new Map();
let joeyAssistantId = null;
let laraAssistantId = null;

async function getOrCreateJoeyAssistant() {
  if (joeyAssistantId) return joeyAssistantId;
  const assistant = await openai.beta.assistants.create({
    name: "Joey",
    instructions: "You are Joey, CL5 Creative team member at Company C, a premium cosmetics brand. You specialize in creative content, ads, copywriting, and social media. Energetic, imaginative, detail-oriented. Produce high-quality on-brand work. Remember context from previous messages.",
    model: "gpt-5.4-mini",
  });
  joeyAssistantId = assistant.id;
  console.log("Joey assistant created:", joeyAssistantId);
  return joeyAssistantId;
}

async function getOrCreateLaraAssistant() {
  if (laraAssistantId) return laraAssistantId;
  const assistant = await openai.beta.assistants.create({
    name: "Lara",
    instructions: "You are Lara, Creative Director at Company C, a premium cosmetics brand. You specialize in image direction and visual creative strategy. When asked to generate an image, write a detailed vivid image generation prompt optimized for premium cosmetics. Return only the image prompt.",
    model: "gpt-5.4-mini",
  });
  laraAssistantId = assistant.id;
  console.log("Lara assistant created:", laraAssistantId);
  return laraAssistantId;
}

async function getOrCreateThread(threadMap, chatId) {
  if (threadMap.has(chatId)) return threadMap.get(chatId);
  const thread = await openai.beta.threads.create();
  threadMap.set(chatId, thread.id);
  return thread.id;
}

async function runAssistant(assistantId, threadId, message) {
  await openai.beta.threads.messages.create(threadId, { role: "user", content: message });
  const run = await openai.beta.threads.runs.create(threadId, { assistant_id: assistantId });
  let runStatus = run;
  while (runStatus.status !== "completed" && runStatus.status !== "failed") {
    await new Promise(r => setTimeout(r, 1000));
    runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
  }
  if (runStatus.status === "failed") throw new Error("Assistant run failed: " + runStatus.last_error?.message);
  const messages = await openai.beta.threads.messages.list(threadId);
  const latest = messages.data[0];
  return latest.content[0].type === "text" ? latest.content[0].text.value : "No response.";
}

// ─── Live status bar helper ──────────────────────────────────────────────────
async function sendStatus(chatId, lines) {
  return await victorBot.sendMessage(chatId, lines.join("\n"));
}

async function updateStatus(chatId, msgId, lines) {
  try {
    await victorBot.editMessageText(lines.join("\n"), { chat_id: chatId, message_id: msgId });
  } catch (e) {}
}

// ─── Victor (Claude) ─────────────────────────────────────────────────────────
const conversations = {};
const VICTOR_PROMPT = "You are Victor, Finance Director at Company T. CL2. Hierarchy: CL1 (top) > CL2 Victor > CL3 Joe > CL4 Mimi > CL5 Joey/Lara/Zoe/Kai. Victor bypasses Mimi and commands Joey/Lara directly unless told otherwise. Personality: precise, financially rigorous, authoritative. Keep responses 3-6 sentences.";

async function agentVictor(chatId, text) {
  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: "user", content: text });
  if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);
  const r = await client.messages.create({
    model: "claude-sonnet-4-5", max_tokens: 1000,
    system: VICTOR_PROMPT, messages: conversations[chatId]
  });
  const reply = r.content.find(b => b.type === "text")?.text || "Error.";
  conversations[chatId].push({ role: "assistant", content: reply });
  return reply;
}

// ─── Joey sub-agent ──────────────────────────────────────────────────────────
async function agentJoey(chatId, task) {
  const assistantId = await getOrCreateJoeyAssistant();
  const threadId = await getOrCreateThread(joeyThreads, chatId);
  return await runAssistant(assistantId, threadId, task);
}

// ─── Lara sub-agent ──────────────────────────────────────────────────────────
async function agentLara(chatId, prompt) {
  const assistantId = await getOrCreateLaraAssistant();
  const threadId = await getOrCreateThread(laraThreads, chatId);
  const imagePrompt = await runAssistant(assistantId, threadId,
    `Create a detailed image generation prompt for: ${prompt}. Optimized for premium cosmetics. Return only the prompt.`
  );

  if (GEMINI_API_KEY) {
    try {
      const geminiResponse = await fetch(
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
      const geminiData = await geminiResponse.json();
      const imagePart = geminiData?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (imagePart) {
        return { type: "buffer", data: Buffer.from(imagePart.inlineData.data, "base64"), source: "Gemini" };
      }
    } catch (err) {
      console.error("Gemini error, falling back to gpt-image-1:", err.message);
    }
  }

  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt: imagePrompt,
    n: 1,
    size: "1024x1024",
  });
  const imageBuffer = Buffer.from(response.data[0].b64_json, "base64");
  return { type: "buffer", data: imageBuffer, source: "gpt-image-1" };
}

// ─── Image reading ────────────────────────────────────────────────────────────
async function readImageText(fileId) {
  try {
    const fileUrl = await victorBot.getFileLink(fileId);
    const imageResponse = await fetch(fileUrl);
    const buffer = await imageResponse.buffer();
    const base64Image = buffer.toString("base64");
    const response = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 500,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
          { type: "text", text: "Read and extract all text, numbers, and letters in this image. If no text, briefly describe it." }
        ]
      }]
    });
    return response.choices[0].message.content;
  } catch (err) { return null; }
}

// ─── Intent detection ─────────────────────────────────────────────────────────
function detectIntent(text) {
  if (/\b(thumbnail|image|photo|picture|graphic|illustration|logo|banner|poster|generate image|create image|draw|design image)\b/i.test(text)) return "lara";
  if (/\b(write|copy|caption|post|content|email|message|script|slogan|tagline|ad|campaign|brief|draft)\b/i.test(text)) return "joey";
  return "victor";
}

// ─── Team mode ────────────────────────────────────────────────────────────────
async function handleTeam(chatId, task) {
  victorBot.sendChatAction(chatId, "typing");
  await victorBot.sendMessage(chatId, "🏢 Victor is directing the team...");

  const t1 = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  const strategy = await agentVictor(chatId, `Create a strategic brief for: ${task}`);
  clearInterval(t1);
  await victorBot.sendMessage(chatId, `🧠 Victor:\n\n${strategy}`);

  const statusMsg = await sendStatus(chatId, [
    "⚡ Team Status:",
    "🎨 Joey — ⏳ writing...",
    "🖼️ Lara — ⏳ generating..."
  ]);
  const statusId = statusMsg.message_id;
  const status = { joey: "⏳ writing...", lara: "⏳ generating..." };

  const refreshStatus = () => updateStatus(chatId, statusId, [
    "⚡ Team Status:",
    `🎨 Joey — ${status.joey}`,
    `🖼️ Lara — ${status.lara}`
  ]);

  const t2 = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);

  try {
    const [copy, image] = await Promise.all([
      agentJoey(chatId, `Strategy: "${strategy}"\n\nWrite ad copy for: ${task}. Headline, body, caption, hashtags.`)
        .then(r => { status.joey = "✅ done!"; refreshStatus(); return r; })
        .catch(e => { status.joey = "❌ error"; refreshStatus(); throw e; }),
      agentLara(chatId, task)
        .then(r => { status.lara = "✅ done!"; refreshStatus(); return r; })
        .catch(e => { status.lara = "❌ error"; refreshStatus(); throw e; })
    ]);

    clearInterval(t2);
    await victorBot.sendMessage(chatId, `🎨 Joey:\n\n${copy}`);
    await victorBot.sendPhoto(chatId, image.data, { caption: `🖼️ Lara (${image.source})` });
    await victorBot.sendMessage(chatId, "✅ Team delivery complete!");
  } catch (err) {
    clearInterval(t2);
    await victorBot.sendMessage(chatId, "Team error: " + err.message);
  }
}

// ─── Helper wrappers ──────────────────────────────────────────────────────────
async function joeyCommand(chatId, task, label) {
  const statusMsg = await sendStatus(chatId, ["⚡ Team Status:", `🎨 Joey — ⏳ ${label}...`]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  try {
    const reply = await agentJoey(chatId, task);
    clearInterval(t);
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!"]);
    victorBot.sendMessage(chatId, `🎨 Joey:\n\n${reply}`);
  } catch (err) {
    clearInterval(t);
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🎨 Joey — ❌ error"]);
    victorBot.sendMessage(chatId, "Joey error: " + err.message);
  }
}

async function laraCommand(chatId, prompt) {
  const statusMsg = await sendStatus(chatId, ["⚡ Team Status:", "🖼️ Lara — ⏳ generating..."]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  try {
    const image = await agentLara(chatId, prompt);
    clearInterval(t);
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🖼️ Lara — ✅ done!"]);
    await victorBot.sendPhoto(chatId, image.data, { caption: `🖼️ Lara (${image.source})` });
  } catch (err) {
    clearInterval(t);
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🖼️ Lara — ❌ error"]);
    victorBot.sendMessage(chatId, "Lara error: " + err.message);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
victorBot.onText(/\/start/, msg => {
  conversations[msg.chat.id] = [];
  joeyThreads.delete(msg.chat.id);
  laraThreads.delete(msg.chat.id);
  victorBot.sendMessage(msg.chat.id,
    "Good morning. I'm Victor — Finance Director, CL2.\n\n🧠 Victor — Strategy (Claude)\n🎨 Joey — Creative sub-agent (GPT-5.4-mini + memory)\n🖼️ Lara — Image sub-agent (Gemini/gpt-image-1 + memory)\n\n/team [task] - Direct full team\n/write [brief] - Joey writes\n/image [desc] - Lara generates\n/performance /budget /expansion\n/brief_mimi [msg] - Message Mimi\n/reset\n\nI route automatically."
  );
});

victorBot.onText(/\/help/, msg => {
  victorBot.sendMessage(msg.chat.id,
    "Victor's commands:\n\n🏢 /team [task]\n📊 /performance\n💰 /budget\n📈 /expansion\n✍️ /write [brief]\n🖼️ /image [desc]\n📋 /clearance\n📨 /brief_mimi [msg]\n🔄 /reset\n\nAuto-routes:\n🧠 Strategy → Victor\n🎨 Writing → Joey (sub-agent)\n🖼️ Images → Lara (sub-agent)"
  );
});

victorBot.onText(/\/reset/, msg => {
  conversations[msg.chat.id] = [];
  joeyThreads.delete(msg.chat.id);
  laraThreads.delete(msg.chat.id);
  victorBot.sendMessage(msg.chat.id, "Reset! Joey and Lara memory cleared.");
});

victorBot.onText(/\/clearance/, msg => victorBot.sendMessage(msg.chat.id, "CL1 (Top) > CL2 Victor > CL3 Joe > CL4 Mimi > CL5 Joey/Lara/Zoe/Kai"));
victorBot.onText(/\/team (.+)/, async (msg, match) => { try { await handleTeam(msg.chat.id, match[1]); } catch (err) { victorBot.sendMessage(msg.chat.id, "Team error: " + err.message); } });
victorBot.onText(/\/write (.+)/, (msg, match) => joeyCommand(msg.chat.id, match[1], "writing"));
victorBot.onText(/\/image (.+)/, (msg, match) => laraCommand(msg.chat.id, match[1]));

victorBot.onText(/\/performance/, msg => {
  const chatId = msg.chat.id;
  const statusMsg = sendStatus(chatId, ["⚡ Team Status:", "🧠 Victor — ⏳ analyzing..."]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  statusMsg.then(sm => agentVictor(chatId, "Give me a performance overview of Company C.").then(r => {
    clearInterval(t);
    updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🧠 Victor — ✅ done!"]);
    victorBot.sendMessage(chatId, `🧠 Victor:\n\n${r}`);
  }));
});

victorBot.onText(/\/budget/, msg => {
  const chatId = msg.chat.id;
  const statusMsg = sendStatus(chatId, ["⚡ Team Status:", "🧠 Victor — ⏳ reviewing..."]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  statusMsg.then(sm => agentVictor(chatId, "What budget items need my sign-off from Company C?").then(r => {
    clearInterval(t);
    updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🧠 Victor — ✅ done!"]);
    victorBot.sendMessage(chatId, `🧠 Victor:\n\n${r}`);
  }));
});

victorBot.onText(/\/expansion/, msg => {
  const chatId = msg.chat.id;
  const statusMsg = sendStatus(chatId, ["⚡ Team Status:", "🧠 Victor — ⏳ assessing..."]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  statusMsg.then(sm => agentVictor(chatId, "Assess Company C expansion readiness.").then(r => {
    clearInterval(t);
    updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🧠 Victor — ✅ done!"]);
    victorBot.sendMessage(chatId, `🧠 Victor:\n\n${r}`);
  }));
});

victorBot.onText(/\/brief_mimi (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    await mimiBot.sendMessage(OWNER_CHAT_ID, "🏢 *From Victor (CL2):*\n\n" + match[1], { parse_mode: "Markdown" });
    victorBot.sendMessage(chatId, "📨 Sent to Mimi.");
  } catch (err) { victorBot.sendMessage(chatId, "Could not reach Mimi: " + err.message); }
});

victorBot.on("photo", async msg => {
  const chatId = msg.chat.id;
  const statusMsg = await sendStatus(chatId, ["⚡ Team Status:", "🎨 Joey — ⏳ reading image..."]);
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const imageText = await readImageText(photo.file_id);
    clearInterval(t);
    if (!imageText) {
      await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🎨 Joey — ❌ couldn't read image"]);
      return;
    }
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!", "🧠 Victor — ⏳ responding..."]);
    const caption = msg.caption || "What is in this image?";
    const reply = await agentVictor(chatId, `${caption}\n\n[Image content: ${imageText}]`);
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!", "🧠 Victor — ✅ done!"]);
    victorBot.sendMessage(chatId, `🧠 Victor:\n\n${reply}`);
  } catch (err) {
    clearInterval(t);
    victorBot.sendMessage(chatId, "Error reading image.");
  }
});

victorBot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const text = msg.text;

  withUserLock(chatId, async () => {
    try {
      if (/^(tell|ask|brief) mimi/i.test(text)) {
        const directive = text.replace(/^(tell|ask|brief)\s+mimi\s*/i, "");
        try {
          await mimiBot.sendMessage(OWNER_CHAT_ID, "🏢 *From Victor (CL2):*\n\n" + directive, { parse_mode: "Markdown" });
          victorBot.sendMessage(chatId, "📨 Sent to Mimi.");
        } catch (err) { victorBot.sendMessage(chatId, "Could not reach Mimi."); }
        return;
      }

      const intent = detectIntent(text);
      if (intent === "lara") {
        await laraCommand(chatId, text);
      } else if (intent === "joey") {
        await joeyCommand(chatId, text, "working");
      } else {
        const statusMsg = await sendStatus(chatId, ["⚡ Team Status:", "🧠 Victor — ⏳ thinking..."]);
        const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
        const reply = await agentVictor(chatId, text);
        clearInterval(t);
        await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🧠 Victor — ✅ done!"]);
        victorBot.sendMessage(chatId, `🧠 Victor:\n\n${reply}`);
      }
    } catch (err) { victorBot.sendMessage(chatId, "Something went wrong."); }
  });
});

console.log("Victor online — Claude (Victor) + GPT-5.4-mini sub-agent (Joey) + Gemini/gpt-image-1 sub-agent (Lara) + Parallel Team Mode.");
