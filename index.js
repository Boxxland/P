const {
  Client, GatewayIntentBits, EmbedBuilder,
  SlashCommandBuilder, REST, Routes,
  AttachmentBuilder, Partials,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");

const TOKEN = process.env.DISCORD_TOKEN_CODE;
const CLIENT_ID = process.env.CLIENT_ID_CODE;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID;

let GITHUB_PRIVATE_KEY = null;
const PEM_FILE = path.join(__dirname, "private-key.pem");
if (fs.existsSync(PEM_FILE)) {
  GITHUB_PRIVATE_KEY = fs.readFileSync(PEM_FILE, "utf8");
} else if (process.env.GITHUB_PRIVATE_KEY) {
  GITHUB_PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY
    .replace(/\|/g, "\n")
    .replace(/\\n/g, "\n");
}

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

// ─── Random Greetings ────────────────────────────────────────────────────────
const GREETINGS = [
  "วันนี้ข้าวอร่อยไหม? 🍚",
  "โค้ดวันนี้ compile ได้ไหม? 💻",
  "git push แล้วยัง? 📤",
  "debug เสร็จยัง? 🐛",
  "npm install แล้วหรือยัง? 📦",
  "coffee พร้อมยัง? ☕",
  "วันนี้ merge conflict ไหม? 😅",
  "stack overflow เปิดอยู่ไหม? 🔍",
  "production พัง รึเปล่า? 🚨",
  "test case ผ่านหมดไหม? ✅",
  "ลืม semicolon ไหม? 😬",
  "วันนี้ deadline กี่โมง? ⏰",
];

function randomGreeting() {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
}

// ─── Home Panel Builder ───────────────────────────────────────────────────────
async function buildHomePanel(githubUsername = null) {
  const greeting = githubUsername
    ? `สวัสดี **${githubUsername}** 👋\n${randomGreeting()}`
    : `สวัสดีครับ! 👋\n${randomGreeting()}`;

  const ghReady = !!(GITHUB_APP_ID && GITHUB_PRIVATE_KEY && GITHUB_INSTALLATION_ID);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("💻 Skibidri Code — Home")
    .setDescription(greeting)
    .addFields(
      { name: "🤖 AI Model", value: `\`${MODEL}\` via Groq`, inline: true },
      { name: "🔗 GitHub", value: ghReady ? `✅ \`${githubUsername || "เชื่อมต่อแล้ว"}\`` : "⚠️ ยังไม่ได้ตั้งค่า", inline: true },
    )
    .setFooter({ text: "Skibidri Code • กดปุ่มด้านล่างเพื่อเริ่มใช้งาน" })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("home_createfile").setLabel("สร้างไฟล์").setEmoji("📄").setStyle(ButtonStyle.Primary).setDisabled(!ghReady),
    new ButtonBuilder().setCustomId("home_createrepo").setLabel("สร้างเรโป").setEmoji("📁").setStyle(ButtonStyle.Primary).setDisabled(!ghReady),
    new ButtonBuilder().setCustomId("home_readfile").setLabel("อ่านไฟล์").setEmoji("🔍").setStyle(ButtonStyle.Secondary).setDisabled(!ghReady),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("home_codenow").setLabel("Code Now").setEmoji("⚡").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("home_debug").setLabel("Debug").setEmoji("🐛").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("home_ask").setLabel("ถาม").setEmoji("❓").setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ─── User PAT Storage ─────────────────────────────────────────────────────────
const TOKENS_FILE = path.join(__dirname, "tokens.json");
function loadTokens() {
  try { if (!fs.existsSync(TOKENS_FILE)) fs.writeFileSync(TOKENS_FILE, "{}"); return JSON.parse(fs.readFileSync(TOKENS_FILE)); } catch { return {}; }
}
function saveTokens(data) { fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2)); }
function getUserToken(userId) { return loadTokens()[userId] || null; }
function setUserToken(userId, token) { const t = loadTokens(); t[userId] = token; saveTokens(t); }
function removeUserToken(userId) { const t = loadTokens(); delete t[userId]; saveTokens(t); }

// ─── GitHub Auth (PAT หรือ App) ───────────────────────────────────────────────
let appOctokit = null;

