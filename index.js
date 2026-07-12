const {
  Client, GatewayIntentBits, EmbedBuilder,
  SlashCommandBuilder, REST, Routes,
  AttachmentBuilder, Partials,
} = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN_CODE;
const CLIENT_ID = process.env.CLIENT_ID_CODE;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "deepseek-r1-distill-llama-70b";

async function askGroq(systemPrompt, userMessage, history = []) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];
  const res = await axios.post(GROQ_API, {
    model: MODEL, messages, max_tokens: 4096, temperature: 0.3,
  }, { headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" } });
  return res.data.choices[0].message.content;
}

const DB_FILE = path.join(__dirname, "history.json");
function loadDB() {
  try { if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "{}"); return JSON.parse(fs.readFileSync(DB_FILE)); } catch { return {}; }
}
function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data)); }
function getHistory(key) { return loadDB()[key] || []; }
function addHistory(key, role, content) {
  const db = loadDB(); if (!db[key]) db[key] = [];
  db[key].push({ role, content }); if (db[key].length > 20) db[key] = db[key].slice(-20); saveDB(db);
}
function clearHistory(key) { const db = loadDB(); delete db[key]; saveDB(db); }

const SYSTEM = {
  code: `You are Skibidri Code, an expert senior developer AI in Discord. Always respond in Thai (ภาษาไทย) unless user writes English. Always use code blocks with correct syntax highlighting. Be concise and practical. Add comments in code.`,
  debug: `You are Skibidri Code, debugging specialist. Always respond in Thai unless user writes English. Find ALL bugs. Explain each bug clearly. Provide fixed version with code blocks.`,
  explain: `You are Skibidri Code, code explanation expert. Always respond in Thai unless user writes English. Explain line by line or section by section. Use simple language and real-world analogies.`,
  review: `You are Skibidri Code, senior code reviewer. Always respond in Thai unless user writes English. Check: bugs, performance, security, readability. Give score 1-10 with reason. Suggest improvements.`,
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel, Partials.Message],
});

const commands = [
  new SlashCommandBuilder().setName("help").setDescription("แสดงคำสั่งทั้งหมดของ Skibidri Code"),
  new SlashCommandBuilder().setName("code").setDescription("เขียนโค้ดตามที่ต้องการ")
    .addStringOption(o => o.setName("prompt").setDescription("สิ่งที่อยากให้เขียน").setRequired(true))
    .addStringOption(o => o.setName("language").setDescription("ภาษาโปรแกรม เช่น python, js, go").setRequired(false)),
  new SlashCommandBuilder().setName("debug").setDescription("ช่วย debug โค้ด")
    .addStringOption(o => o.setName("code").setDescription("วางโค้ดที่มีปัญหา").setRequired(true))
    .addStringOption(o => o.setName("error").setDescription("error message ที่ได้รับ").setRequired(false)),
  new SlashCommandBuilder().setName("explain").setDescription("อธิบายโค้ด")
    .addStringOption(o => o.setName("code").setDescription("วางโค้ดที่ต้องการอธิบาย").setRequired(true)),
  new SlashCommandBuilder().setName("review").setDescription("รีวิวโค้ดแบบ senior dev")
    .addStringOption(o => o.setName("code").setDescription("วางโค้ดที่ต้องการรีวิว").setRequired(true)),
  new SlashCommandBuilder().setName("ask").setDescription("ถามเรื่อง programming ทั่วไป")
    .addStringOption(o => o.setName("question").setDescription("คำถามของคุณ").setRequired(true)),
  new SlashCommandBuilder().setName("clear").setDescription("ล้างประวัติสนทนา"),
  new SlashCommandBuilder().setName("model").setDescription("ดูโมเดลที่ใช้อยู่"),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try { await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) }); console.log("ลงทะเบียน commands สำเร็จ!"); }
  catch (err) { console.error("ลงทะเบียนล้มเหลว:", err); }
}

async function sendReply(interaction, content) {
  if (content.length <= 2000) return interaction.editReply(content);
  const attachment = new AttachmentBuilder(Buffer.from(content, "utf8"), { name: "response.md" });
  return interaction.editReply({ content: "📄 คำตอบยาวเกินไป ส่งเป็นไฟล์ครับ", files: [attachment] });
}

