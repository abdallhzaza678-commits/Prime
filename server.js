// ============================================
//  Nors Control — النسخة المُصلحة بالكامل
//  ✅ السجلات تعمل ✅ الرومات تتحفظ وتسترجع
//  ✅ خطأ "اللوحة غير موجودة" مُصلح
//  ✅ الأوامر الإدارية بالاختصارات (بدون بادئات)
// ============================================
try {
  var express = require('express');
  var session = require('express-session');
  var multer = require('multer');
  var cors = require('cors');
  var fs = require('fs');
  var path = require('path');
  var cp = require('child_process');
  var { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
        EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
        ButtonBuilder, ButtonStyle, OverwriteType, Partials,
        ModalBuilder, TextInputBuilder, TextInputStyle, AuditLogEvent } = require('discord.js');
} catch(e) {
  console.log('خطأ في تحميل المكتبات: ' + e.message);
  process.exit(1);
}
var app = express();
var PORT = process.env.PORT || 3000;
try {
  if (!fs.existsSync('./public')) fs.mkdirSync('./public', { recursive: true });
  if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
  if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads', { recursive: true });
} catch(e) { console.log('تحذير مجلدات: ' + e.message); }

// ===== قاعدة بيانات JSON =====
var DB_FILE = './data/nors-control.json';
var DB = { users: [], bots: [], files: [] };
try { if (fs.existsSync(DB_FILE)) DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { console.log('تحذير قاعدة بيانات: ' + e.message); }
function saveDB(){ try { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); } catch(e){ console.log('خطأ حفظ: ' + e.message); } }
function nextId(arr){ return arr.length ? Math.max.apply(null, arr.map(function(x){return x.id;})) + 1 : 1; }
function defaultConfig(){ return { welcome: null, autoReplies: [], ticketPanels: [], logs: null, adminCommands: null, autorole: null, reactionRoles: [], customCommands: [], automod: null, levels: null, openTickets: {}, applications: [] }; }

// ===== أدوات الحماية المتقدمة =====
function isWhitelisted(member, am) {
  try {
    if (!am || !am.whitelistRoles || !am.whitelistRoles.length) return false;
    if (!member || !member.roles) return false;
    for (var i = 0; i < am.whitelistRoles.length; i++) {
      var rid = String(am.whitelistRoles[i]);
      if (rid && member.roles.cache && member.roles.cache.has(rid)) return true;
    }
    // من لديه صلاحية إدارة السيرفر مستثنى تلقائياً
    if (member.permissions && member.permissions.has && member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  } catch(e){}
  return false;
}

function applyPunishment(client, member, punishment, muteMinutes, reason, alertChannelId, extraDesc) {
  return new Promise(function(resolve) {
    (async function() {
      try {
        var punText = 'حذف فقط';
        if (punishment === 'mute' && member && member.timeout) {
          try { await member.timeout((muteMinutes || 10) * 60 * 1000, reason); punText = 'كتم ' + (muteMinutes || 10) + ' دقيقة'; } catch(e){ punText = 'كتم (فشل)'; }
        } else if (punishment === 'kick' && member && member.kick) {
          try { await member.kick(reason); punText = 'طرد'; } catch(e){ punText = 'طرد (فشل)'; }
        } else if (punishment === 'ban' && member && member.ban) {
          try { await member.ban({ reason: reason, deleteMessageSeconds: 604800 }); punText = 'حظر دائم'; } catch(e){ punText = 'حظر (فشل)'; }
        }
        if (alertChannelId) {
          try {
            var ch = await client.channels.fetch(alertChannelId).catch(function(){});
            if (ch) {
              var desc = 'العضو: <@' + (member && member.id ? member.id : 'unknown') + '>\nالسبب: ' + reason + '\nالعقاب: ' + punText;
              if (extraDesc) desc += '\n' + extraDesc;
              ch.send({ embeds: [new EmbedBuilder().setColor('#ef4444').setTitle('🛡️ تنبيه حماية').setDescription(desc).setTimestamp()] }).catch(function(){});
            }
          } catch(e){}
        }
        resolve(punText);
      } catch(e){ resolve('خطأ'); }
    })();
  });
}

function sendProtectionAlert(client, alertChannelId, title, desc, color) {
  try {
    if (!alertChannelId) return;
    client.channels.fetch(alertChannelId).then(function(ch){
      if (ch) ch.send({ embeds: [new EmbedBuilder().setColor(color || '#ef4444').setTitle(title).setDescription(desc).setTimestamp()] }).catch(function(){});
    }).catch(function(){});
  } catch(e){}
}

// تتبع الأحداث للكشف عن التهكير (NukeV)
var nukeTracker = {};  // { botId_guildId_executorId: { events: [{type, time}], lastWarn } }
var activeBots = {};
var runningProcesses = {};   // { fileId: { proc, dir, name, startedAt } }
try { if (!fs.existsSync('./uploads/bots')) fs.mkdirSync('./uploads/bots', { recursive: true }); } catch(e){}
var xpStore = {};      // { botId: { guildId: { userId: {xp, level, lastMsg} } } }
var spamStore = {};    // { botId: { guildId: { userId: {count, first, lastContent} } } }

app.use(session({ secret: 'nors-control-stable', resave: false, saveUninitialized: false, cookie: { maxAge: 30*24*60*60*1000 } }));
app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static('public'));

app.get('/health', function(req, res){ res.json({ ok: true, bots: Object.keys(activeBots).length }); });

// ===== إرسال سجل لروم معين (6 فئات + ذكر المنفذ) =====
var LOG_KEY_MAP = { msg:'msg', channels:'channels', ch:'channels', members:'members', user:'members', roles:'roles', role:'roles', joinleave:'joinleave', join:'joinleave', mod:'mod', ban:'mod' };
function sendLog(botId, guildId, type, embed, executorId) {
  try {
    var ab = activeBots[botId]; if (!ab) return;
    var cfg = ab.config || {};
    if (!cfg.logs || !cfg.logs.enabled) return;
    if (cfg.logs.guildId && String(cfg.logs.guildId) !== String(guildId)) return;
    var key = LOG_KEY_MAP[type] || type;
    var chId = cfg.logs.channels && (cfg.logs.channels[key] || cfg.logs.channels[type]);
    if (!chId) return;
    if (executorId && embed) {
      try {
        var d = (embed.data && embed.data.description) || '';
        d += '\n👤 الذي نفذ الإجراء: <@' + executorId + '>';
        embed.setDescription(d.slice(0, 4000));
      } catch(e){}
    }
    ab.client.channels.fetch(chId).then(function(ch){ if (ch) ch.send({ embeds: [embed] }).catch(function(){}); }).catch(function(){});
  } catch(e){}
}
// جلب منفذ الإجراء من سجل التدقيق (يرجع آيدي أو null)
function fetchAuditExecutor(client, guild, typeNum, targetId) {
  return new Promise(function(resolve){
    (async function(){
      try {
        var logs = await guild.fetchAuditLogs({ limit: 6, type: typeNum }).catch(function(){});
        if (!logs) return resolve(null);
        var entry = null;
        logs.entries.forEach(function(e){ if (!entry && (!targetId || (e.target && String(e.target.id) === String(targetId)))) entry = e; });
        if (entry && entry.executorId && entry.executorId !== client.user.id) resolve(entry.executorId); else resolve(null);
      } catch(e){ resolve(null); }
    })();
  });
}

