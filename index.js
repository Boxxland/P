const {
  Client, GatewayIntentBits, EmbedBuilder,
  SlashCommandBuilder, REST, Routes,
  AttachmentBuilder, Partials,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { App } = require("@octokit/app");
const { Octokit } = require("@octokit/rest");

const TOKEN = process.env.DISCORD_TOKEN_CODE;
const CLIENT_ID = process.env.CLIENT_ID_CODE;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID;
const GITHUB_PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

// ─── GitHub App Auth ─────────────────────────────────────────────────────────
let octokit = null;

async function getOctokit() {
  if (octokit) return octokit;
  if (!GITHUB_APP_ID || !GITHUB_PRIVATE_KEY || !GITHUB_INSTALLATION_ID) return null;

  const app = new App({ appId: GITHUB_APP_ID, privateKey: GITHUB_PRIVATE_KEY });
  const installationOctokit = await app.getInstallationOctokit(parseInt(GITHUB_INSTALLATION_ID));
  octokit = installationOctokit;
  return octokit;
}

async function ghReadFile(owner, repo, filePath) {
  const kit = await getOctokit();
  if (!kit) throw new Error("GitHub App ไม่ได้ตั้งค่า");
  const res = await kit.repos.getContent({ owner, repo, path: filePath });
  const content = Buffer.from(res.data.content, "base64").toString("utf8");
  return { content, sha: res.data.sha };
}

async function ghWriteFile(owner, repo, filePath, content, sha, message = "Update via Skibidri Code") {
  const kit = await getOctokit();
  if (!kit) throw new Error("GitHub App ไม่ได้ตั้งค่า");
  await kit.repos.createOrUpdateFileContents({
    owner, repo, path: filePath,
    message,
    content: Buffer.from(content).toString("base64"),
    sha,
  });
}

async function ghCreateFile(owner, repo, filePath, content, message = "Create via Skibidri Code") {
  const kit = await getOctokit();
  if (!kit) throw new Error("GitHub App ไม่ได้ตั้งค่า");
  await kit.repos.createOrUpdateFileContents({
    owner, repo, path: filePath,
    message,
    content: Buffer.from(content).toString("base64"),
  });
}

async function ghListFiles(owner, repo, dirPath = "") {
  const kit = await getOctokit();
  if (!kit) throw new Error("GitHub App ไม่ได้ตั้งค่า");
  const res = await kit.repos.getContent({ owner, repo, path: dirPath });
  return Array.isArray(res.data) ? res.data : [res.data];
}

// ─── Groq API ─────────────────────────────────────────────────────────────────
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

// ─── History ──────────────────────────────────────────────────────────────────
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

// pending edits (channelId → { owner, repo, path, sha, original })
const pendingEdits = new Map();

// ─── System Prompts ───────────────────────────────────────────────────────────
const SYSTEM = {
  code: `You are Skibidri Code, an expert senior developer AI in Discord. Always respond in Thai (ภาษาไทย) unless user writes English. Always use code blocks with correct syntax highlighting. Be concise and practical. Add comments in code.`,
  debug: `You are Skibidri Code, debugging specialist. Always respond in Thai unless user writes English. Find ALL bugs. Explain each bug clearly. Provide fixed version with code blocks.`,
  explain: `You are Skibidri Code, code explanation expert. Always respond in Thai unless user writes English. Explain line by line or section by section. Use simple language.`,
  review: `You are Skibidri Code, senior code reviewer. Always respond in Thai unless user writes English. Check: bugs, performance, security, readability. Give score 1-10. Suggest improvements.`,
  edit: `You are Skibidri Code, code editor. You receive existing file content and an edit instruction. Return ONLY the complete modified file content with no explanation, no markdown, no code block fences. Just the raw file content.`,
};

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel, Partials.Message],
});