async function getOctokit(userId = null) {
  // ลองใช้ PAT ของ user ก่อน
  if (userId) {
    const pat = getUserToken(userId);
    if (pat) return new Octokit({ auth: pat });
  }

  // fallback เป็น GitHub App
  if (!GITHUB_APP_ID || !GITHUB_PRIVATE_KEY || !GITHUB_INSTALLATION_ID) return null;
  if (appOctokit) return appOctokit;

  const auth = createAppAuth({
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_PRIVATE_KEY,
    installationId: parseInt(GITHUB_INSTALLATION_ID),
  });

  const { token } = await auth({ type: "installation" });
  appOctokit = new Octokit({ auth: token });
  return appOctokit;
}

async function ghReadFile(owner, repo, filePath, userId = null) {
  const kit = await getOctokit(userId);
  if (!kit) throw new Error("กรุณา login ด้วย /gh-login ก่อนครับ");
  const res = await kit.repos.getContent({ owner, repo, path: filePath });
  const content = Buffer.from(res.data.content, "base64").toString("utf8");
  return { content, sha: res.data.sha };
}

async function ghWriteFile(owner, repo, filePath, content, sha, message = "Update via Skibidri Code", userId = null) {
  const kit = await getOctokit(userId);
  if (!kit) throw new Error("กรุณา login ด้วย /gh-login ก่อนครับ");
  await kit.repos.createOrUpdateFileContents({ owner, repo, path: filePath, message, content: Buffer.from(content).toString("base64"), sha });
}

async function ghCreateFile(owner, repo, filePath, content, message = "Create via Skibidri Code", userId = null) {
  const kit = await getOctokit(userId);
  if (!kit) throw new Error("กรุณา login ด้วย /gh-login ก่อนครับ");
  await kit.repos.createOrUpdateFileContents({ owner, repo, path: filePath, message, content: Buffer.from(content).toString("base64") });
}

async function ghListFiles(owner, repo, dirPath = "", userId = null) {
  const kit = await getOctokit(userId);
  if (!kit) throw new Error("กรุณา login ด้วย /gh-login ก่อนครับ");
  const res = await kit.repos.getContent({ owner, repo, path: dirPath });
  return Array.isArray(res.data) ? res.data : [res.data];
}