// ===== تشغيل البوت =====
function startBot(botId, token) {
  return new Promise(function(resolve, reject) {
    try {
      if (activeBots[botId]) { try { if(activeBots[botId]._ints){activeBots[botId]._ints.forEach(function(i){clearInterval(i);});} activeBots[botId].client.destroy(); } catch(e){} delete activeBots[botId]; }
      var botRec = DB.bots.find(function(b){ return b.id === botId; });
      if (!botRec) return reject(new Error('البوت غير موجود'));
      var config = botRec.config || defaultConfig();
      var client = new Client({
        partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
        intents: [
          GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildBans,
          GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildModeration,
          GatewayIntentBits.DirectMessages
        ]
      });

      // ---------- معالج التذاكر (مُصلح تماماً) ----------
      client.on('interactionCreate', function(interaction) {
        (async function() {
          try {
            var isSelect = false, isButton = false;
            try { isSelect = interaction.isStringSelectMenu(); } catch(e){}
            try { isButton = interaction.isButton(); } catch(e){}
            if (!isSelect && !isButton) return;
            if (!interaction.customId || interaction.customId.indexOf('nors_ticket_') !== 0) return;
            // الإصلاح: استخدام lastIndexOf حتى لا ينكسر panelId الذي يحتوي على _
            var rest = interaction.customId.substring('nors_ticket_'.length);
            var panelId = rest, btnIdx = null;
            if (isButton) {
              var li = rest.lastIndexOf('_');
              if (li > -1) { btnIdx = rest.substring(li + 1); panelId = rest.substring(0, li); }
            }
            var liveCfg = (activeBots[botId] && activeBots[botId].config) ? activeBots[botId].config : config;
            var panel = (liveCfg.ticketPanels || []).find(function(p){ return p.id === panelId; });
            if (!panel) { try { await interaction.reply({ content: '⚠️ اللوحة غير موجودة — قد تكون قديمة. أنشئ لوحة جديدة من لوحة التحكم.', ephemeral: true }); } catch(e){} return; }
            // خيار ريست (إعادة ضبط القائمة دون فتح تذكرة)
            if (isSelect && interaction.values && interaction.values[0] === 'nors_reset') {
              var resetKey = interaction.guild.id + '_' + interaction.user.id;
              if (!liveCfg.openTickets) liveCfg.openTickets = {};
              if (liveCfg.openTickets[resetKey]) { delete liveCfg.openTickets[resetKey]; updateBotConfig(botId, liveCfg); }
              try { await interaction.reply({ content: '🔄 تم إعادة الضبط (ريست) — يمكنك الآن فتح أي تذكرة من القائمة.', ephemeral: true }); } catch(e){}
              return;
            }
            // قيد: تذكرة واحدة مفتوحة لكل عضو
            var openKey = interaction.guild.id + '_' + interaction.user.id;
            if (!liveCfg.openTickets) liveCfg.openTickets = {};
            var openRec = liveCfg.openTickets[openKey];
            if (openRec) {
              var stillOpen = true;
              try { await interaction.guild.channels.fetch(openRec.channelId); } catch(e){ stillOpen = false; }
              if (stillOpen) {
                try { await interaction.reply({ content: '⚠️ لديك تذكرة مفتوحة بالفعل: <#' + openRec.channelId + '>\nإذا تم حذفها وأردت فتح تذكرة جديدة، اختر خيار "🔄 ريست" من القائمة.', ephemeral: true }); } catch(e){}
                return;
              }
              delete liveCfg.openTickets[openKey]; updateBotConfig(botId, liveCfg);
            }
            var catLabel = 'عام';
            if (isSelect && interaction.values && interaction.values[0]) {
              var val = interaction.values[0];
              var found = (panel.categories || []).find(function(c){ return c.value === val; });
              if (found) catLabel = found.label;
            } else if (isButton && btnIdx !== null) {
              var idx = parseInt(btnIdx || '0');
              if (panel.categories && panel.categories[idx]) catLabel = panel.categories[idx].label;
            }
            var overwrites = [
              { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
              { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory], type: OverwriteType.Member }
            ];
            if (panel.mentionRoleId) overwrites.push({ id: panel.mentionRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages], type: OverwriteType.Role });
            var createOpts = { name: 'ticket-' + interaction.user.username, type: ChannelType.GuildText, permissionOverwrites: overwrites };
            if (panel.categoryId) createOpts.parent = panel.categoryId;
            var channel = await interaction.guild.channels.create(createOpts);
            // تسجيل التذكرة المفتوحة للعضو (لا يقدر يفتح ثانية حتى تحذف)
            if (!liveCfg.openTickets) liveCfg.openTickets = {};
            liveCfg.openTickets[openKey] = { channelId: channel.id, panelId: panelId, guildId: interaction.guild.id, userId: interaction.user.id };
            updateBotConfig(botId, liveCfg);
            var mentionText = '<@' + interaction.user.id + '>' + (panel.mentionRoleId ? ' <@&' + panel.mentionRoleId + '>' : '');
            var embed = new EmbedBuilder()
              .setTitle('تذكرة: ' + catLabel)
              .setDescription('مرحباً بك في التذكرة\nفريق الدعم سيجيبك في أقرب وقت.\n\nنوع التذكرة: **' + catLabel + '**')
              .setColor('#558B2F');
            await channel.send({ content: mentionText, embeds: [embed] });
            // ===== أدوات الدعم داخل التذكرة (أزرار أو قائمة منسدلة) =====
            try {
              await channel.setTopic('owner=' + interaction.user.id + '|panel=' + panelId);
              if (panel.ticketTools && panel.ticketTools !== 'none') {
                if (panel.ticketTools === 'select') {
                  var tsel = new StringSelectMenuBuilder()
                    .setCustomId('nors_tkact_select')
                    .setPlaceholder('اختر إجراءً للتذكرة...')
                    .addOptions([
                      { label: 'استلام', description: 'استلام التذكرة من قبل الدعم', value: 'claim' },
                      { label: 'اغلاق وحذف', description: 'إغلاق التذكرة وحذفها نهائياً', value: 'close' },
                      { label: 'اضافه شخص', description: 'إضافة شخص للتذكرة', value: 'add' },
                      { label: 'ازاله شخص', description: 'إزالة شخص من التذكرة', value: 'remove' },
                      { label: 'استدعاء الاداره', description: 'منشن فريق الدعم', value: 'callstaff' },
                      { label: 'استدعاء صاحب التكت', description: 'منشن صاحب التذكرة', value: 'callowner' }
                    ]);
                  await channel.send({ components: [new ActionRowBuilder().addComponents(tsel)] });
                } else {
                  var bClaim = new ButtonBuilder().setCustomId('nors_tkact_claim').setLabel('استلام').setStyle(ButtonStyle.Primary);
                  var bClose = new ButtonBuilder().setCustomId('nors_tkact_close').setLabel('اغلاق وحذف').setStyle(ButtonStyle.Danger);
                  var bAdd = new ButtonBuilder().setCustomId('nors_tkact_add').setLabel('اضافه شخص').setStyle(ButtonStyle.Success);
                  var bRem = new ButtonBuilder().setCustomId('nors_tkact_remove').setLabel('ازاله شخص').setStyle(ButtonStyle.Secondary);
                  var bStaff = new ButtonBuilder().setCustomId('nors_tkact_callstaff').setLabel('استدعاء الاداره').setStyle(ButtonStyle.Secondary);
                  var bOwner = new ButtonBuilder().setCustomId('nors_tkact_callowner').setLabel('استدعاء صاحب التكت').setStyle(ButtonStyle.Secondary);
                  await channel.send({ components: [
                    new ActionRowBuilder().addComponents(bClaim, bClose, bAdd),
                    new ActionRowBuilder().addComponents(bRem, bStaff, bOwner)
                  ]});
                }
              }
            } catch(e){ console.log('خطأ أدوات تذكرة: ' + e.message); }
            try { await interaction.reply({ content: '✅ تم إنشاء تذكرتك: <#' + channel.id + '>', ephemeral: true }); } catch(e){}
            // سجل فتح تذكرة
            sendLog(botId, interaction.guild.id, 'msg', new EmbedBuilder().setColor('#8BC34A').setTitle('🎫 تم فتح تذكرة جديدة').setDescription('العضو: <@' + interaction.user.id + '>\nالنوع: **' + catLabel + '**\nالروم: <#' + channel.id + '>').setTimestamp());
          } catch(e) {
            console.log('خطأ تذكرة: ' + e.message);
            try { await interaction.reply({ content: 'حدث خطأ: ' + e.message, ephemeral: true }); } catch(e2){}
          }
        })();
      });

      // ---------- معالج أدوات الدعم داخل التذكرة ----------
      client.on('interactionCreate', function(interaction) {
        (async function() {
          try {
            var isBtn = false, isSel = false, isModal = false;
            try { isBtn = interaction.isButton(); } catch(e){}
            try { isSel = interaction.isStringSelectMenu(); } catch(e){}
            try { isModal = interaction.isModalSubmit(); } catch(e){}
            var cid = interaction.customId || '';
            var liveCfgT = (activeBots[botId] && activeBots[botId].config) ? activeBots[botId].config : config;
            // قراءة صاحب التذكرة واللوحة من وصف الروم
            var ownerId = null, panelIdT = null;
            try {
              var topic = interaction.channel.topic || '';
              var mo = topic.match(/owner=(\d+)/); if (mo) ownerId = mo[1];
              var mp = topic.match(/panel=([^|]+)/); if (mp) panelIdT = mp[1];
            } catch(e){}
            var panelT = panelIdT ? (liveCfgT.ticketPanels || []).find(function(p){ return p.id === panelIdT; }) : null;

            // صلاحية أدوات التذكرة: فقط رتبة الدعم المحددة أو صلاحية إدارة السيرفر
            var isToolAction = cid.indexOf('nors_tkact_') === 0 || cid.indexOf('nors_tkclose_') === 0 || cid.indexOf('nors_tkmodal_') === 0;
            if (isToolAction) {
              var allowedT = false;
              try {
                if (interaction.member && interaction.member.permissions && interaction.member.permissions.has(PermissionFlagsBits.Administrator)) allowedT = true;
                if (!allowedT && panelT && panelT.mentionRoleId && interaction.member && interaction.member.roles && interaction.member.roles.cache && interaction.member.roles.cache.has(String(panelT.mentionRoleId))) allowedT = true;
                if (!allowedT && !panelT) allowedT = true; // لوحة غير معروفة — اسمح لتجنب التعطيل
              } catch(e){ allowedT = true; }
              if (!allowedT) { try { await interaction.reply({ content: '⚠️ لا تملك صلاحية استخدام أدوات التذكرة — تحتاج رتبة الدعم المحددة أو صلاحية إدارة السيرفر.', ephemeral: true }); } catch(e){} return; }
            }

            // النوافذ المنبثقة (اضافة/ازالة عضو)
            if (isModal && cid.indexOf('nors_tkmodal_') === 0) {
              var mAction = cid.substring('nors_tkmodal_'.length);
              var uid = (interaction.fields.getTextInputValue('tk_userid') || '').trim();
              if (!/^\d{15,}$/.test(uid)) { try { await interaction.reply({ content: '⚠️ آيدي غير صحيح', ephemeral: true }); } catch(e){} return; }
              if (mAction === 'add') {
                await interaction.channel.permissionOverwrites.create(uid, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
                try { await interaction.reply({ content: '✅ تمت إضافة <@' + uid + '> للتذكرة بواسطة <@' + interaction.user.id + '>' }); } catch(e){}
              } else {
                await interaction.channel.permissionOverwrites.edit(uid, { ViewChannel: false });
                try { await interaction.reply({ content: '➖ تمت إزالة <@' + uid + '> من التذكرة بواسطة <@' + interaction.user.id + '>' }); } catch(e){}
              }
              return;
            }

            // تأكيد/إلغاء حذف التذكرة
            if (isBtn && cid.indexOf('nors_tkclose_') === 0) {
              var closeAct = cid.substring('nors_tkclose_'.length);
              if (closeAct === 'cancel') {
                try { await interaction.update({ embeds: [new EmbedBuilder().setTitle('✅ تم إلغاء الإغلاق').setDescription('التذكرة مازالت مفتوحة، يمكنك المتابعة.').setColor('#8BC34A')], components: [] }); } catch(e){}
                return;
              }
              if (closeAct === 'confirm') {
                // مسح قيد التذكرة المفتوحة لصاحبها حتى يقدر يفتح تذكرة ثانية في أي وقت
                try {
                  var ownerC = null;
                  var tpC = interaction.channel.topic || '';
                  var mC = tpC.match(/owner=(\d+)/); if (mC) ownerC = mC[1];
                  var liveCfgC = (activeBots[botId] && activeBots[botId].config) ? activeBots[botId].config : config;
                  if (ownerC) {
                    var keyC = interaction.guild.id + '_' + ownerC;
                    if (!liveCfgC.openTickets) liveCfgC.openTickets = {};
                    delete liveCfgC.openTickets[keyC];
                    updateBotConfig(botId, liveCfgC);
                  }
                } catch(e){}
                try { await interaction.deferUpdate(); } catch(e){}
                try { await interaction.channel.send('🗑️ تم تأكيد الحذف — سيتم حذف التذكرة الآن...'); } catch(e){}
                var chToDelete = interaction.channel;
                setTimeout(function(){ try { chToDelete.delete(); } catch(e){} }, 1200);
                return;
              }
            }

            var action = null;
            if (isBtn && cid.indexOf('nors_tkact_') === 0) action = cid.substring('nors_tkact_'.length);
            if (isSel && cid === 'nors_tkact_select') action = interaction.values && interaction.values[0];
            if (!action) return;

            if (action === 'add' || action === 'remove') {
              var modal = new ModalBuilder()
                .setCustomId('nors_tkmodal_' + action)
                .setTitle(action === 'add' ? 'اضافه شخص للتذكرة' : 'ازالة شخص من التذكرة');
              var ti = new TextInputBuilder().setCustomId('tk_userid').setLabel('آيدي العضو (ID)').setStyle(TextInputStyle.Short).setPlaceholder('123456789012345678').setRequired(true);
              modal.addComponents(new ActionRowBuilder().addComponents(ti));
              await interaction.showModal(modal);
              return;
            }
            if (action === 'claim') {
              try { await interaction.reply({ content: '🙋 تم استلام التذكرة بواسطة <@' + interaction.user.id + '> — سيتم مساعدتك في أقرب وقت.' }); } catch(e){}
              return;
            }
            if (action === 'close') {
              var confEmbed = new EmbedBuilder()
                .setTitle('⚠️ هل أنت متأكد من الإغلاق؟')
                .setDescription('سيتم حذف التذكرة نهائياً بعد التأكيد، ويمكنك فتح تذكرة جديدة في أي وقت.')
                .setColor('#f59e0b');
              var btnConfirm = new ButtonBuilder().setCustomId('nors_tkclose_confirm').setLabel('تأكيد وحذف').setStyle(ButtonStyle.Danger);
              var btnCancel = new ButtonBuilder().setCustomId('nors_tkclose_cancel').setLabel('إلغاء الإغلاق').setStyle(ButtonStyle.Secondary);
              try { await interaction.reply({ embeds: [confEmbed], components: [new ActionRowBuilder().addComponents(btnConfirm, btnCancel)] }); } catch(e){}
              return;
            }
            if (action === 'callstaff') {
              var ping = (panelT && panelT.mentionRoleId) ? '<@&' + panelT.mentionRoleId + '>' : '';
              try { await interaction.reply({ content: '📢 تم استدعاء الإدارة ' + ping + ' بواسطة <@' + interaction.user.id + '>' }); } catch(e){}
              return;
            }
            if (action === 'callowner') {
              if (!ownerId) { try { await interaction.reply({ content: '⚠️ صاحب التذكرة غير معروف', ephemeral: true }); } catch(e){} return; }
              try { await interaction.reply({ content: '📩 تم استدعاء صاحب التذكرة <@' + ownerId + '> بواسطة <@' + interaction.user.id + '>' }); } catch(e){}
              return;
            }
          } catch(e) {
            console.log('خطأ أدوات تذكرة: ' + e.message);
            try { await interaction.reply({ content: 'حدث خطأ: ' + e.message, ephemeral: true }); } catch(e2){}
          }
        })();
      });

      // ---------- الرسائل: ردود تلقائية + أوامر مخصصة + حماية + مستويات + أوامر إدارية ----------
      client.on('messageCreate', function(msg) {
        if (msg.author.bot || !msg.guild) return;
        var liveCfg = (activeBots[botId] && activeBots[botId].config) ? activeBots[botId].config : config;
        var gid = msg.guild.id;

        // --- الأوامر الإدارية (25 أمراً — كل أمر اختصاره ونوعه) ---
        try {
          var ac = liveCfg.adminCommands;
          if (ac && ac.enabled && (!ac.guildId || String(ac.guildId) === String(gid))) {
            var content = msg.content.trim();
            var cmds = ac.commands || [];
            // ترقية تلقائية للتنسيق القديم (shortcuts object)
            if (!cmds.length && ac.shortcuts) {
              var oldMap = { kick:'kick', ban:'ban', unban:'unban', mute:'mute', unmute:'unmute', purge:'purge', addrole:'addrole', removerole:'removerole' };
              for (var ok in ac.shortcuts) { (ac.shortcuts[ok]||[]).forEach(function(s){ if (s && String(s).trim()) cmds.push({ shortcut: String(s).trim(), action: oldMap[ok] || 'kick', enabled: true }); }); }
            }
            var all = [];
            cmds.forEach(function(c){ if (c && c.enabled !== false && c.shortcut && String(c.shortcut).trim() && c.action) all.push({ action: c.action, s: String(c.shortcut).trim() }); });
            all.sort(function(a,b){ return b.s.length - a.s.length; });
            var cmd = null, rest = '', s = '';
            for (var ai = 0; ai < all.length; ai++) {
              if (content === all[ai].s || content.indexOf(all[ai].s + ' ') === 0) { cmd = all[ai].action; s = all[ai].s; rest = content.substring(all[ai].s.length).trim(); break; }
            }
            if (cmd) {
              (async function() {
                try {
                  var PERMS = { kick: PermissionFlagsBits.KickMembers, ban: PermissionFlagsBits.BanMembers, unban: PermissionFlagsBits.BanMembers, mute: PermissionFlagsBits.ModerateMembers, unmute: PermissionFlagsBits.ModerateMembers, purge: PermissionFlagsBits.ManageMessages, addrole: PermissionFlagsBits.ManageRoles, removerole: PermissionFlagsBits.ManageRoles, lock: PermissionFlagsBits.ManageChannels, unlock: PermissionFlagsBits.ManageChannels, slowmode: PermissionFlagsBits.ManageChannels, nick: PermissionFlagsBits.ManageNicknames, warn: PermissionFlagsBits.KickMembers, rename: PermissionFlagsBits.ManageChannels, hide: PermissionFlagsBits.ManageChannels, unhide: PermissionFlagsBits.ManageChannels };
                  var needPerm = PERMS[cmd] || PermissionFlagsBits.Administrator;
                  var isAdmin = false;
                  try { isAdmin = msg.member.permissions.has(needPerm); } catch(e){}
                  if (!isAdmin && ac.adminRoleId) { try { isAdmin = msg.member.roles.cache.has(ac.adminRoleId); } catch(e){} }
                  if (!isAdmin) { try { msg.reply('⛔ ليس لديك صلاحية لاستخدام هذا الأمر.'); } catch(e){} return; }
                  var target = msg.mentions.members && msg.mentions.members.first();
                  var roleM = msg.mentions.roles && msg.mentions.roles.first();
                  var num = parseInt((rest.match(/\d+/) || [])[0]) || 0;
                  var by = msg.author.tag;
                  var logMod = function(title, desc){ sendLog(botId, gid, 'mod', new EmbedBuilder().setColor('#f59e0b').setTitle(title).setDescription(desc).setTimestamp(), msg.author.id); };
                  if (cmd === 'kick') {
                    if (!target) { try { msg.reply('⚠️ اذكر العضو: ' + s + ' @العضو'); } catch(e){} return; }
                    await target.kick('أمر إداري من ' + by); try { msg.reply('✅ تم طرد ' + target.user.tag); } catch(e){}
                    logMod('🔨 طرد عضو', 'العضو: **' + target.user.tag + '**');
                  } else if (cmd === 'ban') {
                    if (!target) { try { msg.reply('⚠️ اذكر العضو: ' + s + ' @العضو'); } catch(e){} return; }
                    await target.ban({ reason: 'أمر إداري من ' + by, deleteMessageSeconds: 86400 }); try { msg.reply('✅ تم حظر ' + target.user.tag); } catch(e){}
                    logMod('⛔ حظر عضو', 'العضو: **' + target.user.tag + '**');
                  } else if (cmd === 'unban') {
                    var idM = rest.match(/(\d{15,})/);
                    if (!idM) { try { msg.reply('⚠️ اكتب آيدي المستخدم المحظور: ' + s + ' 123456...'); } catch(e){} return; }
                    await msg.guild.members.unban(idM[1]); try { msg.reply('✅ تم فك الحظر عن ' + idM[1]); } catch(e){}
                    logMod('🔓 فك حظر', 'آيدي: ' + idM[1]);
                  } else if (cmd === 'mute') {
                    if (!target) { try { msg.reply('⚠️ اذكر العضو: ' + s + ' @العضو [بالدقائق]'); } catch(e){} return; }
                    var mins = num || ac.muteMinutes || 10;
                    await target.timeout(mins * 60 * 1000, 'أمر إداري من ' + by); try { msg.reply('✅ تم كتم ' + target.user.tag + ' لمدة ' + mins + ' دقيقة'); } catch(e){}
                    logMod('🔇 كتم', 'العضو: **' + target.user.tag + '** — المدة: ' + mins + ' دقيقة');
                  } else if (cmd === 'unmute') {
                    if (!target) { try { msg.reply('⚠️ اذكر العضو: ' + s + ' @العضو'); } catch(e){} return; }
                    await target.timeout(null); try { msg.reply('✅ تم فك كتم ' + target.user.tag); } catch(e){}
                    logMod('🔊 فك كتم', 'العضو: **' + target.user.tag + '**');
                  } else if (cmd === 'purge') {
                    var count = num || 5; if (count < 1) count = 1; if (count > 100) count = 100;
                    var deleted = await msg.channel.bulkDelete(count, true);
                    try { msg.channel.send('✅ تم مسح ' + deleted.size + ' رسالة (بواسطة ' + by + ')').then(function(m){ setTimeout(function(){ m.delete().catch(function(){}); }, 3000); }); } catch(e){}
                    logMod('🧹 مسح رسائل', 'الروم: <#' + msg.channel.id + '> — العدد: ' + deleted.size);
                  } else if (cmd === 'addrole' || cmd === 'removerole') {
                    if (!target || !roleM) { try { msg.reply('⚠️ الاستخدام: ' + s + ' @العضو @الرتبة'); } catch(e){} return; }
                    if (cmd === 'addrole') { await target.roles.add(roleM.id); try { msg.reply('✅ تم إعطاء رتبة ' + roleM.name + ' لـ ' + target.user.tag); } catch(e){} logMod('➕ إعطاء رتبة', 'العضو: **' + target.user.tag + '** — الرتبة: ' + roleM.name); }
                    else { await target.roles.remove(roleM.id); try { msg.reply('✅ تم سحب رتبة ' + roleM.name + ' من ' + target.user.tag); } catch(e){} logMod('➖ سحب رتبة', 'العضو: **' + target.user.tag + '** — الرتبة: ' + roleM.name); }
                  } else if (cmd === 'lock' || cmd === 'unlock') {
                    if (cmd === 'lock') { await msg.channel.permissionOverwrites.edit(msg.guild.id, { SendMessages: false }); try { msg.reply('🔒 تم قفل الروم (لا كتابة للجميع)'); } catch(e){} logMod('🔒 قفل روم', 'الروم: <#' + msg.channel.id + '>'); }
                    else { await msg.channel.permissionOverwrites.edit(msg.guild.id, { SendMessages: null }); try { msg.reply('🔓 تم فتح الروم'); } catch(e){} logMod('🔓 فتح روم', 'الروم: <#' + msg.channel.id + '>'); }
                  } else if (cmd === 'slowmode') {
                    var secs = num || 0; if (secs > 21600) secs = 21600;
                    await msg.channel.setRateLimitPerUser(secs, 'أمر إداري من ' + by); try { msg.reply('🐌 تم ضبط الوضع البطيء: ' + secs + ' ثانية'); } catch(e){} logMod('🐌 وضع بطيء', 'الروم: <#' + msg.channel.id + '> — ' + secs + ' ثانية');
                  } else if (cmd === 'nick') {
                    if (!target) { try { msg.reply('⚠️ اذكر العضو: ' + s + ' @العضو اللقب الجديد'); } catch(e){} return; }
                    var newNick = rest.replace(/<@!?\d+>/g, '').trim();
                    await target.setNickname(newNick || null, 'أمر إداري من ' + by); try { msg.reply('✅ تم تغيير لقب ' + target.user.tag + ' إلى: ' + (newNick || '(بدون لقب)')); } catch(e){} logMod('✏️ تغيير لقب', 'العضو: **' + target.user.tag + '** — اللقب الجديد: ' + (newNick || '(بدون لقب)'));
                  } else if (cmd === 'warn') {
                    if (!target) { try { msg.reply('⚠️ اذكر العضو: ' + s + ' @العضو [السبب]'); } catch(e){} return; }
                    var warnReason = rest.replace(/<@!?\d+>/g, '').trim() || 'بدون سبب';
                    var wcfg = (liveCfg.extra && liveCfg.extra.warns) || {enabled:true,limit:3,action:'حظر',muteMin:60,logChannelId:'',warnCounts:{}};
                    if(!wcfg.warnCounts) wcfg.warnCounts={};
                    var uid=target.id; wcfg.warnCounts[uid]=(wcfg.warnCounts[uid]||0)+1;
                    var lim=parseInt(wcfg.limit||3); var reached=wcfg.warnCounts[uid]>=lim;
                    try { await target.send('⚠️ تم تحذيرك في **' + msg.guild.name + '**\nالسبب: ' + warnReason + '\nبواسطة: ' + by + '\nالتحذير رقم: '+wcfg.warnCounts[uid]+'/'+lim+(reached?'\n⛔ لقد وصلت للحد الأقصى، سيتم تطبيق الإجراء ('+wcfg.action+')':'')).catch(function(){}); } catch(e){}
                    try { msg.reply('⚠️ تم تحذير ' + target.user.tag + ' ('+wcfg.warnCounts[uid]+'/'+lim+') — السبب: ' + warnReason + (reached?' | ⛔ وصل للحد الأقصى → '+wcfg.action:'')); } catch(e){}
                    logMod('⚠️ تحذير', 'العضو: **' + target.user.tag + '** — السبب: ' + warnReason + '\nالرقم: '+wcfg.warnCounts[uid]+'/'+lim);
                    if(reached){
                      try{
                        var act2=wcfg.action||'حظر'; var mm=parseInt(wcfg.muteMin||60);
                        if(act2==='حظر'&&target.bannable) await target.ban({reason:'الحد الأقصى للتحذيرات',deleteMessageSeconds:86400});
                        else if(act2==='طرد'&&target.kickable) await target.kick('الحد الأقصى للتحذيرات');
                        else if(act2==='كتم'&&target.moderatable) await target.timeout(mm*60*1000,'الحد الأقصى للتحذيرات');
                        logMod('⛔ إجراء حد تحذيرات', 'العضو: **'+target.user.tag+'** — الإجراء: '+act2);
                      }catch(e){}
                      wcfg.warnCounts[uid]=0;
                    }
                    if(!liveCfg.extra) liveCfg.extra={}; liveCfg.extra.warns=wcfg; saveDB();
                  } else if (cmd === 'rename') {
                    var newName = rest.trim();
                    if (!newName) { try { msg.reply('⚠️ اكتب الاسم الجديد للروم'); } catch(e){} return; }
                    await msg.channel.setName(newName.substring(0, 100), 'أمر إداري من ' + by); try { msg.reply('✅ تم تغيير اسم الروم إلى: ' + newName); } catch(e){} logMod('📝 تغيير اسم روم', 'الروم: <#' + msg.channel.id + '> — الاسم الجديد: ' + newName);
                  } else if (cmd === 'hide' || cmd === 'unhide') {
                    if (cmd === 'hide') { await msg.channel.permissionOverwrites.edit(msg.guild.id, { ViewChannel: false }); try { msg.reply('🙈 تم إخفاء الروم'); } catch(e){} logMod('🙈 إخفاء روم', 'الروم: <#' + msg.channel.id + '>'); }
                    else { await msg.channel.permissionOverwrites.edit(msg.guild.id, { ViewChannel: null }); try { msg.reply('👁️ تم إظهار الروم'); } catch(e){} logMod('👁️ إظهار روم', 'الروم: <#' + msg.channel.id + '>'); }
                  }
                } catch(e) { try { msg.reply('❌ خطأ: ' + e.message); } catch(e2){} }
              })();
              return;
            }
          }
        } catch(e){ console.log('خطأ أوامر إدارية: ' + e.message); }

        // --- الحماية (AutoMod) — نسخة متقدمة بعقاب مستقل لكل نوع ---
        try {
          var am = liveCfg.automod;
          if (am && am.enabled && (!am.guildId || String(am.guildId) === String(gid))) {
            // ترقية التنسيق القديم تلقائياً
            if (typeof am.antiLinks === 'boolean') {
              am.antiLinks = { enabled: am.antiLinks, punishment: am.punishment || 'mute', muteMinutes: 10 };
              am.antiSpam = { enabled: am.antiSpam, punishment: am.punishment || 'mute', muteMinutes: 10 };
              am.antiBadWords = { enabled: am.antiBadWords, badWords: am.badWords || [], punishment: am.punishment || 'mute', muteMinutes: 10 };
              if (!am.whitelistRoles) am.whitelistRoles = [];
            }
            if (!isWhitelisted(msg.member, am)) {
              var protUsed = null, reason = '';
              if (am.antiLinks && am.antiLinks.enabled && /https?:\/\/|discord\.gg|www\.|discord\.com\/invite/i.test(msg.content)) { protUsed = am.antiLinks; reason = 'إرسال رابط'; }
              if (!protUsed && am.antiBadWords && am.antiBadWords.enabled && am.antiBadWords.badWords && am.antiBadWords.badWords.length) {
                var low = msg.content.toLowerCase();
                for (var bw = 0; bw < am.antiBadWords.badWords.length; bw++) {
                  if (am.antiBadWords.badWords[bw] && low.indexOf(String(am.antiBadWords.badWords[bw]).toLowerCase()) !== -1) { protUsed = am.antiBadWords; reason = 'كلمة محظورة / سب'; break; }
                }
              }
              if (!protUsed && am.antiSpam && am.antiSpam.enabled) {
                var key = botId + '_' + gid + '_' + msg.author.id;
                var now = Date.now();
                if (!spamStore[key]) spamStore[key] = { count: 0, first: now, last: '' };
                var s = spamStore[key];
                if (now - s.first > 5000) { s.count = 0; s.first = now; }
                s.count++;
                if (s.count > 5 || (s.last === msg.content && now - s.first < 3000)) { protUsed = am.antiSpam; reason = 'سبام وتكرار'; }
                s.last = msg.content;
              }
              if (protUsed) {
                (async function() {
                  try {
                    await msg.delete().catch(function(){});
                    var warn = await msg.channel.send('⚠️ <@' + msg.author.id + '> تم حذف رسالتك (' + reason + ')');
                    setTimeout(function(){ warn.delete().catch(function(){}); }, 4000);
                    await applyPunishment(client, msg.member, protUsed.punishment, protUsed.muteMinutes, reason, am.alertChannelId);
                  } catch(e){}
                })();
                return;
              }
            }
          }
        } catch(e){}

        // --- المستويات (Levels) ---
        try {
          var lv = liveCfg.levels;
          if (lv && lv.enabled && (!lv.guildId || String(lv.guildId) === String(gid))) {
            var xkey = botId + '_' + gid;
            if (!xpStore[xkey]) xpStore[xkey] = {};
            var ux = xpStore[xkey][msg.author.id] || { xp: 0, level: 1 };
            ux.xp += (lv.pointsPerMsg || 10);
            var newLevel = Math.floor(ux.xp / 100) + 1;
            if (newLevel > ux.level) {
              ux.level = newLevel;
              if (lv.channelId) {
                var upText = (lv.upMsg || 'مبروك {user} وصلت للمستوى {level}!').replace(/\{user\}/g, '<@' + msg.author.id + '>').replace(/\{level\}/g, newLevel);
                client.channels.fetch(lv.channelId).then(function(ch){ if(ch) ch.send(upText).catch(function(){}); }).catch(function(){});
              }
            }
            xpStore[xkey][msg.author.id] = ux;
          }
        } catch(e){}

        // --- الردود التلقائية ---
        try {
          for (var i = 0; i < (liveCfg.autoReplies || []).length; i++) {
            var ar = liveCfg.autoReplies[i];
            if (!ar.guildId || String(ar.guildId) === String(gid)) {
              if (msg.content.toLowerCase().indexOf(String(ar.trigger).toLowerCase()) !== -1) {
                try { msg.channel.send(ar.reply); } catch(e){}
                break;
              }
            }
          }
        } catch(e){}

        // --- الأوامر المخصصة (نصية) ---
        try {
          var ccFirst = msg.content.trim().split(/\s+/)[0];
          for (var ci = 0; ci < (liveCfg.customCommands || []).length; ci++) {
            var cc = liveCfg.customCommands[ci];
            if (!cc.guildId || String(cc.guildId) === String(gid)) {
              var trig = String(cc.trigger).trim();
              if (ccFirst === trig || ccFirst === '/' + trig || ccFirst === '!' + trig || msg.content.trim() === trig) {
                try { msg.channel.send(cc.reply); } catch(e){}
                break;
              }
            }
          }
        } catch(e){}
      });

      // ---------- دخول عضو: ترحيب + أوتو رول + سجل ----------
      client.on('guildMemberAdd', function(member) {
        var liveCfg3 = (activeBots[botId] && activeBots[botId].config) ? activeBots[botId].config : config;
        // أوتو رول
        if (liveCfg3.autorole && liveCfg3.autorole.enabled && liveCfg3.autorole.roleId && (!liveCfg3.autorole.guildId || String(liveCfg3.autorole.guildId) === String(member.guild.id))) {
          member.roles.add(liveCfg3.autorole.roleId).catch(function(){});
        }
        // --- حماية دخول البوتات (Anti-Bot-Join) ---
        try {
          var amB = liveCfg3.automod;
          if (amB && amB.enabled && amB.antiBotJoin && amB.antiBotJoin.enabled && member.user.bot &&
              (!amB.guildId || String(amB.guildId) === String(member.guild.id))) {
            // لا تطبق على بوتنا نفسه
            if (member.id === client.user.id) { /* skip */ }
            else {
              (async function() {
                try {
                  // اطرد البوت فوراً
                  await member.kick('بوت غير مصرح به — حماية دخول البوتات').catch(function(){});
                  // ابحث في سجل التدقيق عن من أضاف البوت (BOT_ADD = 28)
                  var inviterId = null;
                  try {
                    var logs = await member.guild.fetchAuditLogs({ type: 28, limit: 5 });
                    var entry = logs.entries.find(function(e){ return e.target && String(e.target.id) === String(member.id); });
                    if (entry) inviterId = entry.executorId;
                  } catch(e){}
                  if (inviterId && inviterId !== client.user.id) {
                    try {
                      var inviter = await member.guild.members.fetch(inviterId).catch(function(){});
                      if (inviter && !isWhitelisted(inviter, amB)) {
                        await applyPunishment(client, inviter, amB.antiBotJoin.punishment, amB.antiBotJoin.muteMinutes,
                          'إضافة بوت غير مصرح به (' + member.user.tag + ')', amB.alertChannelId,
                          'البوت المُضاف: **' + member.user.tag + '** (`' + member.id + '`)');
                      }
                    } catch(e){}
                  } else {
                    sendProtectionAlert(client, amB.alertChannelId, '🛡️ تنبيه: بوت دخل السيرفر',
                      'تم طرد البوت **' + member.user.tag + '** (`' + member.id + '`) تلقائياً.\nلم أستطع تحديد من أضافه.');
                  }
                } catch(e){}
              })();
              return; // لا ترسل سجل دخول للبوت المطروود
            }
          }
        } catch(e){}
        // رسالة الترحيب (قسم الترحيب والخروج)
        try {
          var wl = liveCfg3.welcomeLeave;
          if (wl && wl.enabled && wl.welcomeChannelId && (!wl.guildId || String(wl.guildId) === String(member.guild.id))) {
            (async function(){
              try {
                var chW = await client.channels.fetch(wl.welcomeChannelId).catch(function(){});
                if (chW) {
                  var txtW = (wl.welcomeMessage || 'مرحباً بك {user} في {server}!').replace(/\{user\}/g, '<@' + member.id + '>').replace(/\{server\}/g, member.guild.name).replace(/\{memberCount\}/g, member.guild.memberCount);
                  await chW.send(txtW).catch(function(){});
                }
              } catch(e){}
            })();
          }
        } catch(e){}
        // سجل دخول (قسم دخول وخروج)
        sendLog(botId, member.guild.id, 'joinleave', new EmbedBuilder().setColor('#8BC34A').setAuthor({ name: member.user.tag + ' دخل السيرفر', iconURL: member.user.displayAvatarURL() }).setDescription('<@' + member.id + '> انضم للسيرفر').setFooter({ text: 'آيدي: ' + member.id }).setTimestamp());
      });

      // ---------- خروج عضو (طرد أو مغادرة + رسالة الخروج) ----------
      client.on('guildMemberRemove', function(member) {
        (async function() {
          try {
            var liveCfgR = (activeBots[botId] && activeBots[botId].config) ? activeBots[botId].config : config;
            try {
              var wlR = liveCfgR.welcomeLeave;
              if (wlR && wlR.enabled && wlR.leaveChannelId && (!wlR.guildId || String(wlR.guildId) === String(member.guild.id))) {
                var chL = await client.channels.fetch(wlR.leaveChannelId).catch(function(){});
                if (chL) {
                  var txtL = (wlR.leaveMessage || '{user} غادر السيرفر {server}').replace(/\{user\}/g, '**' + member.user.tag + '**').replace(/\{server\}/g, member.guild.name).replace(/\{memberCount\}/g, member.guild.memberCount);
                  await chL.send(txtL).catch(function(){});
                }
              }
            } catch(e){}
            var kicker = await fetchAuditExecutor(client, member.guild, 20, member.id);
            if (kicker) {
              sendLog(botId, member.guild.id, 'mod', new EmbedBuilder().setColor('#f59e0b').setTitle('🔨 طرد عضو').setDescription('العضو: **' + member.user.tag + '** (`' + member.id + '`)').setTimestamp(), kicker);
            } else {
              sendLog(botId, member.guild.id, 'joinleave', new EmbedBuilder().setColor('#ef4444').setAuthor({ name: member.user.tag + ' غادر السيرفر', iconURL: member.user.displayAvatarURL() }).setDescription('<@' + member.id + '> غادر السيرفر').setFooter({ text: 'آيدي: ' + member.id }).setTimestamp());
            }
          } catch(e){}
        })();
      });

      // ---------- تعديل عضو (لقب/رتب) — قسم الأعضاء ----------
      client.on('guildMemberUpdate', function(oldM, newM) {
        (async function() {
          try {
            if (oldM.nickname !== newM.nickname) {
              var exNick = await fetchAuditExecutor(client, newM.guild, 24, newM.id);
              sendLog(botId, newM.guild.id, 'members', new EmbedBuilder().setColor('#f59e0b').setTitle('👤 تغيير اللقب').setDescription('العضو: <@' + newM.id + '>\nمن: `' + (oldM.nickname || 'بدون') + '`\nإلى: `' + (newM.nickname || 'بدون') + '`').setTimestamp(), exNick);
            }
            var oldRoles = oldM.roles.cache.map(function(r){ return r.id; });
            var newRoles = newM.roles.cache.map(function(r){ return r.id; });
            var added = newRoles.filter(function(r){ return oldRoles.indexOf(r) === -1; });
            var removed = oldRoles.filter(function(r){ return newRoles.indexOf(r) === -1; });
            if (added.length || removed.length) {
              var desc = 'العضو: <@' + newM.id + '>\n';
              if (added.length) desc += '➕ رتب مضافة: ' + added.map(function(r){ return '<@&' + r + '>'; }).join(' ') + '\n';
              if (removed.length) desc += '➖ رتب مُسحوبة: ' + removed.map(function(r){ return '<@&' + r + '>'; }).join(' ');
              var exRole = await fetchAuditExecutor(client, newM.guild, 25, newM.id);
              sendLog(botId, newM.guild.id, 'members', new EmbedBuilder().setColor('#8BC34A').setTitle('🎭 تغيير رتب عضو').setDescription(desc).setTimestamp(), exRole);
            }
          } catch(e){}
        })();
      });

      // ---------- حذف رسالة (قسم الرسائل) ----------
      client.on('messageDelete', function(message) {
        (async function() {
          try {
            if (!message.guild) return;
            var content = message.content || '(رسالة غير متاحة / مضمنة)';
            if (content.length > 1000) content = content.substring(0, 1000) + '...';
            var emb = new EmbedBuilder().setColor('#ef4444').setTitle('🗑️ حذف رسالة').setDescription('المرسل: ' + (message.author ? '<@' + message.author.id + '>' : 'غير معروف') + '\nالروم: <#' + message.channel.id + '>\nالمحتوى:\n```' + content.replace(/`/g, "'") + '```').setTimestamp();
            var ex = await fetchAuditExecutor(client, message.guild, 72, message.author ? message.author.id : null);
            sendLog(botId, message.guild.id, 'msg', emb, ex);
          } catch(e){}
        })();
      });

      // ---------- تعديل رسالة (قسم الرسائل) ----------
      client.on('messageUpdate', function(oldMsg, newMsg) {
        try {
          if (!newMsg.guild || newMsg.author && newMsg.author.bot) return;
          var oc = (oldMsg.content || '').substring(0, 500);
          var nc = (newMsg.content || '').substring(0, 500);
          if (oc === nc) return;
          sendLog(botId, newMsg.guild.id, 'msg', new EmbedBuilder().setColor('#f59e0b').setTitle('✏️ تعديل رسالة').setDescription('المرسل: <@' + newMsg.author.id + '>\nالروم: <#' + newMsg.channel.id + '>\n**قبل:** ' + oc.replace(/`/g, "'") + '\n**بعد:** ' + nc.replace(/`/g, "'")).setTimestamp(), newMsg.author.id);
        } catch(e){}
      });

      // ---------- الرومات: إنشاء/حذف/تعديل ----------
      client.on('channelCreate', function(ch){ (async function(){ try { if (!ch.guild) return; var ex = await fetchAuditExecutor(client, ch.guild, 10, ch.id); sendLog(botId, ch.guild.id, 'channels', new EmbedBuilder().setColor('#8BC34A').setTitle('📢 إنشاء روم').setDescription('الروم: <#' + ch.id + '>\nالنوع: ' + ch.type).setTimestamp(), ex); } catch(e){} })(); });
      client.on('channelDelete', function(ch){ (async function(){ try { if (!ch.guild) return; var ex = await fetchAuditExecutor(client, ch.guild, 12, ch.id); sendLog(botId, ch.guild.id, 'channels', new EmbedBuilder().setColor('#ef4444').setTitle('📢 حذف روم').setDescription('الاسم: `' + ch.name + '`').setTimestamp(), ex); } catch(e){} })(); });
      client.on('channelUpdate', function(oldC, newC){ (async function(){ try { if (!newC.guild) return; var chArr = []; if (oldC.name !== newC.name) chArr.push('الاسم: `' + oldC.name + '` → `' + newC.name + '`'); if (oldC.topic !== newC.topic) chArr.push('الموضوع (الوصف) تم تعديله'); if (oldC.nsfw !== newC.nsfw) chArr.push('إعدادات العمر تم تعديلها'); if (!chArr.length) return; var ex = await fetchAuditExecutor(client, newC.guild, 11, newC.id); sendLog(botId, newC.guild.id, 'channels', new EmbedBuilder().setColor('#f59e0b').setTitle('📢 تعديل روم').setDescription('الروم: <#' + newC.id + '>\n' + chArr.join('\n')).setTimestamp(), ex); } catch(e){} })(); });

      // ---------- رتب وصلاحيات: إنشاء/حذف/تعديل ----------
      client.on('roleCreate', function(role){ (async function(){ try { var ex = await fetchAuditExecutor(client, role.guild, 30, role.id); sendLog(botId, role.guild.id, 'roles', new EmbedBuilder().setColor('#8BC34A').setTitle('🎭 إنشاء رتبة').setDescription('الرتبة: <@&' + role.id + '>').setTimestamp(), ex); } catch(e){} })(); });
      client.on('roleDelete', function(role){ (async function(){ try { var ex = await fetchAuditExecutor(client, role.guild, 32, role.id); sendLog(botId, role.guild.id, 'roles', new EmbedBuilder().setColor('#ef4444').setTitle('🎭 حذف رتبة').setDescription('الاسم: `' + role.name + '`').setTimestamp(), ex); } catch(e){} })(); });
      client.on('roleUpdate', function(oldR, newR){ (async function(){ try { var chArr = []; if (oldR.name !== newR.name) chArr.push('الاسم: `' + oldR.name + '` → `' + newR.name + '`'); if (oldR.color !== newR.color) chArr.push('اللون تم تغييره'); if (String(oldR.permissions.bitfield) !== String(newR.permissions.bitfield)) chArr.push('الصلاحيات تم تعديلها'); if (oldR.hoist !== newR.hoist) chArr.push('العرض المنفصل تم تغييره'); if (oldR.mentionable !== newR.mentionable) chArr.push('إمكانية المنشن تم تغييرها'); if (!chArr.length) return; var ex = await fetchAuditExecutor(client, newR.guild, 31, newR.id); sendLog(botId, newR.guild.id, 'roles', new EmbedBuilder().setColor('#f59e0b').setTitle('🎭 تعديل رتبة وصلاحياتها').setDescription('الرتبة: <@&' + newR.id + '>\n' + chArr.join('\n')).setTimestamp(), ex); } catch(e){} })(); });

      // ---------- الاشراف: حظر/فك حظر ----------
      client.on('guildBanAdd', function(ban){ (async function(){ try { var ex = await fetchAuditExecutor(client, ban.guild, 22, ban.user.id); sendLog(botId, ban.guild.id, 'mod', new EmbedBuilder().setColor('#ef4444').setTitle('⛔ حظر عضو').setDescription('العضو: **' + ban.user.tag + '** (`' + ban.user.id + '`)').setTimestamp(), ex); } catch(e){} })(); });
      client.on('guildBanRemove', function(ban){ (async function(){ try { var ex = await fetchAuditExecutor(client, ban.guild, 23, ban.user.id); sendLog(botId, ban.guild.id, 'mod', new EmbedBuilder().setColor('#8BC34A').setTitle('🔓 فك حظر عضو').setDescription('العضو: **' + ban.user.tag + '** (`' + ban.user.id + '`)').setTimestamp(), ex); } catch(e){} })(); });

      // ---------- دخول وخروج: الروم الصوتية ----------
      client.on('voiceStateUpdate', function(oldS, newS) {
        try {
          if (!oldS.channelId && newS.channelId) sendLog(botId, newS.guild.id, 'joinleave', new EmbedBuilder().setColor('#8BC34A').setTitle('🔊 دخول روم صوتي').setDescription('<@' + newS.id + '> دخل <#' + newS.channelId + '>').setTimestamp());
          else if (oldS.channelId && !newS.channelId) sendLog(botId, oldS.guild.id, 'joinleave', new EmbedBuilder().setColor('#ef4444').setTitle('🔇 خروج من روم صوتي').setDescription('<@' + oldS.id + '> غادر <#' + oldS.channelId + '>').setTimestamp());
          else if (oldS.channelId && newS.channelId && oldS.channelId !== newS.channelId) sendLog(botId, newS.guild.id, 'joinleave', new EmbedBuilder().setColor('#f59e0b').setTitle('🔄 نقل بين رومات صوتية').setDescription('<@' + newS.id + '> من <#' + oldS.channelId + '> إلى <#' + newS.channelId + '>').setTimestamp());
        } catch(e){}
      });

      // ---------- الأدوار التفاعلية (Reaction Roles) ----------
      client.on('messageReactionAdd', function(reaction, user) {
        try {
          if (user.bot) return;
          var liveCfgR = (activeBots[botId] && activeBots[botId].config) ? activeBots[botId].config : config;
          var rr = (liveCfgR.reactionRoles || []).find(function(r){ return r.messageId === reaction.message.id; });
          if (!rr) return;
          var match = (reaction.emoji.name === rr.emoji) || (reaction.emoji.id && reaction.emoji.id === rr.emoji);
          if (!match) return;
          reaction.message.guild.members.fetch(user.id).then(function(m){ m.roles.add(rr.roleId).catch(function(){}); }).catch(function(){});
        } catch(e){}
      });
      client.on('messageReactionRemove', function(reaction, user) {
        try {
          if (user.bot) return;
          var liveCfgR = (activeBots[botId] && activeBots[botId].config) ? activeBots[botId].config : config;
          var rr = (liveCfgR.reactionRoles || []).find(function(r){ return r.messageId === reaction.message.id; });
          if (!rr) return;
          var match = (reaction.emoji.name === rr.emoji) || (reaction.emoji.id && reaction.emoji.id === rr.emoji);
          if (!match) return;
          reaction.message.guild.members.fetch(user.id).then(function(m){ m.roles.remove(rr.roleId).catch(function(){}); }).catch(function(){});
        } catch(e){}
      });

      client.once('ready', function() {
        activeBots[botId] = { client: client, config: config };
        resolve({ tag: client.user.tag });
      });
      // ---------- نظام التقديمات (أسئلة في الخاص + قبول/رفض) ----------
      client.on('interactionCreate', function(interaction) {
        (async function() {
          try {
            var abApp = activeBots[botId]; if (!abApp) return;
            var cfgApp = abApp.config; if (!cfgApp) return;
            var apps = cfgApp.applications || [];
            var cidA = interaction.customId || '';

            // --- اختيار التقديم من القائمة المنسدلة → ابدأ الأسئلة في الخاص ---
            if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && cidA === 'app_select') {
              var appId = parseInt(interaction.values[0].replace('app_', ''));
              var app = apps.find(function(a){ return a.id === appId; });
              if (!app) { await interaction.reply({ content: 'التقديم غير موجود', ephemeral: true }).catch(function(){}); return; }
              var skey = botId + '_' + interaction.user.id;
              if (appSessions[skey]) { try { await interaction.reply({ content: '⚠️ لديك تقديم قيد الإنجاز بالفعل في الخاص — أكمله أو انتظر 10 دقائق لانتهاء مهلته.', ephemeral: true }); } catch(e){} return; }
              var qs = app.questions || [];
              if (!qs.length) { await interaction.reply({ content: 'هذا التقديم لا يحتوي على أسئلة.', ephemeral: true }).catch(function(){}); return; }
              appSessions[skey] = { appId: app.id, guildId: interaction.guild.id, step: 0, answers: [], images: [] };
              if (appTimeouts[skey]) clearTimeout(appTimeouts[skey]);
              appTimeouts[skey] = setTimeout(function(){ if (appSessions[skey]) { delete appSessions[skey]; delete appTimeouts[skey]; } }, 10*60*1000);
              try { await interaction.reply({ content: '✅ سأرسل لك أسئلة التقديم في الخاص الآن — افتح الخاص وأجب على كل سؤال بإرسال رسالة (يمكنك إرفاق صور).', ephemeral: true }); } catch(e){}
              sendAppQuestion(client, botId, interaction.user, app, 0);
              return;
            }

            // --- زر قبول التقديم ---
            if (interaction.isButton && interaction.isButton() && cidA.indexOf('app_acc_') === 0) {
              var partsA = cidA.split('_');
              var accAppId = parseInt(partsA[2]); var accUserId = partsA[3];
              var accApp = apps.find(function(a){ return a.id === accAppId; });
              if (!accApp) { try { await interaction.reply({ content: 'التقديم غير موجود', ephemeral: true }); } catch(e){} return; }
              if (!hasReviewPerm(interaction.member, accApp)) { try { await interaction.reply({ content: '⚠️ لا تملك صلاحية قبول/رفض هذا التقديم (تحتاج رتبة المراجعة المحددة أو إدارة السيرفر).', ephemeral: true }); } catch(e){} return; }
              if (accApp.acceptRoleId && accApp.guildId) {
                try { var gAcc = await client.guilds.fetch(accApp.guildId).catch(function(){}); if (gAcc) { var mAcc = await gAcc.members.fetch(accUserId).catch(function(){}); if (mAcc) await mAcc.roles.add(accApp.acceptRoleId).catch(function(){}); } } catch(e){}
              }
              var accMsg = (accApp.acceptMessage || 'تم قبول تقديمك بنجاح!').replace(/\{user\}/g, '<@' + accUserId + '>').replace(/\{app\}/g, accApp.title).replace(/\{server\}/g, (interaction.guild?interaction.guild.name:''));
              try { var uAcc = await client.users.fetch(accUserId).catch(function(){}); if (uAcc) await uAcc.send(accMsg).catch(function(){}); } catch(e){}
              try {
                var oldEmb = interaction.message && interaction.message.embeds && interaction.message.embeds[0];
                var newEmb = oldEmb ? EmbedBuilder.from(oldEmb) : new EmbedBuilder();
                newEmb.setColor('#8BC34A');
                var ft = (newEmb.data.footer && newEmb.data.footer.text ? newEmb.data.footer.text + ' | ' : '') + '✅ مقبول بواسطة ' + interaction.user.tag;
                newEmb.setFooter({ text: ft.slice(0, 200) });
                await interaction.update({ embeds: [newEmb], components: [] });
              } catch(e){ try { await interaction.update({ components: [] }); } catch(e2){} }
              try { await interaction.followUp({ content: '✅ تم قبول التقديم وتم إشعار المتقدم في الخاص.', ephemeral: true }); } catch(e){}
              return;
            }

            // --- زر رفض التقديم → افتح نافذة كتابة السبب ---
            if (interaction.isButton && interaction.isButton() && cidA.indexOf('app_rej_') === 0) {
              var partsR = cidA.split('_');
              var rejAppId = parseInt(partsR[2]); var rejUserId = partsR[3];
              var rejApp = apps.find(function(a){ return a.id === rejAppId; });
              if (!rejApp) { try { await interaction.reply({ content: 'التقديم غير موجود', ephemeral: true }); } catch(e){} return; }
              if (!hasReviewPerm(interaction.member, rejApp)) { try { await interaction.reply({ content: '⚠️ لا تملك صلاحية قبول/رفض هذا التقديم (تحتاج رتبة المراجعة المحددة أو إدارة السيرفر).', ephemeral: true }); } catch(e){} return; }
              var modalR = new ModalBuilder().setCustomId('app_rejm_' + rejAppId + '_' + rejUserId).setTitle('رفض التقديم');
              var tiR = new TextInputBuilder().setCustomId('rej_reason').setLabel('سبب الرفض (سيُرسل للمتقدم في الخاص)').setStyle(TextInputStyle.Paragraph).setPlaceholder('اكتب سبب الرفض...').setRequired(true).setMaxLength(500);
              modalR.addComponents(new ActionRowBuilder().addComponents(tiR));
              await interaction.showModal(modalR).catch(function(){});
              return;
            }

            // --- تأكيد الرفض مع السبب ---
            if (interaction.isModalSubmit && interaction.isModalSubmit() && cidA.indexOf('app_rejm_') === 0) {
              var partsM = cidA.split('_');
              var mAppId = parseInt(partsM[2]); var mUserId = partsM[3];
              var mApp = apps.find(function(a){ return a.id === mAppId; });
              if (!mApp) { try { await interaction.reply({ content: 'التقديم غير موجود', ephemeral: true }); } catch(e){} return; }
              if (!hasReviewPerm(interaction.member, mApp)) { try { await interaction.reply({ content: '⚠️ لا تملك صلاحية قبول/رفض هذا التقديم.', ephemeral: true }); } catch(e){} return; }
              var reason = (interaction.fields.getTextInputValue('rej_reason') || '').trim();
              if (mApp.rejectRoleId && mApp.guildId) {
                try { var gRej = await client.guilds.fetch(mApp.guildId).catch(function(){}); if (gRej) { var mRej = await gRej.members.fetch(mUserId).catch(function(){}); if (mRej) await mRej.roles.add(mApp.rejectRoleId).catch(function(){}); } } catch(e){}
              }
              var rejMsg = (mApp.rejectMessage || 'نأسف، تم رفض تقديمك.').replace(/\{user\}/g, '<@' + mUserId + '>').replace(/\{app\}/g, mApp.title).replace(/\{server\}/g, (interaction.guild?interaction.guild.name:''));
              rejMsg += '\n\n**سبب الرفض:** ' + reason;
              try { var uRej = await client.users.fetch(mUserId).catch(function(){}); if (uRej) await uRej.send(rejMsg).catch(function(){}); } catch(e){}
              try { await interaction.reply({ content: '❌ تم رفض التقديم وتم إشعار المتقدم في الخاص بالسبب.', ephemeral: true }); } catch(e){}
              // تحديث إيمبد التقديم الأصلي إن أمكن
              try {
                var refKey = interaction.channelId + '_' + mUserId + '_' + mAppId;
                var mid = appMsgRefs[refKey];
                if (mid && interaction.channelId) {
                  var chM = await client.channels.fetch(interaction.channelId).catch(function(){});
                  if (chM) {
                    var msgM = await chM.messages.fetch(mid).catch(function(){});
                    if (msgM && msgM.embeds && msgM.embeds[0]) {
                      var ne = EmbedBuilder.from(msgM.embeds[0]).setColor('#ef4444');
                      var ftM = (ne.data.footer && ne.data.footer.text ? ne.data.footer.text + ' | ' : '') + '❌ مرفوض بواسطة ' + interaction.user.tag + ' — السبب: ' + reason.slice(0, 80);
                      ne.setFooter({ text: ftM.slice(0, 200) });
                      await msgM.edit({ embeds: [ne], components: [] }).catch(function(){});
                    }
                  }
                  delete appMsgRefs[refKey];
                }
              } catch(e){}
              return;
            }
          } catch(e){}
        })();
      });

      // ---------- استقبال إجابات التقديمات في الخاص (DM) ----------
      client.on('messageCreate', function(msg) {
        if (msg.guild || msg.author.bot) return;
        (async function() {
          try {
            var skey = botId + '_' + msg.author.id;
            var sess = appSessions[skey];
            if (!sess) return;
            var abS = activeBots[botId]; if (!abS) return;
            var cfgS = abS.config; var appsS = (cfgS && cfgS.applications) || [];
            var appS = appsS.find(function(a){ return a.id === sess.appId; });
            if (!appS) { delete appSessions[skey]; return; }
            var qsS = appS.questions || [];
            var qNow = qsS[sess.step];
            if (!qNow) { delete appSessions[skey]; return; }
            var ansText = (msg.content || '').trim();
            var imgs = [];
            try { msg.attachments.forEach(function(att){ if (att && att.url && att.contentType && String(att.contentType).indexOf('image') !== -1) imgs.push(att.url); }); } catch(e){}
            if (!ansText && !imgs.length) { try { msg.reply('⚠️ أرسل إجابة نصية أو صورة على الأقل.').catch(function(){}); } catch(e){} return; }
            if (qNow.type === 'select' && qNow.options && qNow.options.length) {
              var low = ansText.toLowerCase();
              var matched = null;
              for (var oi = 0; oi < qNow.options.length; oi++) {
                var opt = String(qNow.options[oi]);
                if (opt.toLowerCase() === low || String(oi+1) === low) { matched = opt; break; }
              }
              if (matched) ansText = matched;
            }
            sess.answers.push({ q: qNow.text, a: ansText || '(صورة مرفقة)', images: imgs });
            imgs.forEach(function(u){ sess.images.push(u); });
            sess.step++;
            if (appTimeouts[skey]) clearTimeout(appTimeouts[skey]);
            appTimeouts[skey] = setTimeout(function(){ if (appSessions[skey]) { delete appSessions[skey]; delete appTimeouts[skey]; try { msg.author.send('⏰ انتهت مهلة التقديم (10 دقائق). يمكنك البدء من جديد من لوحة التقديمات.').catch(function(){}); } catch(e){} } }, 10*60*1000);
            if (sess.step < qsS.length) { sendAppQuestion(client, botId, msg.author, appS, sess.step); return; }
            // اكتمل التقديم — أرسل للروم (الصور فوق الإيمبد) + أزرار قبول/رفض
            delete appSessions[skey];
            if (appTimeouts[skey]) { clearTimeout(appTimeouts[skey]); delete appTimeouts[skey]; }
            var desc = '**المتقدم:** <@' + msg.author.id + '> (`' + msg.author.tag + '`)\n\n';
            sess.answers.forEach(function(ans, i) {
              var line = '**' + (i+1) + '. ' + ans.q + '**\n' + ans.a;
              if (ans.images && ans.images.length) line += ' 📷 (' + ans.images.length + ' صورة)';
              desc += line + '\n\n';
            });
            var emb = new EmbedBuilder().setColor('#8BC34A').setTitle('📋 تقديم جديد: ' + appS.title).setDescription(desc.slice(0, 4000)).setFooter({ text: 'آيدي المتقدم: ' + msg.author.id + ' | اضغط قبول أو رفض بالأسفل' }).setTimestamp();
            var bAcc = new ButtonBuilder().setCustomId('app_acc_' + appS.id + '_' + msg.author.id).setLabel('✅ قبول').setStyle(ButtonStyle.Success);
            var bRej = new ButtonBuilder().setCustomId('app_rej_' + appS.id + '_' + msg.author.id).setLabel('❌ رفض مع سبب').setStyle(ButtonStyle.Danger);
            var rowApp = new ActionRowBuilder().addComponents(bAcc, bRej);
            var payload = { embeds: [emb], components: [rowApp] };
            if (sess.images.length) payload.files = sess.images.slice(0, 10).map(function(u, i){ return { attachment: u, name: 'app_img_' + i + '.png' }; });
            var sentOk = false;
            if (appS.channelId) {
              try {
                var chApp = await client.channels.fetch(appS.channelId).catch(function(){});
                if (chApp) {
                  try {
                    var sentMsg = await chApp.send(payload);
                    sentOk = true;
                    appMsgRefs[chApp.id + '_' + msg.author.id + '_' + appS.id] = sentMsg.id;
                  } catch(e){
                    // فشل الإرسال مع الصور — أرسل بدون صور
                    try { await chApp.send({ embeds: [emb], components: [rowApp] }); sentOk = true; } catch(e2){}
                  }
                }
              } catch(e){}
            }
            if (!sentOk) {
              try { msg.author.send('⚠️ تم إرسال تقديمك لكن تعذر الوصول لروم الاستلام. أبلغ إدارة السيرفر.').catch(function(){}); } catch(e){}
              return;
            }
            try { msg.author.send('✅ تم إرسال تقديمك بنجاح! سيراجعه الإدارة قريباً وسيصلك الرد في الخاص.').catch(function(){}); } catch(e){}
          } catch(e){}
        })();
      });

      // ---------- حماية الطرد والتهكير عبر سجل التدقيق ----------
      client.on('guildAuditLogEntryCreate', function(entry) {
        try {
          var abN = activeBots[botId]; if (!abN) return;
          var amN = abN.config && abN.config.automod;
          if (!amN || !amN.enabled) return;
          if (amN.guildId && String(amN.guildId) !== String(entry.guild.id)) return;
          if (!entry.executorId || entry.executorId === client.user.id) return;
          var executorMember = null;
          var types = { MEMBER_KICK: 20, MEMBER_BAN_ADD: 22, CHANNEL_DELETE: 12, ROLE_DELETE: 33, WEBHOOK_CREATE: 40, MEMBER_ROLE_UPDATE: 25, MEMBER_UPDATE: 24 };
          var isKick = entry.action === 20 || entry.action === 'MEMBER_KICK' || (typeof entry.action === 'string' && entry.action === 'MEMBER_KICK');
          var isNukeEvent = [22, 12, 33, 40].indexOf(entry.action) !== -1 ||
                            ['MEMBER_BAN_ADD','CHANNEL_DELETE','ROLE_DELETE','WEBHOOK_CREATE'].indexOf(String(entry.action)) !== -1;

          // --- حماية طرد الأعضاء (Anti-Kick) — كل طرد يعاقب صاحبه ---
          if (isKick && amN.antiKick && amN.antiKick.enabled) {
            (async function() {
              try {
                executorMember = await entry.guild.members.fetch(entry.executorId).catch(function(){});
                if (executorMember && !isWhitelisted(executorMember, amN)) {
                  var targetTag = (entry.target && entry.target.tag) ? entry.target.tag : (entry.targetId || 'unknown');
                  await applyPunishment(client, executorMember, amN.antiKick.punishment, amN.antiKick.muteMinutes,
                    'طرد عضو بدون إذن', amN.alertChannelId, 'العضو المطروود: **' + targetTag + '**');
                }
              } catch(e){}
            })();
          }

          // --- حماية التهكير (Anti-Nuke) — تتبع الأحداث الكثيفة في 10 ثوانٍ ---
          if (isNukeEvent && amN.antiNuke && amN.antiNuke.enabled) {
            var threshold = amN.antiNuke.threshold || 3;
            var nkey = botId + '_' + entry.guild.id + '_' + entry.executorId;
            var nowT = Date.now();
            if (!nukeTracker[nkey]) nukeTracker[nkey] = { events: [], lastPunish: 0 };
            var nt = nukeTracker[nkey];
            nt.events = nt.events.filter(function(ev){ return nowT - ev.time < 10000; });
            nt.events.push({ type: entry.action, time: nowT });
            if (nt.events.length >= threshold && nowT - nt.lastPunish > 15000) {
              nt.lastPunish = nowT;
              (async function() {
                try {
                  var ex = await entry.guild.members.fetch(entry.executorId).catch(function(){});
                  if (ex && !isWhitelisted(ex, amN)) {
                    var actionNames = { 22: 'حظر جماعي', 12: 'حذف رومات جماعي', 33: 'حذف رتب جماعي', 40: 'إنشاء ويبهوك' };
                    var actName = actionNames[entry.action] || 'نشاط مشبوه';
                    sendProtectionAlert(client, amN.alertChannelId, '🚨 تنبيه تهكير!',
                      'تم الكشف عن نشاط تهكير محتمل!\nالمنفذ: <@' + entry.executorId + '>\nالنشاط: **' + actName + '** (' + nt.events.length + ' أحداث خلال 10 ثوانٍ)');
                    await applyPunishment(client, ex, amN.antiNuke.punishment, amN.antiNuke.muteMinutes,
                      'تهكير السيرفر — ' + actName, amN.alertChannelId, 'عدد الأحداث: ' + nt.events.length);
                  }
                } catch(e){}
              })();
            }
          }
        } catch(e){}
      });

      client.on('error', function(e){ console.log('خطأ بوت: ' + e.message); });

      // ===== AUTO-HANDLERS للأقسام الإضافية (13-25) =====
      (function autoHandlers(){ try {
        var liveCfg = activeBots[botId].config || {};
        var ex = liveCfg.extra || {};
        var clearInts = function(){ if(activeBots[botId]._ints){activeBots[botId]._ints.forEach(function(i){clearInterval(i);}); activeBots[botId]._ints=[];} };
        if(!activeBots[botId]._ints) activeBots[botId]._ints=[];

        // --- 🚫 الكلمات الممنوعة ---
        client.on('messageCreate', function(msg){ try{
          var c=ex.bannedwords; if(!c||!c.enabled||!c.words||msg.author.bot||!msg.guild) return;
          var words=String(c.words).split(/[,،]/).map(function(w){return w.trim().toLowerCase();}).filter(Boolean);
          var txt=(msg.content||'').toLowerCase(); var hit=words.find(function(w){return txt.indexOf(w)!==-1;});
          if(!hit) return;
          var act=c.action||''; var gid=msg.guild.id;
          if(msg.deletable) msg.delete().catch(function(){});
          if(act.indexOf('تحذير')!==-1){
            if(!ex.warns) ex.warns={enabled:true,limit:3,action:'حظر',muteMin:60,logChannelId:'',warnCounts:{}};
            if(!ex.warns.warnCounts) ex.warns.warnCounts={};
            var uid=msg.author.id; ex.warns.warnCounts[uid]=(ex.warns.warnCounts[uid]||0)+1;
            var lim=parseInt(ex.warns.limit||3);
            if(ex.warns.logChannelId){ var ch=client.channels.cache.get(ex.warns.logChannelId); if(ch) ch.send({embeds:[new EmbedBuilder().setColor('#f59e0b').setTitle('⚠️ تحذير').setDescription('العضو: <@'+uid+'>\nالسبب: كلمة ممنوعة (`'+hit+'`)\nالتحذير رقم: '+ex.warns.warnCounts[uid]+'/'+lim).setTimestamp()]}); }
            if(ex.warns.warnCounts[uid]>=lim){
              var mem=msg.member; var act2=ex.warns.action||'حظر';
              try{ if(act2==='حظر'&&mem.bannable) mem.ban({reason:'الحد الأقصى للتحذيرات'}); else if(act2==='طرد'&&mem.kickable) mem.kick('الحد الأقصى للتحذيرات'); else if(act2==='كتم'&&mem.moderatable) mem.timeout(parseInt(ex.warns.muteMin||60)*60*1000,'الحد الأقصى للتحذيرات'); }catch(e){}
              ex.warns.warnCounts[uid]=0;
            }
            saveDB();
          } else if(act.indexOf('كتم')!==-1){ try{ if(msg.member&&msg.member.moderatable) msg.member.timeout(parseInt(c.muteMin||10)*60*1000,'كلمة ممنوعة'); }catch(e){} }
            else if(act.indexOf('طرد')!==-1){ try{ if(msg.member&&msg.member.kickable) msg.member.kick('كلمة ممنوعة'); }catch(e){} }
        }catch(e){} });

        // --- 💡 اقتراحات الأعضاء ---
        client.on('messageCreate', function(msg){ try{
          var c=ex.suggestions; if(!c||!c.enabled||msg.author.bot||!msg.guild) return;
          if(String(msg.channel.id)!==String(c.channelId)) return;
          Promise.all([msg.react(c.yesEmoji||'✅').catch(function(){}), msg.react(c.noEmoji||'❌').catch(function(){})]);
        }catch(e){} });

        // --- 🔐 التحقق + 🔔 ردود إخبارية (ردود فعل) ---
        function handleReactionAdd(reaction, user){ try{
          if(user.bot) return; if(reaction.partial) reaction.fetch().catch(function(){});
          var msg=reaction.message; if(!msg.guild) return; var gid=msg.guild.id;
          var v=ex.verification; if(v&&v.enabled&&String(v.channelId)===String(msg.channel.id)&&(!v.messageId||String(v.messageId)===String(msg.id))&&(reaction.emoji.name===(v.emoji||'✅')||reaction.emoji.toString()===(v.emoji||'✅'))){
            var mem=msg.guild.members.cache.get(user.id); if(mem&&v.roleId) mem.roles.add(v.roleId).catch(function(){});
          }
          var n=ex.notifyroles; if(n&&n.enabled&&String(n.channelId)===String(msg.channel.id)&&(!n.messageId||String(n.messageId)===String(msg.id))&&(reaction.emoji.name===(n.emoji||'🔔')||reaction.emoji.toString()===(n.emoji||'🔔'))){
            var mem2=msg.guild.members.cache.get(user.id); if(mem2&&n.roleId) mem2.roles.add(n.roleId).catch(function(){});
          }
        }catch(e){} }
        function handleReactionRemove(reaction, user){ try{
          if(user.bot) return; var msg=reaction.message; if(!msg.guild) return;
          var n=ex.notifyroles; if(n&&n.enabled&&String(n.channelId)===String(msg.channel.id)&&(!n.messageId||String(n.messageId)===String(msg.id))&&(reaction.emoji.name===(n.emoji||'🔔')||reaction.emoji.toString()===(n.emoji||'🔔'))){
            var mem2=msg.guild.members.cache.get(user.id); if(mem2&&n.roleId) mem2.roles.remove(n.roleId).catch(function(){});
          }
        }catch(e){} }
        client.on('messageReactionAdd', handleReactionAdd);
        client.on('messageReactionRemove', handleReactionRemove);

        // --- 📈 إحصائيات السيرفر + ⏰ التذكيرات ---
        function runStats(){ try{
          var c=ex.stats; if(!c||!c.enabled) return;
          client.guilds.cache.forEach(function(g){
            try{
              if(c.membersChannelId){ var ch=g.channels.cache.get(c.membersChannelId); if(ch) ch.setName('👥 أعضاء: '+g.memberCount).catch(function(){}); }
              if(c.onlineChannelId){ var onl=g.members.cache.filter(function(m){return m.presence&&m.presence.status!=='offline'&&!m.user.bot;}).size; var ch2=g.channels.cache.get(c.onlineChannelId); if(ch2) ch2.setName('🟢 متصل: '+onl).catch(function(){}); }
              if(c.botsChannelId){ var bt=g.members.cache.filter(function(m){return m.user.bot;}).size; var ch3=g.channels.cache.get(c.botsChannelId); if(ch3) ch3.setName('🤖 بوتات: '+bt).catch(function(){}); }
            }catch(e){}
          });
        }catch(e){} }
        function runReminder(){ try{
          var c=ex.reminders; if(!c||!c.enabled||!c.channelId||!c.message) return;
          var ch=client.channels.cache.get(c.channelId); if(ch) ch.send(String(c.message)).catch(function(){});
        }catch(e){} }
        activeBots[botId]._ints.push(setInterval(runStats, Math.max(1,parseInt((ex.stats&&ex.stats.intervalMin)||10))*60*1000));
        activeBots[botId]._ints.push(setInterval(runReminder, Math.max(1,parseInt((ex.reminders&&ex.reminders.intervalHours)||24))*3600*1000));
        setTimeout(runStats, 5000);

        // --- 🔊 الرومات المؤقتة ---
        var tempVCs=new Map();
        client.on('voiceStateUpdate', function(oldS, newS){ try{
          var c=ex.tempvc; if(!c||!c.enabled) return;
          if(newS.channelId&&String(newS.channelId)===String(c.joinChannelId)&&newS.member){
            var g=newS.guild; var nm=newS.member.displayName||newS.member.user.username;
            g.channels.create('🔊 '+nm,{type:2,parent:c.categoryId||null,userLimit:parseInt(c.userLimit||5)}).then(function(ch){ tempVCs.set(ch.id,true); newS.setChannel(ch).catch(function(){}); }).catch(function(){});
          }
          if(oldS.channelId&&tempVCs.has(oldS.channelId)&&oldS.channel.members.size===0){ var ch=oldS.channel; tempVCs.delete(ch.id); ch.delete().catch(function(){}); }
        }catch(e){} });

        // --- 💰 نقاط واقتصاد ---
        if(!ex.points) ex.points={enabled:false,perMsg:1,perVoiceMin:2,boardChannelId:'',roleRewards:'',userPoints:{},_lastMsg:{}};
        if(!ex.points.userPoints) ex.points.userPoints={}; if(!ex.points._lastMsg) ex.points._lastMsg={};
        var voiceStart={};
        client.on('messageCreate', function(msg){ try{
          var c=ex.points; if(!c||!c.enabled||msg.author.bot||!msg.guild) return;
          var uid=msg.author.id; var now=Date.now(); if((c._lastMsg[uid]||0)+60000>now) return; c._lastMsg[uid]=now;
          c.userPoints[uid]=(c.userPoints[uid]||0)+parseInt(c.perMsg||1);
        }catch(e){} });
        client.on('voiceStateUpdate', function(oldS, newS){ try{
          var c=ex.points; if(!c||!c.enabled) return; var uid=(oldS.member||newS.member||{}).id; if(!uid) return;
          if(!oldS.channelId&&newS.channelId&&!newS.member.user.bot) voiceStart[uid]=Date.now();
          else if(oldS.channelId&&!newS.channelId&&voiceStart[uid]){
            var mins=Math.floor((Date.now()-voiceStart[uid])/60000); c.userPoints[uid]=(c.userPoints[uid]||0)+mins*parseInt(c.perVoiceMin||2); delete voiceStart[uid];
          }
        }catch(e){} });
        activeBots[botId]._ints.push(setInterval(function(){ try{ saveDB(); }catch(e){} }, 60000));

      }catch(e){} })();

      client.login(token).catch(function(e){ reject(new Error('فشل تسجيل الدخول: ' + e.message)); });
      setTimeout(function(){ if (!activeBots[botId]) reject(new Error('انتهى الوقت — تأكد من صحة التوكن')); }, 20000);
    } catch(e) { reject(e); }
  });
}

function updateBotConfig(botId, newConfig) {
  var botRec = DB.bots.find(function(b){ return b.id == botId; });
  if (botRec) { botRec.config = newConfig; saveDB(); }
  if (activeBots[botId]) activeBots[botId].config = newConfig;
}
function getBotConfig(botId) {
  var botRec = DB.bots.find(function(b){ return b.id == botId; });
  if (!botRec) return defaultConfig();
  var cfg = botRec.config || defaultConfig();
  // دمج القيم الافتراضية للتأكد من وجود كل الحقول
  var d = defaultConfig();
  for (var k in d) { if (cfg[k] === undefined) cfg[k] = d[k]; }
  return cfg;
}

// ===== المصادقة =====
app.post('/api/register', function(req, res) {
  try {
    var u = req.body.username, p = req.body.password;
    if (!u || !p) return res.json({ success: false, message: 'املأ جميع الحقول' });
    if (DB.users.find(function(x){ return x.username === u; })) return res.json({ success: false, message: 'اسم المستخدم موجود' });
    var user = { id: nextId(DB.users), username: u, password: p };
    DB.users.push(user); saveDB();
    req.session.userId = user.id;
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});
app.post('/api/login', function(req, res) {
  try {
    var user = DB.users.find(function(u){ return u.username === req.body.username && u.password === req.body.password; });
    if (!user) return res.json({ success: false, message: 'بيانات خاطئة' });
    req.session.userId = user.id;
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});
app.get('/api/user', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ loggedIn: false });
    var u = DB.users.find(function(x){ return x.id === req.session.userId; });
    if (!u) return res.json({ loggedIn: false });
    var bots = DB.bots.filter(function(b){ return b.userId === u.id; }).map(function(b){ return { id: b.id, name: b.name, running: !!activeBots[b.id] }; });
    res.json({ loggedIn: true, user: { id: u.id, username: u.username }, bots: bots });
  } catch(e) { res.json({ loggedIn: false }); }
});
app.get('/api/logout', function(req, res) { req.session.destroy(); res.json({ success: true }); });

