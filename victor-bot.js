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
      console.log("Keep-alive ping sent. Status:", res.statusCode);
    }).on("error", (err) => {
      console.error("Keep-alive error:", err.message);
    });
  }, 10 * 60 * 1000);
});

const conversations = {};

const VICTOR_PROMPT = "You are Victor, Finance Director at Company T. CL2. Hierarchy: CL1 (top) > CL2 Victor > CL3 Joe > CL4 Mimi > CL5 Joey/Lara/Zoe/Kai. Victor bypasses Mimi and commands Joey/Lara directly unless told otherwise. Personality: precise, financially rigorous, authoritative. Keep responses 3-6 sentences.";

const JOEY_PROMPT = "You are Joey, CL5 Creative team member at Company C, a premium cosmetics brand. You specialize in creative content, ads, copywriting, and social media. Energetic, imaginative, detail-oriented. Produce high-quality on-brand work. Be concise and fast.";

function detectIntent(text) {
  if (/\b(thumbnail|image|photo|picture|graphic|illustration|logo|banner|poster|generate image|create image|draw|design image)\b/i.test(text)) return "lara";
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
      model: "gpt-5.4-mini",
      max_tokens: 500,
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

// Joey sub-agent (GPT-5.4-mini)
async function agentJoey(task, context) {
  const prompt = context ? `Context: ${context}\n\nTask: ${task}` : task;
  const r = await openai.chat.completions.create({
    model: "gpt-5.4-mini",
    max_tokens: 1200,
    messages: [
      { role: "system", content: JOEY_PROMPT },
      { role: "user", content: prompt }
    ],
  });
  return r.choices[0].message.content;
}

// Lara sub-agent (Gemini/DALL-E 3)
async function agentLara(prompt) {
  const refinedPrompt = await agentJoey(
    `Write a vivid image generation prompt for: ${prompt}. Optimized for premium cosmetics. Return only the prompt.`,
    null
  );

  if (GEMINI_API_KEY) {
    try {
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: refinedPrompt }] }],
            generationConfig: { responseModalities: ["IMAGE", "TEXT"] }
          })
        }
      );
      const geminiData = await geminiResponse.json();
      const imagePart = geminiData?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (imagePart) {
        return { type: "buffer", data: Buffer.from(imagePart.inlineData.data, "base64") };
      }
    } catch (err) {
      console.error("Gemini error, falling back to DALL-E 3:", err.message);
    }
  }

  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt: refinedPrompt,
    n: 1,
    size: "1024x1024",
    quality: "standard",
  });
  return { type: "url", data: response.data[0].url };
}

// Victor sub-agent (Claude)
async function agentVictor(chatId, text) {
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
    return reply;
  } catch (err) { return "Something went wrong. Try again."; }
}

// Team mode — Victor directs Joey & Lara in PARALLEL
async function handleTeam(chatId, task) {
  victorBot.sendChatAction(chatId, "typing");
  await victorBot.sendMessage(chatId, "🏢 Victor is directing the team...");

  // Step 1: Victor creates strategy
  const typingInterval1 = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  const strategy = await agentVictor(chatId, `Create a strategic brief for: ${task}`);
  clearInterval(typingInterval1);
  await victorBot.sendMessage(chatId, `🧠 Victor:\n\n${strategy}`);

  // Step 2: Joey & Lara work IN PARALLEL
  await victorBot.sendMessage(chatId, "🎨 Joey is writing... 🖼️ Lara is generating... (parallel)");
  const typingInterval2 = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);

  try {
    const [copy, image] = await Promise.all([
      agentJoey(`Strategy: "${strategy}"\n\nWrite ad copy for: ${task}. Headline, body, caption, hashtags.`),
      agentLara(task)
    ]);
    clearInterval(typingInterval2);

    await victorBot.sendMessage(chatId, `🎨 Joey:\n\n${copy}`);
    if (image.type === "buffer") {
      await victorBot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (Gemini)" });
    } else {
      await victorBot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (DALL-E 3)" });
    }
    await victorBot.sendMessage(chatId, "✅ Team delivery complete!");
  } catch (err) {
    clearInterval(typingInterval2);
    await victorBot.sendMessage(chatId, "Team error: " + err.message);
  }
}

victorBot.onText(/\/start/, msg => {
  conversations[msg.chat.id] = [];
  victorBot.sendMessage(msg.chat.id, "Good morning. I'm Victor — Finance Director, CL2.\n\n🧠 Victor — Strategy (Claude)\n🎨 Joey — Writing (GPT-5.4-mini)\n🖼️ Lara — Images (Gemini/DALL-E 3)\n\n/team [task] - Direct full team (parallel)\n/write [brief] - Joey writes\n/image [desc] - Lara generates\n/performance /budget /expansion\n/brief_mimi [msg] - Message Mimi\n/reset\n\nI route automatically.");
});