async function ghListRepos(userId = null) {
  const kit = await getOctokit(userId);
  if (!kit) throw new Error("กรุณา login ด้วย /gh-login ก่อนครับ");
  const res = await kit.repos.listForAuthenticatedUser({ per_page: 30, sort: "updated" });
  return res.data;
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
  new SlashCommandBuilder().setName("home").setDescription("เปิดหน้าหลัก Skibidri Code"),
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

  new SlashCommandBuilder().setName("gh-login").setDescription("เชื่อมบัญชี GitHub ด้วย Personal Access Token"),
  new SlashCommandBuilder().setName("gh-logout").setDescription("ตัดการเชื่อมต่อ GitHub"),
  new SlashCommandBuilder().setName("gh-repos").setDescription("ดูรายการ repo ของคุณ"),
  new SlashCommandBuilder().setName("gh-setup").setDescription("วิธีเชื่อม GitHub App กับ Skibidri Code"),
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

  // ── Button Handlers (Home Panel) ─────────────────────────────────────────
  if (interaction.isButton()) {
    const customId = interaction.customId;

    if (customId === "home_codenow") {
      const modal = new ModalBuilder().setCustomId("modal_codenow").setTitle("⚡ Code Now — เขียนโค้ดแล้ว Push เลย");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("repo").setLabel("owner/repo เช่น Boxxland/6").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("filepath").setLabel("ชื่อไฟล์ เช่น utils/helper.js").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("prompt").setLabel("อธิบายว่าอยากให้โค้ดทำอะไร").setStyle(TextInputStyle.Paragraph).setRequired(true)),
      );
      return interaction.showModal(modal);
    }

    if (customId === "home_debug") {
      const modal = new ModalBuilder().setCustomId("modal_debug_home").setTitle("🐛 Debug โค้ด");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("code").setLabel("วางโค้ดที่มีปัญหา").setStyle(TextInputStyle.Paragraph).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("error").setLabel("error message (ถ้ามี)").setStyle(TextInputStyle.Short).setRequired(false)),
      );
      return interaction.showModal(modal);
    }

    if (customId === "home_ask") {
      const modal = new ModalBuilder().setCustomId("modal_ask_home").setTitle("❓ ถาม Skibidri Code");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("question").setLabel("คำถาม").setStyle(TextInputStyle.Paragraph).setRequired(true)),
      );
      return interaction.showModal(modal);
    }

    if (customId === "home_createfile") {
      const modal = new ModalBuilder().setCustomId("modal_createfile").setTitle("📄 สร้างไฟล์ใหม่");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("repo").setLabel("owner/repo").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("filepath").setLabel("path ไฟล์ เช่น src/utils.js").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("description").setLabel("อธิบายว่าไฟล์นี้ทำอะไร").setStyle(TextInputStyle.Paragraph).setRequired(true)),
      );
      return interaction.showModal(modal);
    }

    if (customId === "home_createrepo") {
      const modal = new ModalBuilder().setCustomId("modal_createrepo").setTitle("📁 สร้าง Repository ใหม่");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reponame").setLabel("ชื่อ repo เช่น my-project").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("description").setLabel("คำอธิบาย repo").setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("private").setLabel("private? (yes/no)").setStyle(TextInputStyle.Short).setRequired(false).setValue("no")),
      );
      return interaction.showModal(modal);
    }

    if (customId === "home_readfile") {
      const modal = new ModalBuilder().setCustomId("modal_readfile").setTitle("🔍 อ่านไฟล์จาก GitHub");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("repo").setLabel("owner/repo").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("filepath").setLabel("path ไฟล์").setStyle(TextInputStyle.Short).setRequired(true)),
      );
      return interaction.showModal(modal);
    }
  }

  // ── Modal Handlers ────────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    await interaction.deferReply();

    if (interaction.customId === "modal_ghlogin") {
      const pat = interaction.fields.getTextInputValue("pat").trim();
      try {
        // ทดสอบ token ก่อน
        const testKit = new Octokit({ auth: pat });
        const { data } = await testKit.users.getAuthenticated();
        setUserToken(interaction.user.id, pat);
        return interaction.editReply({ ephemeral: true, embeds: [new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("✅ เชื่อม GitHub สำเร็จ!")
          .setThumbnail(data.avatar_url)
          .addFields(
            { name: "👤 บัญชี", value: `[${data.login}](${data.html_url})`, inline: true },
            { name: "📁 Repos", value: `${data.public_repos} public`, inline: true },
          )
          .setFooter({ text: "Token เก็บไว้ local ไม่มีใครเห็นครับ" })
          .setTimestamp()
        ]});
      } catch (err) {
        return interaction.editReply({ ephemeral: true, content: "❌ Token ไม่ถูกต้องหรือหมดอายุแล้วครับ กรุณาสร้าง token ใหม่" });
      }
    }

    if (interaction.customId === "modal_codenow") {
      const repoFull = interaction.fields.getTextInputValue("repo");
      const filepath = interaction.fields.getTextInputValue("filepath");
      const prompt = interaction.fields.getTextInputValue("prompt");
      const [owner, repo] = repoFull.split("/");

      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xfbbf24).setTitle("⚡ กำลังเขียนโค้ด...").setDescription(`AI กำลังเขียน \`${filepath}\` แล้ว push ขึ้น \`${repoFull}\``) ] });

      try {
        const ext = filepath.split(".").pop() || "";
        const code = await askGroq(SYSTEM.code, `เขียนไฟล์ ${filepath} (${ext}): ${prompt}\nReturn ONLY raw file content.`);

        // เช็คว่าไฟล์มีอยู่แล้วไหม (update or create)
        let sha = null;
        try { const f = await ghReadFile(owner, repo, filepath); sha = f.sha; } catch {}

        if (sha) {
          await ghWriteFile(owner, repo, filepath, code, sha, `⚡ ${prompt} (via Skibidri Code Now)`);
        } else {
          await ghCreateFile(owner, repo, filepath, code, `⚡ ${prompt} (via Skibidri Code Now)`);
        }

        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setAuthor({ name: repoFull, iconURL: `https://github.com/${owner}.png` })
          .setTitle("✅ เขียนโค้ดและ Push สำเร็จ!")
          .setURL(`https://github.com/${owner}/${repo}/blob/main/${filepath}`)
          .addFields(
            { name: "📄 ไฟล์", value: `\`${filepath}\``, inline: true },
            { name: "📝 บรรทัด", value: `${code.split("\n").length} lines`, inline: true },
            { name: "💬 คำสั่ง", value: prompt },
          )
          .setFooter({ text: sha ? "Updated existing file" : "Created new file" })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("❌ ล้มเหลว").setDescription(err.message)] });
      }
    }

    if (interaction.customId === "modal_debug_home") {
      const code = interaction.fields.getTextInputValue("code");
      const error = interaction.fields.getTextInputValue("error") || "";
      const msg = `debug โค้ด:\n\`\`\`\n${code}\n\`\`\`${error ? `\nerror: ${error}` : ""}`;
      try { return await sendReply(interaction, await askGroq(SYSTEM.debug, msg)); }
      catch (err) { return interaction.editReply("❌ เกิดข้อผิดพลาดครับ"); }
    }

    if (interaction.customId === "modal_ask_home") {
      const question = interaction.fields.getTextInputValue("question");
      const historyKey = interaction.guild ? `ch-${interaction.channelId}` : `dm-${interaction.user.id}`;
      try {
        const reply = await askGroq(SYSTEM.code, question, getHistory(historyKey));
        addHistory(historyKey, "user", question); addHistory(historyKey, "assistant", reply);
        return await sendReply(interaction, reply);
      } catch (err) { return interaction.editReply("❌ เกิดข้อผิดพลาดครับ"); }
    }

    if (interaction.customId === "modal_createfile") {
      const repoFull = interaction.fields.getTextInputValue("repo");
      const filepath = interaction.fields.getTextInputValue("filepath");
      const description = interaction.fields.getTextInputValue("description");
      const [owner, repo] = repoFull.split("/");
      try {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xfbbf24).setTitle("⏳ กำลังสร้างไฟล์...")] });
        const ext = filepath.split(".").pop() || "";
        const content = await askGroq(SYSTEM.code, `สร้างไฟล์ ${filepath} (${ext}): ${description}\nReturn ONLY raw file content.`);
        await ghCreateFile(owner, repo, filepath, content, `➕ ${filepath} (via Skibidri Code)`);
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle("✅ สร้างไฟล์สำเร็จ!").setURL(`https://github.com/${owner}/${repo}/blob/main/${filepath}`).addFields({ name: "📄 ไฟล์", value: `\`${filepath}\``, inline: true }, { name: "📝 บรรทัด", value: `${content.split("\n").length} lines`, inline: true }).setTimestamp()] });
      } catch (err) { return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("❌ ล้มเหลว").setDescription(err.message)] }); }
    }

    if (interaction.customId === "modal_createrepo") {
      const reponame = interaction.fields.getTextInputValue("reponame");
      const description = interaction.fields.getTextInputValue("description") || "";
      const isPrivate = interaction.fields.getTextInputValue("private")?.toLowerCase() === "yes";
      try {
        const kit = await getOctokit();
        if (!kit) return interaction.editReply("❌ GitHub App ไม่ได้ตั้งค่าครับ");
        await kit.repos.createForAuthenticatedUser({ name: reponame, description, private: isPrivate, auto_init: true });
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle("✅ สร้าง Repo สำเร็จ!").setURL(`https://github.com/${reponame}`).addFields({ name: "📁 ชื่อ", value: `\`${reponame}\``, inline: true }, { name: "🔒 Privacy", value: isPrivate ? "Private" : "Public", inline: true }).setTimestamp()] });
      } catch (err) { return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("❌ ล้มเหลว").setDescription(err.message)] }); }
    }

    if (interaction.customId === "modal_readfile") {
      const repoFull = interaction.fields.getTextInputValue("repo");
      const filepath = interaction.fields.getTextInputValue("filepath");
      const [owner, repo] = repoFull.split("/");
      try {
        const { content, sha } = await ghReadFile(owner, repo, filepath);
        const ext = filepath.split(".").pop() || "";
        const lines = content.split("\n").length;
        const size = Buffer.byteLength(content, "utf8");
        const sizeStr = size > 1024 ? `${(size/1024).toFixed(1)}KB` : `${size}B`;
        const preview = content.length > 1500 ? content.slice(0, 1500) + "\n... (ตัดออก)" : content;
        const embed = new EmbedBuilder().setColor(0x0d1117).setAuthor({ name: repoFull, iconURL: `https://github.com/${owner}.png` }).setTitle(`📄 ${filepath}`).setURL(`https://github.com/${owner}/${repo}/blob/main/${filepath}`).addFields({ name: "📏 ขนาด", value: sizeStr, inline: true }, { name: "📝 บรรทัด", value: `${lines} lines`, inline: true }, { name: "🔑 SHA", value: `\`${sha.slice(0, 7)}\``, inline: true }).setTimestamp();
        const codeStr = `\`\`\`${ext}\n${preview}\n\`\`\``;
        if (codeStr.length <= 2000) return interaction.editReply({ content: codeStr, embeds: [embed] });
        const attachment = new AttachmentBuilder(Buffer.from(content, "utf8"), { name: filepath.split("/").pop() });
        return interaction.editReply({ embeds: [embed], files: [attachment] });
      } catch (err) { return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("❌ ล้มเหลว").setDescription(err.message)] }); }
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();

  const { commandName, user } = interaction;
  const historyKey = interaction.guild ? `ch-${interaction.channelId}` : `dm-${user.id}`;

  // ── Code commands ─────────────────────────────────────────────────────────
  if (commandName === "home") {
    let ghUsername = null;
    try {
      const kit = await getOctokit();
      if (kit) {
        const { data } = await kit.users.getAuthenticated();
        ghUsername = data.login;
      }
    } catch {}
    return interaction.editReply(await buildHomePanel(ghUsername));
  }

  if (commandName === "help") {
    const ghReady = !!(GITHUB_APP_ID && GITHUB_PRIVATE_KEY && GITHUB_INSTALLATION_ID);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("💻 Skibidri Code").setDescription(`โมเดล: \`${MODEL}\` via Groq`).addFields(
      { name: "🏠 /home", value: "หน้าหลัก + ปุ่มลัดทุกอย่าง" },
      { name: "💻 /code <prompt>", value: "เขียนโค้ด" },
      { name: "🐛 /debug <code>", value: "Debug โค้ด" },
      { name: "📖 /explain <code>", value: "อธิบายโค้ด" },
      { name: "🔍 /review <code>", value: "รีวิวโค้ด" },
      { name: "❓ /ask <question>", value: "ถาม programming" },
      { name: "🗑️ /clear", value: "ล้างประวัติ" },
      { name: "─────────────────", value: `**GitHub Commands** ${ghReady ? "✅ พร้อมใช้" : "⚠️ ยังไม่ได้เชื่อม — ใช้ /gh-setup"}` },
      { name: "📂 /gh-list <repo>", value: "ดูไฟล์ใน repo" },
      { name: "📄 /gh-read <repo> <path>", value: "อ่านไฟล์" },
      { name: "✏️ /gh-edit <repo> <path>", value: "AI แก้ไฟล์แล้ว push" },
      { name: "➕ /gh-create <repo> <path>", value: "สร้างไฟล์ใหม่แล้ว push" },
      { name: "🔧 /gh-setup", value: "ดูวิธีเชื่อม GitHub App" },
    ).setTimestamp()] });
  }

  if (commandName === "gh-login") {
    const modal = new ModalBuilder().setCustomId("modal_ghlogin").setTitle("🔑 เชื่อม GitHub Account");
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("pat")
          .setLabel("Personal Access Token (ghp_xxxxxxxx)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("ghp_xxxxxxxxxxxxxxxxxxxx")
      )
    );
    return interaction.showModal(modal);
  }

  if (commandName === "gh-logout") {
    removeUserToken(user.id);
    return interaction.editReply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("👋 ตัดการเชื่อมต่อแล้ว").setDescription("ลบ GitHub token ออกแล้วครับ").setTimestamp()] });
  }

  if (commandName === "gh-repos") {
    try {
      const repos = await ghListRepos(user.id);
      const lines = repos.map(r => {
        const icon = r.private ? "🔒" : "🌐";
        const lang = r.language ? ` \`${r.language}\`` : "";
        const stars = r.stargazers_count > 0 ? ` ⭐${r.stargazers_count}` : "";
        return `${icon} **[${r.name}](${r.html_url})**${lang}${stars}`;
      }).join("\n");

      const pat = getUserToken(user.id);
      const kit = await getOctokit(user.id);
      let username = "Unknown";
      try { const { data } = await kit.users.getAuthenticated(); username = data.login; } catch {}

      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(0x24292e)
        .setAuthor({ name: username, iconURL: `https://github.com/${username}.png` })
        .setTitle(`📁 Repositories ของ ${username}`)
        .setDescription(lines || "ไม่มี repo")
        .setFooter({ text: `${repos.length} repos • อัปเดตล่าสุด` })
        .setTimestamp()
      ]});
    } catch (err) {
      return interaction.editReply(`❌ ${err.message}`);
    }
  }

  if (commandName === "gh-setup") {
    return interaction.editReply({ embeds: [
      new EmbedBuilder()
        .setColor(0x24292e)
        .setTitle("🔧 วิธีเชื่อม GitHub App กับ Skibidri Code")
        .addFields(
          { name: "1️⃣ สร้าง GitHub App", value: "ไปที่ github.com/settings/apps → **New GitHub App**\n• ชื่อ: `Skibidri-code`\n• Permissions → Contents: **Read & Write**" },
          { name: "2️⃣ หา App ID", value: "อยู่ในหน้า General ของ App ที่สร้างครับ เช่น `4276194`" },
          { name: "3️⃣ Generate Private Key", value: "เลื่อนลงหา **Private keys** → **Generate a private key**\nโหลดไฟล์ `.pem` มาเก็บไว้" },
          { name: "4️⃣ Install App & หา Installation ID", value: "กด **Install App** → เลือก Org/User → กำหนด repo\nดู URL: `github.com/settings/installations/xxxxxxxxx`\nเลขท้ายคือ Installation ID ครับ" },
          { name: "5️⃣ ตั้งค่า ENV บน Termux", value: "```bash\n# อัปโหลด .pem ขึ้น Termux แล้วรัน\nexport GITHUB_APP_ID=\"ใส่app_id\"\nexport GITHUB_INSTALLATION_ID=\"ใส่installation_id\"\nexport GITHUB_PRIVATE_KEY=\"$(cat ~/private-key.pem | tr '\\n' '|')\"\n\n# บันทึกถาวร\necho 'export GITHUB_APP_ID=\"...\"' >> ~/.bashrc\necho 'export GITHUB_INSTALLATION_ID=\"...\"' >> ~/.bashrc\necho \"export GITHUB_PRIVATE_KEY=\\\"$(cat ~/private-key.pem | tr '\\n' '|')\\\"\" >> ~/.bashrc\nsource ~/.bashrc\npm2 restart skibidri-code --update-env\n```" },
        )
        .setFooter({ text: "หลังตั้งค่าแล้วลอง /home เพื่อเช็คสถานะครับ ✅" })
        .setTimestamp()
    ]});
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
      const dirs = files.filter(f => f.type === "dir");
      const fls = files.filter(f => f.type !== "dir");

      const dirLines = dirs.map(f => `📁 \`${f.name}/\``).join("\n");
      const fileLines = fls.map(f => {
        const size = f.size ? (f.size > 1024 ? `${(f.size/1024).toFixed(1)}KB` : `${f.size}B`) : "";
        return `📄 \`${f.name}\`${size ? ` — ${size}` : ""}`;
      }).join("\n");

      const embed = new EmbedBuilder()
        .setColor(0x24292e)
        .setAuthor({ name: `${owner}/${repo}`, iconURL: `https://github.com/${owner}.png` })
        .setTitle(`📂 ${dirPath || "/"}`)
        .setURL(`https://github.com/${owner}/${repo}/tree/main/${dirPath}`)
        .setTimestamp();

      if (dirLines) embed.addFields({ name: `📁 Folders (${dirs.length})`, value: dirLines.slice(0, 1000) });
      if (fileLines) embed.addFields({ name: `📄 Files (${fls.length})`, value: fileLines.slice(0, 1000) });

      embed.setFooter({ text: `${files.length} items • github.com/${owner}/${repo}` });
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
      const { content, sha } = await ghReadFile(owner, repo, filePath);
      const ext = filePath.split(".").pop() || "";
      const lines = content.split("\n").length;
      const size = Buffer.byteLength(content, "utf8");
      const sizeStr = size > 1024 ? `${(size/1024).toFixed(1)}KB` : `${size}B`;

      const preview = content.length > 1500 ? content.slice(0, 1500) + "\n... (ตัดออก)" : content;

      const embed = new EmbedBuilder()
        .setColor(0x0d1117)
        .setAuthor({ name: `${owner}/${repo}`, iconURL: `https://github.com/${owner}.png` })
        .setTitle(`📄 ${filePath}`)
        .setURL(`https://github.com/${owner}/${repo}/blob/main/${filePath}`)
        .addFields(
          { name: "📏 ขนาด", value: sizeStr, inline: true },
          { name: "📝 บรรทัด", value: `${lines} lines`, inline: true },
          { name: "🔑 SHA", value: `\`${sha.slice(0, 7)}\``, inline: true },
        )
        .setFooter({ text: `ใช้ /gh-edit เพื่อให้ AI แก้ไขไฟล์นี้` })
        .setTimestamp();

      const codeStr = `\`\`\`${ext}\n${preview}\n\`\`\``;
      if (codeStr.length <= 2000) {
        return interaction.editReply({ content: codeStr, embeds: [embed] });
      } else {
        const attachment = new AttachmentBuilder(Buffer.from(content, "utf8"), { name: filePath.split("/").pop() });
        return interaction.editReply({ embeds: [embed], files: [attachment] });
      }
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
      await interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(0xfbbf24)
        .setTitle("⏳ กำลังประมวลผล...")
        .setDescription(`อ่านไฟล์ \`${filePath}\` แล้วส่งให้ AI แก้ไข`)
        .setTimestamp()
      ]});

      const { content, sha } = await ghReadFile(owner, repo, filePath);
      const prompt = `นี่คือไฟล์ ${filePath}:\n\n${content}\n\nสั่ง: ${instruction}`;
      const newContent = await askGroq(SYSTEM.edit, prompt);
      await ghWriteFile(owner, repo, filePath, newContent, sha, `✏️ ${instruction} (via Skibidri Code)`);

      const diff = Math.abs(newContent.split("\n").length - content.split("\n").length);
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setAuthor({ name: `${owner}/${repo}`, iconURL: `https://github.com/${owner}.png` })
        .setTitle("✅ แก้ไขและ Push สำเร็จ!")
        .setURL(`https://github.com/${owner}/${repo}/blob/main/${filePath}`)
        .addFields(
          { name: "📄 ไฟล์", value: `\`${filePath}\``, inline: true },
          { name: "📝 คำสั่ง", value: instruction, inline: false },
          { name: "📊 บรรทัดเปลี่ยน", value: `±${diff} lines`, inline: true },
        )
        .setFooter({ text: "Committed to main • Skibidri Code" })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("❌ แก้ไขไม่สำเร็จ").setDescription(err.message).setTimestamp()] });
    }
  }

  if (commandName === "gh-create") {
    const [owner, repo] = interaction.options.getString("repo").split("/");
    const filePath = interaction.options.getString("path");
    const description = interaction.options.getString("description");
    try {
      await interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(0xfbbf24)
        .setTitle("⏳ กำลังสร้างไฟล์...")
        .setDescription(`AI กำลังเขียน \`${filePath}\``)
        .setTimestamp()
      ]});

      const ext = filePath.split(".").pop() || "";
      const prompt = `สร้างไฟล์ ${filePath} (${ext}) สำหรับ: ${description}\nReturn ONLY raw file content, no markdown fences.`;
      const newContent = await askGroq(SYSTEM.code, prompt);
      await ghCreateFile(owner, repo, filePath, newContent, `➕ สร้าง ${filePath} (via Skibidri Code)`);

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setAuthor({ name: `${owner}/${repo}`, iconURL: `https://github.com/${owner}.png` })
        .setTitle("✅ สร้างไฟล์และ Push สำเร็จ!")
        .setURL(`https://github.com/${owner}/${repo}/blob/main/${filePath}`)
        .addFields(
          { name: "📄 ไฟล์ใหม่", value: `\`${filePath}\``, inline: true },
          { name: "📝 บรรทัด", value: `${newContent.split("\n").length} lines`, inline: true },
          { name: "📋 รายละเอียด", value: description },
        )
        .setFooter({ text: "Committed to main • Skibidri Code" })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("❌ สร้างไม่สำเร็จ").setDescription(err.message).setTimestamp()] });
    }
  }
});

// ─── ระบบเช็คว่าติดตั้งแล้วยัง (guildCreate) ──────────────────────────────
client.on("guildCreate", async (guild) => {
  let channel = guild.systemChannel;
  if (!channel?.permissionsFor(guild.members.me)?.has("SendMessages")) {
    channel = guild.channels.cache.find(
      ch => ch.isTextBased() && ch.permissionsFor(guild.members.me)?.has("SendMessages")
    );
  }
  if (!channel) return;

  // ดึง GitHub username
  let ghUsername = null;
  try {
    const kit = await getOctokit();
    if (kit) { const { data } = await kit.users.getAuthenticated(); ghUsername = data.login; }
  } catch {}

  const panel = await buildHomePanel(ghUsername);
  await channel.send(panel);
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