// ===== إدارة البوتات =====
app.post('/api/bots/add', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var name = req.body.name, token = req.body.token;
    if (!name || !token) return res.json({ success: false, message: 'املأ الاسم والتوكن' });
    DB.bots.push({ id: nextId(DB.bots), userId: req.session.userId, name: name, token: token, config: defaultConfig() });
    saveDB(); res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});
app.post('/api/bots/start', function(req, res) {
  (async function() {
    try {
      if (!req.session.userId) return res.json({ success: false });
      var bot = DB.bots.find(function(b){ return b.id === req.body.id && b.userId === req.session.userId; });
      if (!bot) return res.json({ success: false, message: 'البوت غير موجود' });
      var info = await startBot(bot.id, bot.token);
      res.json({ success: true, tag: info.tag });
    } catch(e) { res.json({ success: false, message: e.message }); }
  })();
});
app.post('/api/bots/stop', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    if (activeBots[req.body.id]) { try { if(activeBots[req.body.id]._ints){activeBots[req.body.id]._ints.forEach(function(i){clearInterval(i);});} activeBots[req.body.id].client.destroy(); } catch(e){} delete activeBots[req.body.id]; }
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});
app.post('/api/bots/delete', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    if (activeBots[req.body.id]) { try { if(activeBots[req.body.id]._ints){activeBots[req.body.id]._ints.forEach(function(i){clearInterval(i);});} activeBots[req.body.id].client.destroy(); } catch(e){} delete activeBots[req.body.id]; }
    DB.bots = DB.bots.filter(function(b){ return !(b.id === req.body.id && b.userId === req.session.userId); });
    saveDB(); res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ===== إعدادات البوت الكاملة (للاستعادة في الواجهة) =====
app.get('/api/bots/config', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.query.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false, message: 'البوت غير موجود' });
    res.json({ success: true, config: getBotConfig(botRec.id) });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ===== سيرفرات ورومات ورتب وأقسام =====