client.once("ready", async () => {
  console.log(`✅ Skibidri Code ออนไลน์! ${client.user.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();
  const { commandName, user } = interaction;
  const historyKey = interaction.guild ? `ch-${interaction.channelId}` : `dm-${user.id}`;

  if (commandName === "help") {
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("💻 Skibidri Code").setDescription(`โมเดล: \`${MODEL}\` via Groq`).addFields(
      { name: "/code <prompt> [language]", value: "เขียนโค้ด" },
      { name: "/debug <code> [error]", value: "Debug โค้ด" },
      { name: "/explain <code>", value: "อธิบายโค้ด" },
      { name: "/review <code>", value: "รีวิวโค้ดแบบ senior dev" },
      { name: "/ask <question>", value: "ถามเรื่อง programming" },
      { name: "/clear", value: "ล้างประวัติ" },
      { name: "/model", value: "ดูโมเดล" },
    ).setTimestamp()] });
  }

  if (commandName === "model") return interaction.editReply(`🤖 ใช้โมเดล \`${MODEL}\` ผ่าน Groq ครับ`);
  if (commandName === "clear") { clearHistory(historyKey); return interaction.editReply("🗑️ ล้างประวัติแล้วครับ!"); }

  try {
    let reply;
    if (commandName === "code") {
      const prompt = interaction.options.getString("prompt");
      const lang = interaction.options.getString("language") || "";
      const msg = lang ? `เขียน ${lang}: ${prompt}` : `เขียนโค้ด: ${prompt}`;
      reply = await askGroq(SYSTEM.code, msg, getHistory(historyKey));
      addHistory(historyKey, "user", msg); addHistory(historyKey, "assistant", reply);
    } else if (commandName === "debug") {
      const code = interaction.options.getString("code");
      const error = interaction.options.getString("error") || "";
      const msg = `debug โค้ดนี้:\n\`\`\`\n${code}\n\`\`\`${error ? `\nerror: ${error}` : ""}`;
      reply = await askGroq(SYSTEM.debug, msg);
    } else if (commandName === "explain") {
      const code = interaction.options.getString("code");
      reply = await askGroq(SYSTEM.explain, `อธิบายโค้ดนี้:\n\`\`\`\n${code}\n\`\`\``);
    } else if (commandName === "review") {
      const code = interaction.options.getString("code");
      reply = await askGroq(SYSTEM.review, `รีวิวโค้ดนี้:\n\`\`\`\n${code}\n\`\`\``);
    } else if (commandName === "ask") {
      const question = interaction.options.getString("question");
      reply = await askGroq(SYSTEM.code, question, getHistory(historyKey));
      addHistory(historyKey, "user", question); addHistory(historyKey, "assistant", reply);
    }
    return await sendReply(interaction, reply);
  } catch (err) {
    console.error(err);
    return interaction.editReply("❌ เกิดข้อผิดพลาด ลองใหม่ครับ");
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const isMentioned = message.mentions.has(client.user);
  const isDM = !message.guild;
  if (!isMentioned && !isDM) return;
  const userMessage = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!userMessage) return message.reply("สวัสดีครับ! ใช้ `/help` เพื่อดูคำสั่ง 💻");
  const historyKey = isDM ? `dm-${message.author.id}` : `ch-${message.channel.id}`;
  try {
    await message.channel.sendTyping();
    const reply = await askGroq(SYSTEM.code, userMessage, getHistory(historyKey));
    addHistory(historyKey, "user", userMessage); addHistory(historyKey, "assistant", reply);
    if (reply.length <= 2000) await message.reply(reply);
    else {
      const attachment = new AttachmentBuilder(Buffer.from(reply, "utf8"), { name: "response.md" });
      await message.reply({ content: "📄 คำตอบยาวเกินไป ส่งเป็นไฟล์ครับ", files: [attachment] });
    }
  } catch (err) { console.error(err); await message.reply("❌ เกิดข้อผิดพลาด ลองใหม่ครับ"); }
});

if (!TOKEN || !CLIENT_ID || !GROQ_API_KEY) { console.error("❌ ขาด ENV: DISCORD_TOKEN_CODE, CLIENT_ID_CODE, GROQ_API_KEY"); process.exit(1); }
client.login(TOKEN);