// ─── Slash Commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("แสดงคำสั่งทั้งหมด"),
  new SlashCommandBuilder().setName("code").setDescription("เขียนโค้ด")
    .addStringOption(o => o.setName("prompt").setDescription("สิ่งที่อยากให้เขียน").setRequired(true))
    .addStringOption(o => o.setName("language").setDescription("ภาษาโปรแกรม").setRequired(false)),
  new SlashCommandBuilder().setName("debug").setDescription("Debug โค้ด")
    .addStringOption(o => o.setName("code").setDescription("วางโค้ด").setRequired(true))
    .addStringOption(o => o.setName("error").setDescription("error message").setRequired(false)),
  new SlashCommandBuilder().setName("explain").setDescription("อธิบายโค้ด")
    .addStringOption(o => o.setName("code").setDescription("วางโค้ด").setRequired(true)),
  new SlashCommandBuilder().setName("review").setDescription("รีวิวโค้ด")
    .addStringOption(o => o.setName("code").setDescription("วางโค้ด").setRequired(true)),
  new SlashCommandBuilder().setName("ask").setDescription("ถามเรื่อง programming")
    .addStringOption(o => o.setName("question").setDescription("คำถาม").setRequired(true)),
  new SlashCommandBuilder().setName("clear").setDescription("ล้างประวัติ"),
  new SlashCommandBuilder().setName("model").setDescription("ดูโมเดล"),

  // ── GitHub Commands ──
  new SlashCommandBuilder().setName("gh-read").setDescription("อ่านไฟล์จาก GitHub")
    .addStringOption(o => o.setName("repo").setDescription("owner/repo เช่น Boxxland/6").setRequired(true))
    .addStringOption(o => o.setName("path").setDescription("path ไฟล์ เช่น index.js").setRequired(true)),

  new SlashCommandBuilder().setName("gh-list").setDescription("ดูไฟล์ใน GitHub repo")
    .addStringOption(o => o.setName("repo").setDescription("owner/repo").setRequired(true))
    .addStringOption(o => o.setName("path").setDescription("folder path (ว่างคือ root)").setRequired(false)),

  new SlashCommandBuilder().setName("gh-edit").setDescription("ให้ AI แก้ไขไฟล์ใน GitHub แล้ว push เลย")
    .addStringOption(o => o.setName("repo").setDescription("owner/repo").setRequired(true))
    .addStringOption(o => o.setName("path").setDescription("path ไฟล์").setRequired(true))
    .addStringOption(o => o.setName("instruction").setDescription("สั่งให้แก้อะไร เช่น เพิ่ม error handling").setRequired(true)),

  new SlashCommandBuilder().setName("gh-create").setDescription("สร้างไฟล์ใหม่ใน GitHub")
    .addStringOption(o => o.setName("repo").setDescription("owner/repo").setRequired(true))
    .addStringOption(o => o.setName("path").setDescription("path ไฟล์ใหม่").setRequired(true))
    .addStringOption(o => o.setName("description").setDescription("อธิบายว่าไฟล์นี้ทำอะไร").setRequired(true)),
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

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ Skibidri Code ออนไลน์! ${client.user.tag}`);
  await registerCommands();
});

// ─── Interactions ──────────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();

  const { commandName, user } = interaction;
  const historyKey = interaction.guild ? `ch-${interaction.channelId}` : `dm-${user.id}`;

  // ── Code commands ─────────────────────────────────────────────────────────
  if (commandName === "help") {
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("💻 Skibidri Code").setDescription(`โมเดล: \`${MODEL}\` via Groq`).addFields(
      { name: "💻 /code <prompt>", value: "เขียนโค้ด" },
      { name: "🐛 /debug <code>", value: "Debug โค้ด" },
      { name: "📖 /explain <code>", value: "อธิบายโค้ด" },
      { name: "🔍 /review <code>", value: "รีวิวโค้ด" },
      { name: "❓ /ask <question>", value: "ถาม programming" },
      { name: "─────────────────", value: "**GitHub Commands**" },
      { name: "📂 /gh-list <repo> [path]", value: "ดูไฟล์ใน repo" },
      { name: "📄 /gh-read <repo> <path>", value: "อ่านไฟล์จาก GitHub" },
      { name: "✏️ /gh-edit <repo> <path> <instruction>", value: "AI แก้ไขไฟล์แล้ว push เลย" },
      { name: "➕ /gh-create <repo> <path> <description>", value: "สร้างไฟล์ใหม่" },
    ).setTimestamp()] });
  }

  if (commandName === "model") return interaction.editReply(`🤖 โมเดล: \`${MODEL}\` ผ่าน Groq`);
  if (commandName === "clear") { clearHistory(historyKey); return interaction.editReply("🗑️ ล้างประวัติแล้วครับ!"); }

  if (commandName === "code") {
    const prompt = interaction.options.getString("prompt");
    const lang = interaction.options.getString("language") || "";
    const msg = lang ? `เขียน ${lang}: ${prompt}` : `เขียนโค้ด: ${prompt}`;
    try {
      const reply = await askGroq(SYSTEM.code, msg, getHistory(historyKey));
      addHistory(historyKey, "user", msg); addHistory(historyKey, "assistant", reply);
      return await sendReply(interaction, reply);
    } catch (err) { console.error(err); return interaction.editReply("❌ เกิดข้อผิดพลาดครับ"); }
  }

  if (commandName === "debug") {
    const code = interaction.options.getString("code");
    const error = interaction.options.getString("error") || "";
    const msg = `debug โค้ด:\n\`\`\`\n${code}\n\`\`\`${error ? `\nerror: ${error}` : ""}`;
    try { return await sendReply(interaction, await askGroq(SYSTEM.debug, msg)); }
    catch (err) { return interaction.editReply("❌ เกิดข้อผิดพลาดครับ"); }
  }

  if (commandName === "explain") {
    const code = interaction.options.getString("code");
    try { return await sendReply(interaction, await askGroq(SYSTEM.explain, `อธิบาย:\n\`\`\`\n${code}\n\`\`\``)); }
    catch (err) { return interaction.editReply("❌ เกิดข้อผิดพลาดครับ"); }
  }

  if (commandName === "review") {
    const code = interaction.options.getString("code");
    try { return await sendReply(interaction, await askGroq(SYSTEM.review, `รีวิว:\n\`\`\`\n${code}\n\`\`\``)); }
    catch (err) { return interaction.editReply("❌ เกิดข้อผิดพลาดครับ"); }
  }

  if (commandName === "ask") {
    const question = interaction.options.getString("question");
    try {
      const reply = await askGroq(SYSTEM.code, question, getHistory(historyKey));
      addHistory(historyKey, "user", question); addHistory(historyKey, "assistant", reply);
      return await sendReply(interaction, reply);
    } catch (err) { return interaction.editReply("❌ เกิดข้อผิดพลาดครับ"); }
  }

  // ── GitHub Commands ────────────────────────────────────────────────────────

  if (commandName === "gh-list") {
    const [owner, repo] = interaction.options.getString("repo").split("/");
    const dirPath = interaction.options.getString("path") || "";
    try {
      const files = await ghListFiles(owner, repo, dirPath);
      const lines = files.map(f => `${f.type === "dir" ? "📁" : "📄"} \`${f.name}\``).join("\n");
      const embed = new EmbedBuilder()
        .setColor(0x24292e)
        .setTitle(`📂 ${owner}/${repo}${dirPath ? `/${dirPath}` : ""}`)
        .setDescription(lines || "ว่างเปล่า")
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      return interaction.editReply(`❌ ดูไฟล์ไม่ได้: ${err.message}`);
    }
  }

  if (commandName === "gh-read") {
    const [owner, repo] = interaction.options.getString("repo").split("/");
    const filePath = interaction.options.getString("path");
    try {
      const { content } = await ghReadFile(owner, repo, filePath);
      const preview = content.length > 1800 ? content.slice(0, 1800) + "\n... (ตัดออก)" : content;
      const ext = filePath.split(".").pop() || "";
      const reply = `📄 **${owner}/${repo}/${filePath}**\n\`\`\`${ext}\n${preview}\n\`\`\``;
      return await sendReply(interaction, reply);
    } catch (err) {
      console.error(err);
      return interaction.editReply(`❌ อ่านไฟล์ไม่ได้: ${err.message}`);
    }
  }

  if (commandName === "gh-edit") {
    const [owner, repo] = interaction.options.getString("repo").split("/");
    const filePath = interaction.options.getString("path");
    const instruction = interaction.options.getString("instruction");
    try {
      await interaction.editReply(`⏳ กำลังอ่านไฟล์ **${filePath}** แล้วให้ AI แก้ไข...`);
      const { content, sha } = await ghReadFile(owner, repo, filePath);

      // ให้ AI แก้ไฟล์
      const prompt = `นี่คือไฟล์ ${filePath}:\n\n${content}\n\nสั่ง: ${instruction}`;
      const newContent = await askGroq(SYSTEM.edit, prompt);

      // push ขึ้น GitHub เลย
      await ghWriteFile(owner, repo, filePath, newContent, sha, `✏️ ${instruction} (via Skibidri Code)`);

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ แก้ไขและ push สำเร็จ!")
        .addFields(
          { name: "📁 Repo", value: `${owner}/${repo}`, inline: true },
          { name: "📄 ไฟล์", value: filePath, inline: true },
          { name: "📝 สั่ง", value: instruction },
        )
        .setTimestamp();
      return interaction.editReply({ content: "", embeds: [embed] });
    } catch (err) {
      console.error(err);
      return interaction.editReply(`❌ แก้ไขไม่สำเร็จ: ${err.message}`);
    }
  }

  if (commandName === "gh-create") {
    const [owner, repo] = interaction.options.getString("repo").split("/");
    const filePath = interaction.options.getString("path");
    const description = interaction.options.getString("description");
    try {
      await interaction.editReply(`⏳ กำลังสร้างไฟล์ **${filePath}**...`);
      const ext = filePath.split(".").pop() || "";
      const prompt = `สร้างไฟล์ ${filePath} (${ext}) สำหรับ: ${description}\nReturn ONLY raw file content, no markdown fences.`;
      const newContent = await askGroq(SYSTEM.code, prompt);

      await ghCreateFile(owner, repo, filePath, newContent, `➕ สร้าง ${filePath} (via Skibidri Code)`);

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ สร้างไฟล์และ push สำเร็จ!")
        .addFields(
          { name: "📁 Repo", value: `${owner}/${repo}`, inline: true },
          { name: "📄 ไฟล์", value: filePath, inline: true },
          { name: "📝 รายละเอียด", value: description },
        )
        .setTimestamp();
      return interaction.editReply({ content: "", embeds: [embed] });
    } catch (err) {
      console.error(err);
      return interaction.editReply(`❌ สร้างไฟล์ไม่สำเร็จ: ${err.message}`);
    }
  }
});

// ─── Mention / DM ──────────────────────────────────────────────────────────────
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
      await message.reply({ content: "📄 คำตอบยาว ส่งเป็นไฟล์ครับ", files: [attachment] });
    }
  } catch (err) { console.error(err); await message.reply("❌ เกิดข้อผิดพลาดครับ"); }
});

if (!TOKEN || !CLIENT_ID || !GROQ_API_KEY) {
  console.error("❌ ขาด ENV: DISCORD_TOKEN_CODE, CLIENT_ID_CODE, GROQ_API_KEY");
  process.exit(1);
}

client.login(TOKEN);