app.get('/api/bots/guilds', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ guilds: [] });
    var ab = activeBots[req.query.botId];
    if (!ab) return res.json({ guilds: [] });
    res.json({ guilds: ab.client.guilds.cache.map(function(g){ return { id: g.id, name: g.name, memberCount: g.memberCount }; }) });
  } catch(e) { res.json({ guilds: [] }); }
});
app.get('/api/bots/channels', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ channels: [] });
    var ab = activeBots[req.query.botId];
    if (!ab) return res.json({ channels: [] });
    var guild = ab.client.guilds.cache.get(req.query.guildId);
    if (!guild) return res.json({ channels: [] });
    res.json({ channels: guild.channels.cache.filter(function(c){ return c.type === ChannelType.GuildText; }).map(function(c){ return { id: c.id, name: '#' + c.name }; }) });
  } catch(e) { res.json({ channels: [] }); }
});
app.get('/api/bots/roles', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ roles: [] });
    var ab = activeBots[req.query.botId];
    if (!ab) return res.json({ roles: [] });
    var guild = ab.client.guilds.cache.get(req.query.guildId);
    if (!guild) return res.json({ roles: [] });
    res.json({ roles: guild.roles.cache.filter(function(r){ return !r.managed && r.name !== '@everyone'; }).map(function(r){ return { id: r.id, name: r.name }; }) });
  } catch(e) { res.json({ roles: [] }); }
});
app.get('/api/bots/categories', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ categories: [] });
    var ab = activeBots[req.query.botId];
    if (!ab) return res.json({ categories: [] });
    var guild = ab.client.guilds.cache.get(req.query.guildId);
    if (!guild) return res.json({ categories: [] });
    res.json({ categories: guild.channels.cache.filter(function(c){ return c.type === ChannelType.GuildCategory; }).map(function(c){ return { id: c.id, name: c.name }; }) });
  } catch(e) { res.json({ categories: [] }); }
});