victorBot.onText(/\/help/, msg => {
  victorBot.sendMessage(msg.chat.id,
    "Victor's commands:\n\n🏢 /team [task]\n📊 /performance\n💰 /budget\n📈 /expansion\n✍️ /write [brief]\n🖼️ /image [description]\n📋 /clearance\n📨 /brief_mimi [msg]\n🔄 /reset\n\nAuto-routes:\n🧠 Strategy → Victor (Claude)\n🎨 Writing → Joey (GPT-5.4-mini)\n🖼️ Images → Lara (Gemini/DALL-E 3)"
  );
});

victorBot.onText(/\/performance/, msg => {
  const chatId = msg.chat.id;
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  agentVictor(chatId, "Give me a performance overview of Company C.").then(r => { clearInterval(t); victorBot.sendMessage(chatId, "🧠 Victor:\n\n" + r); });
});
victorBot.onText(/\/budget/, msg => {
  const chatId = msg.chat.id;
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  agentVictor(chatId, "What budget items need my sign-off from Company C?").then(r => { clearInterval(t); victorBot.sendMessage(chatId, "🧠 Victor:\n\n" + r); });
});
victorBot.onText(/\/expansion/, msg => {
  const chatId = msg.chat.id;
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  agentVictor(chatId, "Assess Company C expansion readiness.").then(r => { clearInterval(t); victorBot.sendMessage(chatId, "🧠 Victor:\n\n" + r); });
});
victorBot.onText(/\/reset/, msg => { conversations[msg.chat.id] = []; victorBot.sendMessage(msg.chat.id, "Reset."); });
victorBot.onText(/\/clearance/, msg => { victorBot.sendMessage(msg.chat.id, "CL1 (Top) > CL2 Victor > CL3 Joe > CL4 Mimi > CL5 Joey/Lara/Zoe/Kai"); });

victorBot.onText(/\/team (.+)/, async (msg, match) => {
  try { await handleTeam(msg.chat.id, match[1]); }
  catch (err) { victorBot.sendMessage(msg.chat.id, "Team error: " + err.message); }
});

victorBot.onText(/\/write (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  victorBot.sendChatAction(chatId, "typing");
  victorBot.sendMessage(chatId, "🎨 Joey is on it...");
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  try {
    const reply = await agentJoey(match[1]);
    clearInterval(t);
    victorBot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { clearInterval(t); victorBot.sendMessage(chatId, "Joey error: " + err.message); }
});

victorBot.onText(/\/image (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  victorBot.sendChatAction(chatId, "typing");
  victorBot.sendMessage(chatId, "🖼️ Lara is on it...");
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  try {
    const image = await agentLara(match[1]);
    clearInterval(t);
    if (image.type === "buffer") {
      await victorBot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (Gemini)" });
    } else {
      await victorBot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (DALL-E 3)" });
    }
  } catch (err) { clearInterval(t); victorBot.sendMessage(chatId, "Lara error: " + err.message); }
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
  victorBot.sendChatAction(chatId, "typing");
  victorBot.sendMessage(chatId, "🎨 Joey is reading the image...");
  const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const imageText = await readImageText(photo.file_id);
    clearInterval(t);
    if (!imageText) { victorBot.sendMessage(chatId, "Sorry, couldn't read that image."); return; }
    const caption = msg.caption || "What is in this image?";
    const reply = await agentVictor(chatId, `${caption}\n\n[Image content: ${imageText}]`);
    victorBot.sendMessage(chatId, "🧠 Victor:\n\n" + reply);
  } catch (err) { clearInterval(t); victorBot.sendMessage(chatId, "Error reading image."); }
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

  const intent = detectIntent(text);
  victorBot.sendChatAction(chatId, "typing");

  try {
    if (intent === "lara") {
      victorBot.sendMessage(chatId, "🖼️ Lara is on it...");
      const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
      const image = await agentLara(text);
      clearInterval(t);
      if (image.type === "buffer") {
        await victorBot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (Gemini)" });
      } else {
        await victorBot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (DALL-E 3)" });
      }
    } else if (intent === "joey") {
      victorBot.sendMessage(chatId, "🎨 Joey is on it...");
      const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
      const reply = await agentJoey(text);
      clearInterval(t);
      victorBot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
    } else {
      const t = setInterval(() => victorBot.sendChatAction(chatId, "typing"), 4500);
      const reply = await agentVictor(chatId, text);
      clearInterval(t);
      victorBot.sendMessage(chatId, "🧠 Victor:\n\n" + reply);
    }
  } catch (err) { victorBot.sendMessage(chatId, "Something went wrong."); }
});

console.log("Victor online — Claude (Victor) + GPT-5.4-mini (Joey) + Gemini/DALL-E 3 (Lara) + Parallel Team Mode.");