// ===== إرسال رسالة فوري =====
app.post('/api/bots/send-message', function(req, res) {
  (async function() {
    try {
      if (!req.session.userId) return res.json({ success: false });
      var ab = activeBots[req.body.botId];
      if (!ab) return res.json({ success: false, message: 'شغل البوت أولاً' });
      var ch = await ab.client.channels.fetch(req.body.channelId);
      var payload = {};
      if (req.body.content) payload.content = req.body.content;
      if (req.body.embed) {
        var emb = new EmbedBuilder().setColor(req.body.embed.color || '#558B2F');
        if (req.body.embed.title) emb.setTitle(req.body.embed.title);
        if (req.body.embed.description) emb.setDescription(req.body.embed.description);
        payload.embeds = [emb];
      }
      await ch.send(payload);
      res.json({ success: true });
    } catch(e) { res.json({ success: false, message: e.message }); }
  })();
});

// ===== لوحة تذاكر (مُصلحة + تحفظ الروم والقسم) =====
app.post('/api/bots/ticket-panel', function(req, res) {
  (async function() {
    try {
      if (!req.session.userId) return res.json({ success: false });
      var ab = activeBots[req.body.botId];
      if (!ab) return res.json({ success: false, message: 'شغل البوت أولاً' });
      var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
      if (!botRec) return res.json({ success: false, message: 'البوت غير موجود' });
      var config = getBotConfig(botRec.id);
      // الإصلاح: معرف بدون شرطة سفلية حتى لا ينكسر عند التقسيم
      var panelId = 'p' + Date.now();
      var ch = await ab.client.channels.fetch(req.body.channelId);
      var row;
      if (req.body.panelType === 'buttons') {
        var buttons = (req.body.categories || []).slice(0, 5).map(function(c, i) {
          return new ButtonBuilder().setCustomId('nors_ticket_' + panelId + '_' + i).setLabel(c.label).setStyle(ButtonStyle.Success);
        });
        row = new ActionRowBuilder().addComponents(buttons);
      } else {
        var select = new StringSelectMenuBuilder()
          .setCustomId('nors_ticket_' + panelId)
          .setPlaceholder('اختر نوع التذكرة...')
          .addOptions((req.body.categories || []).map(function(c, i) { return { label: c.label, description: c.desc || c.label, value: 'cat_' + i }; }).concat([{ label: '🔄 ريست', description: 'إعادة ضبط القائمة دون فتح تذكرة', value: 'nors_reset' }]));
        row = new ActionRowBuilder().addComponents(select);
      }
      var embed = new EmbedBuilder()
        .setTitle(req.body.title || 'نظام التذاكر')
        .setDescription(req.body.description || 'اختر نوع التذكرة من القائمة بالأسفل لفتح تذكرة.')
        .setColor('#558B2F');
      await ch.send({ embeds: [embed], components: [row] });
      // حفظ كل تفاصيل اللوحة بما فيها الروم والقسم (لإظهارها لاحقاً)
      config.ticketPanels.push({
        id: panelId,
        guildId: req.body.guildId || null,
        channelId: req.body.channelId,
        channelName: ch.name,
        categoryId: req.body.categoryId || null,
        mentionRoleId: req.body.mentionRoleId || null,
        title: req.body.title || 'نظام التذاكر',
        panelType: req.body.panelType || 'dropdown',
        ticketTools: req.body.ticketTools || 'buttons',
        categories: (req.body.categories || []).map(function(c,i){ return { label: c.label, value: 'cat_' + i }; }),
        createdAt: new Date().toISOString()
      });
      updateBotConfig(botRec.id, config);
      res.json({ success: true });
    } catch(e) { res.json({ success: false, message: e.message }); }
  })();
});

// ===== حذف لوحة تذاكر =====
app.post('/api/bots/ticket-panel/delete', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var config = getBotConfig(botRec.id);
    config.ticketPanels = (config.ticketPanels || []).filter(function(p){ return p.id !== req.body.panelId; });
    updateBotConfig(botRec.id, config);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ===== الردود التلقائية =====
app.post('/api/bots/autoreply', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var config = getBotConfig(botRec.id);
    config.autoReplies.push({ guildId: req.body.guildId || null, trigger: req.body.trigger, reply: req.body.reply });
    updateBotConfig(botRec.id, config);
    res.json({ success: true, list: config.autoReplies });
  } catch(e) { res.json({ success: false, message: e.message }); }
});
app.get('/api/bots/autoreply', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ list: [] });
    var botRec = DB.bots.find(function(b){ return b.id == req.query.botId; });
    if (!botRec) return res.json({ list: [] });
    res.json({ list: (getBotConfig(botRec.id).autoReplies) || [] });
  } catch(e) { res.json({ list: [] }); }
});

// ===== السجلات (حفظ الإعدادات) =====
app.post('/api/bots/logs/save', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var config = getBotConfig(botRec.id);
    config.logs = {
      enabled: !!req.body.enabled,
      guildId: req.body.guildId || null,
      channels: {
        msg: req.body.msg || null,
        channels: req.body.channels || null,
        members: req.body.members || null,
        roles: req.body.roles || null,
        joinleave: req.body.joinleave || null,
        mod: req.body.mod || null
      }
    };
    updateBotConfig(botRec.id, config);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ===== الأوامر الإدارية بالاختصارات =====
app.post('/api/bots/admin-commands/save', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var config = getBotConfig(botRec.id);
    config.adminCommands = {
      enabled: !!req.body.enabled,
      guildId: req.body.guildId || null,
      adminRoleId: req.body.adminRoleId || null,
      muteMinutes: parseInt(req.body.muteMinutes) || 10,
      commands: (req.body.commands || []).slice(0, 25).map(function(c){ return { shortcut: String(c.shortcut || '').trim(), action: c.action || 'kick', enabled: c.enabled !== false }; })
    };
    updateBotConfig(botRec.id, config);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ===== الأوتو رول =====
app.post('/api/bots/autorole/save', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var config = getBotConfig(botRec.id);
    config.autorole = { enabled: !!req.body.enabled, guildId: req.body.guildId || null, roleId: req.body.roleId || null };
    updateBotConfig(botRec.id, config);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ===== الترحيب والخروج =====
app.post('/api/bots/welcome-leave/save', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var config = getBotConfig(botRec.id);
    config.welcomeLeave = { enabled: !!req.body.enabled, guildId: req.body.guildId || null, welcomeChannelId: req.body.welcomeChannelId || null, welcomeMessage: req.body.welcomeMessage || '', leaveChannelId: req.body.leaveChannelId || null, leaveMessage: req.body.leaveMessage || '' };
    updateBotConfig(botRec.id, config);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ===== الأدوار التفاعلية =====
app.post('/api/bots/reaction-role', function(req, res) {
  (async function() {
    try {
      if (!req.session.userId) return res.json({ success: false });
      var ab = activeBots[req.body.botId];
      if (!ab) return res.json({ success: false, message: 'شغل البوت أولاً' });
      var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
      if (!botRec) return res.json({ success: false });
      var config = getBotConfig(botRec.id);
      var ch = await ab.client.channels.fetch(req.body.channelId);
      var sent = await ch.send(req.body.text || 'اضغط على الإيموجي لأخذ الرتبة');
      await sent.react(req.body.emoji || '✅');
      config.reactionRoles.push({ id: nextId(config.reactionRoles), guildId: req.body.guildId || null, channelId: req.body.channelId, messageId: sent.id, emoji: req.body.emoji || '✅', roleId: req.body.roleId });
      updateBotConfig(botRec.id, config);
      res.json({ success: true });
    } catch(e) { res.json({ success: false, message: e.message }); }
  })();
});

// ===== الأوامر المخصصة النصية =====
app.post('/api/bots/custom-command', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var config = getBotConfig(botRec.id);
    config.customCommands.push({ guildId: req.body.guildId || null, trigger: req.body.trigger, reply: req.body.reply });
    updateBotConfig(botRec.id, config);
    res.json({ success: true, list: config.customCommands });
  } catch(e) { res.json({ success: false, message: e.message }); }
});
app.get('/api/bots/custom-commands', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ list: [] });
    var botRec = DB.bots.find(function(b){ return b.id == req.query.botId; });
    if (!botRec) return res.json({ list: [] });
    res.json({ list: getBotConfig(botRec.id).customCommands || [] });
  } catch(e) { res.json({ list: [] }); }
});

// ===== الحماية المتقدمة =====
app.post('/api/bots/automod/save', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var config = getBotConfig(botRec.id);
    function prot(name) {
      var p = req.body[name] || {};
      return {
        enabled: !!p.enabled,
        punishment: p.punishment || 'mute',
        muteMinutes: parseInt(p.muteMinutes) || 10
      };
    }
    config.automod = {
      enabled: !!req.body.enabled,
      guildId: req.body.guildId || null,
      alertChannelId: req.body.alertChannelId || null,
      whitelistRoles: [
        req.body.whitelistRole1 || null,
        req.body.whitelistRole2 || null,
        req.body.whitelistRole3 || null
      ].filter(Boolean),
      antiLinks: prot('antiLinks'),
      antiSpam: prot('antiSpam'),
      antiBadWords: {
        enabled: !!(req.body.antiBadWords && req.body.antiBadWords.enabled),
        badWords: ((req.body.antiBadWords && req.body.antiBadWords.badWords) || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean),
        punishment: (req.body.antiBadWords && req.body.antiBadWords.punishment) || 'mute',
        muteMinutes: parseInt(req.body.antiBadWords && req.body.antiBadWords.muteMinutes) || 10
      },
      antiKick: prot('antiKick'),
      antiBotJoin: prot('antiBotJoin'),
      antiNuke: {
        enabled: !!(req.body.antiNuke && req.body.antiNuke.enabled),
        punishment: (req.body.antiNuke && req.body.antiNuke.punishment) || 'ban',
        muteMinutes: parseInt(req.body.antiNuke && req.body.antiNuke.muteMinutes) || 10,
        threshold: parseInt(req.body.antiNuke && req.body.antiNuke.threshold) || 3
      }
    };
    updateBotConfig(botRec.id, config);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ===== التقديمات (Applications) — حد أقصى 5 تقديمات، 7 أسئلة لكل تقديم =====
var appSessions = {};   // { botId_userId: { appId, guildId, step, answers:[], images:[] } }
var appTimeouts = {};   // مقابض المهلة
var appMsgRefs = {};    // { channelId_userId_appId: messageId } لتحديث إيمبد التقديم عند الرفض

// هل للعضو صلاحية قبول/رفض التقديم؟ (رتبة المراجعة المحددة أو إدارة السيرفر)
function hasReviewPerm(member, app) {
  try {
    if (!member) return false;
    if (member.permissions && member.permissions.has && member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (app && app.reviewRoleId && member.roles && member.roles.cache && member.roles.cache.has(String(app.reviewRoleId))) return true;
    return false;
  } catch(e){ return false; }
}
// إرسال سؤال التقديم في الخاص
function sendAppQuestion(client, botId, user, app, step) {
  try {
    var qs = app.questions || [];
    var q = qs[step];
    if (!q) return;
    var text = '**📋 تقديم: ' + app.title + '**\n\n';
    text += '**السؤال ' + (step+1) + ' من ' + qs.length + ':** ' + q.text + '\n';
    if (q.type === 'select' && q.options && q.options.length) {
      text += '\nالخيارات المتاحة (اكتب اختيارك كاملاً أو رقمه):\n' + q.options.map(function(o,i){ return (i+1) + '. ' + o; }).join('\n');
    } else {
      text += '\nأجب على هذا السؤال بإرسال رسالة هنا في الخاص (يمكنك إرفاق صورة أو أكثر).';
    }
    text += '\n\n⏰ لديك 10 دقائق لإكمال التقديم.';
    user.send(text).catch(function(){});
  } catch(e){}
}

app.post('/api/bots/applications/save', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var config = getBotConfig(botRec.id);
    if (!config.applications) config.applications = [];
    var questions = (req.body.questions || []).filter(function(q){ return q && q.text && q.text.trim(); }).slice(0, 15).map(function(q, i){
      return { id: i + 1, text: String(q.text).trim(), type: q.type || 'text', options: (q.options || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean).slice(0, 15) };
    });
    if (!questions.length) return res.json({ success: false, message: 'أضف سؤالاً واحداً على الأقل' });
    var appData = {
      id: req.body.id ? parseInt(req.body.id) : Date.now(),
      title: String(req.body.title || 'تقديم جديد').trim().slice(0, 80),
      channelId: req.body.channelId || null,
      guildId: req.body.guildId || null,
      questions: questions,
      reviewRoleId: req.body.reviewRoleId || null,
      acceptRoleId: req.body.acceptRoleId || null,
      rejectRoleId: req.body.rejectRoleId || null,
      acceptMessage: String(req.body.acceptMessage || '').trim(),
      rejectMessage: String(req.body.rejectMessage || '').trim(),
      createdAt: Date.now()
    };
    var idx = config.applications.findIndex(function(a){ return a.id === appData.id; });
    if (idx !== -1) { appData.createdAt = config.applications[idx].createdAt || Date.now(); config.applications[idx] = appData; }
    else {
      if (config.applications.length >= 10) return res.json({ success: false, message: 'الحد الأقصى 10 تقديمات — احذف أحد التقديمات' });
      config.applications.push(appData);
    }
    updateBotConfig(botRec.id, config);
    res.json({ success: true, id: appData.id });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.post('/api/bots/applications/delete', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var config = getBotConfig(botRec.id);
    config.applications = (config.applications || []).filter(function(a){ return String(a.id) !== String(req.body.appId); });
    updateBotConfig(botRec.id, config);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.post('/api/bots/applications/sendPanel', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var ab = activeBots[botRec.id];
    if (!ab) return res.json({ success: false, message: 'شغل البوت أولاً' });
    var config = getBotConfig(botRec.id);
    var apps = (config.applications || []).filter(function(a){ return !a.guildId || String(a.guildId) === String(req.body.guildId); });
    if (!apps.length) return res.json({ success: false, message: 'أنشئ تقديماً واحداً على الأقل أولاً' });
    ab.client.channels.fetch(req.body.channelId).then(function(ch){
      if (!ch) return res.json({ success: false, message: 'الروم غير موجود' });
      var options = apps.slice(0, 10).map(function(a){ return { label: a.title.slice(0, 80), value: 'app_' + a.id, description: (a.questions.length + ' أسئلة — في الخاص').slice(0, 50) }; });
      var row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('app_select').setPlaceholder('📋 اختر نوع التقديم').addOptions(options));
      var embed = new EmbedBuilder().setColor('#8BC34A').setTitle('📋 نظام التقديمات').setDescription('اختر نوع التقديم من القائمة المنسدلة بالأسفل لبدء التقديم.\nستصل الأسئلة في **خاصك** ويمكنك إرفاق صور.\nعدد التقديمات المتاحة: **' + apps.length + '**').setFooter({ text: 'الأسئلة في الخاص + قبول/رفض | حد الأسئلة: 15 | حد التقديمات: 10' }).setTimestamp();
      ch.send({ embeds: [embed], components: [row] }).then(function(){ res.json({ success: true }); }).catch(function(e){ res.json({ success: false, message: e.message }); });
    }).catch(function(e){ res.json({ success: false, message: e.message }); });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ===== المستويات =====
app.post('/api/bots/levels/save', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var botRec = DB.bots.find(function(b){ return b.id == req.body.botId && b.userId === req.session.userId; });
    if (!botRec) return res.json({ success: false });
    var config = getBotConfig(botRec.id);
    config.levels = { enabled: !!req.body.enabled, guildId: req.body.guildId || null, channelId: req.body.channelId || null, pointsPerMsg: parseInt(req.body.pointsPerMsg) || 10, upMsg: req.body.upMsg || null };
    updateBotConfig(botRec.id, config);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ===== ملفات + تشغيل البوتات المضغوطة =====
var upload = multer({ dest: './uploads/', limits: { fileSize: 100 * 1024 * 1024 } });

function findEntryFile(dir) {
  // بايثون فقط — ابحث عن الملفات الرئيسية .py
  var candidates = ['main.py', 'bot.py', 'index.py', 'app.py', 'start.py', 'run.py', 'server.py'];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(path.join(dir, candidates[i]))) return { file: candidates[i], type: 'python' };
  }
  // ابحث عن أي ملف .py في الجذر يحتوي على discord/token/run
  try {
    var files = fs.readdirSync(dir).filter(function(f){ return f.endsWith('.py'); });
    for (var j = 0; j < files.length; j++) {
      var content = fs.readFileSync(path.join(dir, files[j]), 'utf8');
      if (/discord|TOKEN|token|run\(|client\.run|bot\.run/i.test(content)) return { file: files[j], type: 'python' };
    }
    if (files.length) return { file: files[0], type: 'python' };
  } catch(e){}
  return null;
}

function extractAndPrepare(fileRec) {
  return new Promise(function(resolve, reject) {
    try {
      var extDir = path.join('./uploads/bots', 'bot_' + fileRec.id);
      if (fs.existsSync(extDir)) { try { fs.rmSync(extDir, { recursive: true, force: true }); } catch(e){} }
      fs.mkdirSync(extDir, { recursive: true });
      var fp = fileRec.filepath;
      var isZip = /\.zip$/i.test(fileRec.filename);
      var isPy = /\.py$/i.test(fileRec.filename);
      if (isZip) {
        cp.exec('unzip -o "' + path.resolve(fp) + '" -d "' + path.resolve(extDir) + '"', { timeout: 60000 }, function(err) {
          if (err) { return reject(new Error('فشل فك الضغط: ' + err.message)); }
          afterExtract(extDir, resolve, reject);
        });
      } else if (isPy) {
        // ملف بايثون مفرد — انسخه كـ main.py
        var dest = path.join(extDir, 'main.py');
        fs.copyFileSync(fp, dest);
        afterExtract(extDir, resolve, reject);
      } else {
        return reject(new Error('الملف غير مدعوم — ارفع ملف بايثون (.py) أو ملف مضغوط (.zip) يحتوي على ملف .py مثل main.py'));
      }
    } catch(e) { reject(e); }
  });
}

function afterExtract(extDir, resolve, reject) {
  // إذا كان يوجد مجلد واحد فقط داخل المجلد، ادخله (مشكلة zip الشائعة)
  try {
    var items = fs.readdirSync(extDir);
    if (items.length === 1) {
      var inner = path.join(extDir, items[0]);
      if (fs.statSync(inner).isDirectory()) extDir = inner;
    }
  } catch(e){}
  var entry = findEntryFile(extDir);
  if (!entry) return reject(new Error('لم أجد ملف بايثون رئيسي (.py) مثل main.py / bot.py داخل الملف المضغوط'));
  // ثبّت مكتبات بايثون إذا كان يوجد requirements.txt
  var reqPath = path.join(extDir, 'requirements.txt');
  if (fs.existsSync(reqPath)) {
    cp.exec('pip3 install -r requirements.txt', { cwd: extDir, timeout: 180000 }, function(err) {
      if (err) { console.log('تحذير pip install: ' + err.message); }
      resolve({ dir: extDir, entry: entry.file });
    });
  } else {
    resolve({ dir: extDir, entry: entry.file });
  }
}

app.post('/api/upload', upload.single('file'), function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var size = (req.file.size/1024).toFixed(1) + ' KB';
    if (req.file.size > 1024*1024) size = (req.file.size/1024/1024).toFixed(2) + ' MB';
    DB.files.push({ id: nextId(DB.files), userId: req.session.userId, filename: req.file.originalname, filepath: req.file.path, size: size, uploadedAt: Date.now() });
    saveDB(); res.json({ success: true, filename: req.file.originalname, id: DB.files[DB.files.length-1].id });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.get('/api/files', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ files: [] });
    res.json({ files: DB.files.filter(function(f){ return f.userId === req.session.userId; }).map(function(f){
      return { id: f.id, filename: f.filename, size: f.size, running: !!runningProcesses[f.id] };
    }) });
  } catch(e) { res.json({ files: [] }); }
});

app.post('/api/files/run', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false, message: 'سجل دخولك' });
    var fileRec = DB.files.find(function(f){ return f.id == req.body.id && f.userId === req.session.userId; });
    if (!fileRec) return res.json({ success: false, message: 'الملف غير موجود' });
    if (runningProcesses[fileRec.id]) return res.json({ success: false, message: 'البوت يعمل بالفعل' });
    extractAndPrepare(fileRec).then(function(info) {
      var child = cp.spawn('python3', [info.entry], { cwd: info.dir, detached: false, stdio: 'pipe' });
      var logs = [];
      child.stdout.on('data', function(d){ var s = d.toString().slice(0,500); logs.push(s); if (logs.length > 50) logs.shift(); });
      child.stderr.on('data', function(d){ var s = d.toString().slice(0,500); logs.push('[err] ' + s); if (logs.length > 50) logs.shift(); });
      child.on('exit', function(code){
        logs.push('[exit] code=' + code);
        delete runningProcesses[fileRec.id];
      });
      runningProcesses[fileRec.id] = { proc: child, dir: info.dir, entry: info.entry, name: fileRec.filename, startedAt: Date.now(), logs: logs };
      res.json({ success: true, message: 'تم تشغيل البوت بنجاح ✅' });
    }).catch(function(e){ res.json({ success: false, message: e.message }); });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.post('/api/files/stop', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var rp = runningProcesses[req.body.id];
    if (!rp) return res.json({ success: false, message: 'البوت غير مشغل' });
    try { rp.proc.kill('SIGKILL'); } catch(e){}
    try { process.kill(-rp.proc.pid, 'SIGKILL'); } catch(e){}
    delete runningProcesses[req.body.id];
    res.json({ success: true, message: 'تم إيقاف البوت' });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.get('/api/files/logs', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ logs: [] });
    var rp = runningProcesses[req.query.id];
    if (!rp) return res.json({ logs: [], running: false });
    res.json({ logs: rp.logs || [], running: true, startedAt: rp.startedAt });
  } catch(e) { res.json({ logs: [] }); }
});

app.post('/api/files/delete', function(req, res) {
  try {
    if (!req.session.userId) return res.json({ success: false });
    var idx = DB.files.findIndex(function(f){ return f.id == req.body.id && f.userId === req.session.userId; });
    if (idx === -1) return res.json({ success: false });
    var f = DB.files[idx];
    if (runningProcesses[f.id]) { try { runningProcesses[f.id].proc.kill('SIGKILL'); } catch(e){} delete runningProcesses[f.id]; }
    try { if (fs.existsSync(f.filepath)) fs.unlinkSync(f.filepath); } catch(e){}
    var extDir = path.join('./uploads/bots', 'bot_' + f.id);
    try { if (fs.existsSync(extDir)) fs.rmSync(extDir, { recursive: true, force: true }); } catch(e){}
    DB.files.splice(idx, 1);
    saveDB();
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.use(function(err, req, res, next) {
  console.log('خطأ عام: ' + err.message);
  res.status(500).json({ success: false, message: err.message });
});

// ===== أقسام إضافية (13 قسم) — حفظ وإرسال =====
app.post('/api/bots/extra/save', function(req, res){
  try{
    var b=req.body; var bot=DB.bots.find(function(x){return String(x.id)===String(b.botId);});
    if(!bot) return res.status(404).json({success:false,message:'البوت غير موجود'});
    if(!bot.config) bot.config={}; if(!bot.config.extra) bot.config.extra={};
    bot.config.extra[b.key]=b.data||{}; bot.config.extra[b.key].guildId=b.guildId;
    if(activeBots[b.botId]){ if(!activeBots[b.botId].config) activeBots[b.botId].config={}; if(!activeBots[b.botId].config.extra) activeBots[b.botId].config.extra={}; activeBots[b.botId].config.extra[b.key]=bot.config.extra[b.key]; }
    saveDB(); res.json({success:true});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});
app.post('/api/bots/extra/send', function(req, res){
  try{
    var b=req.body; var ab=activeBots[b.botId]; if(!ab||!ab.client) return res.status(400).json({success:false,message:'شغّل البوت أولاً'});
    var client=ab.client; var cfg=(ab.config&&ab.config.extra&&ab.config.extra[b.key])||{};
    var gid=cfg.guildId||b.guildId; var guild=client.guilds.cache.get(gid);
    if(b.key==='announcements'||b.key==='rules'){
      var ch=client.channels.cache.get(cfg.channelId); if(!ch) return res.json({success:false,message:'اختر روم أولاً'});
      var { EmbedBuilder }=require('discord.js');
      var emb=new EmbedBuilder().setColor('#8BC34A').setTimestamp();
      if(b.key==='rules'){ emb.setTitle(cfg.title||'قوانين السيرفر'); emb.setDescription(cfg.text||'—'); }
      else { emb.setTitle('📢 إعلان'); emb.setDescription(cfg.text||'—'); }
      var content=cfg.mentionRoleId?('<@&'+cfg.mentionRoleId+'>'):undefined;
      ch.send({content:content,embeds:[emb]}).then(function(m){ if(b.key==='announcements'){ try{m.pin();}catch(e){} } }).catch(function(){});
      return res.json({success:true,message:'تم الإرسال'});
    }
    if(b.key==='giveaways'){
      var ch2=client.channels.cache.get(cfg.channelId); if(!ch2) return res.json({success:false,message:'اختر روم أولاً'});
      var { EmbedBuilder:EB }=require('discord.js');
      var dur=Math.max(1,parseInt(cfg.durationHours||24)); var winners=Math.max(1,parseInt(cfg.winners||1));
      var endAt=Date.now()+dur*3600*1000;
      var emb2=new EB().setColor('#F59E0B').setTitle('🎉 مسابقة جديدة').setDescription('الجائزة: **'+(cfg.prize||'—')+'**\nعدد الفائزين: '+winners+'\nتنتهي بعد: '+dur+' ساعة\nتفاعل بـ 🎉 للمشاركة').setTimestamp(endAt);
      ch2.send({embeds:[emb2]}).then(function(m){ m.react('🎉'); setTimeout(function(){ m.reactions.cache.get('🎉').users.fetch().then(function(us){ var list=us.filter(function(u){return !u.bot;}).map(function(u){return u;}); if(!list.length){ ch2.send('⚠️ لا يوجد مشاركين في المسابقة'); return; } var wins=[]; for(var i=0;i<winners&&list.length;i++){ var idx=Math.floor(Math.random()*list.length); wins.push(list.splice(idx,1)[0]); } ch2.send('🏆 فاز بالمسابقة ('+(cfg.prize||'—')+'): '+wins.map(function(u){return '<@'+u.id+'>';}).join(' ')); }); }, dur*3600*1000); }).catch(function(){});
      return res.json({success:true,message:'تم بدء المسابقة'});
    }
    if(b.key==='copymsgs'){
      var src=client.channels.cache.get(cfg.sourceChannelId); var tgt=client.channels.cache.get(cfg.targetChannelId);
      if(!src||!tgt) return res.json({success:false,message:'اختر روم المصدر والهدف'});
      var lim=Math.min(100,parseInt(cfg.limit||50));
      src.messages.fetch({limit:lim}).then(function(msgs){ var arr=msgs.array().reverse(); var i=0; function nxt(){ if(i>=arr.length) return; var m=arr[i++]; var txt=m.content||'(مرفق)'; if(m.attachments&&m.attachments.size) m.attachments.forEach(function(a){txt+='\n'+a.url;}); tgt.send('**'+m.author.username+'**: '+txt).catch(function(){}); setTimeout(nxt,600); } nxt(); });
      return res.json({success:true,message:'بدأ نسخ الرسائل...'});
    }
    res.json({success:true,message:'تم الحفظ — القسم يعمل تلقائياً في الخلفية'});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

app.listen(PORT, function() {
  console.log('========================================');
  console.log('  Prime Blanklz — موقع برايم بلانكلزي');
  console.log('  يعمل على المنفذ ' + PORT);
  console.log('  افتح: http://localhost:' + PORT);
  console.log('========================================');
});
