/**
 * Mix Shuffle - Crossfire v8.0
 * ─────────────────────────────────────────────────────────────
 * FLUXO:
 *   1. Fila completa (10/10)
 *   2. Bot cria canal "CAPITÃES VETANDO FILA#N" e arrasta os 2 caps
 *   3. Veto e escolha de lado acontecem NO CANAL dos capitães (não mais PV)
 *   4. Após lado escolhido: deleta canal de caps, cria "Global Risk FILA#N"
 *      e "Black List FILA#N", move os times para os canais corretos
 *   5. Segunda fila só abre APÓS veto+lado da primeira concluir (status playing)
 *
 * COMUNICAÇÃO:
 *   - Fila (entrou/saiu)       → chat do canal Fila de espera
 *   - Veto / lado              → canal CAPITÃES VETANDO FILA#N
 *   - Mix iniciado / resultado → canal principal (broadcast)
 *   - Admin / erros            → PV do jogador/admin
 */

registerPlugin(
  {
    name: "Mix Shuffle - Crossfire v8",
    version: "8.0.0",
    description: "Mix Crossfire com duas filas, canal de capitães, veto e escolha de lado.",
    author: "Feito com Claude",
    vars: [
      { name: "filaChannelId",   title: "Canal 'Fila de espera 1'", type: "channel" },
      { name: "fila2ChannelId",  title: "Canal 'Fila de espera 2'", type: "channel" },
      { name: "parentChannelId", title: "Canal PAI dos canais de jogo (GR, BL, Capitães) — deve ser o canal FILA ou um canal dentro dele", type: "channel" },
      { name: "lobbyChannelId",  title: "Canal LOBBY — jogadores voltam aqui após a partida", type: "channel" },
      { name: "rankingChannelId", title: "Canal RANKING (somente leitura, bot atualiza lá)", type: "channel" },
      { name: "serverName",      title: "Nome do Servidor de Jogo", type: "string", placeholder: "Operações Especiais" },
      { name: "adminGroupId",    title: "ID do Grupo Admin no TS3 (0 = desativado)", type: "number", placeholder: "0" },
      { name: "commandPrefix",   title: "Prefixo dos comandos", type: "string", placeholder: "!" },
      { name: "map1",  title: "Mapa 1",             type: "string", placeholder: "Mexico-T" },
      { name: "map2",  title: "Mapa 2",             type: "string", placeholder: "Olho de Aguia-T" },
      { name: "map3",  title: "Mapa 3",             type: "string", placeholder: "Sub-Base-T" },
      { name: "map4",  title: "Mapa 4",             type: "string", placeholder: "Viuva Negra-T" },
      { name: "map5",  title: "Mapa 5",             type: "string", placeholder: "Satelite-T" },
      { name: "map6",  title: "Mapa 6",             type: "string", placeholder: "Ankara-T" },
      { name: "map7",  title: "Mapa 7 (opcional)",  type: "string", placeholder: "" },
      { name: "map8",  title: "Mapa 8 (opcional)",  type: "string", placeholder: "" },
      { name: "map9",  title: "Mapa 9 (opcional)",  type: "string", placeholder: "" },
      { name: "map10", title: "Mapa 10 (opcional)", type: "string", placeholder: "" },
      {
        name: "rules",
        title: "Regras do servidor (comando !regra)",
        type: "multiline",
        placeholder: "1. Respeite todos\n2. Sem cheats\n3. Boa sorte!",
      },
    ],
  },

  function (sinusbot, config) {
    var event   = require("event");
    var backend = require("backend");
    var engine  = require("engine");
    var store   = require("store");

    var P            = config.commandPrefix || "!";
    var ADMIN_GID    = parseInt(config.adminGroupId) || 0;
    var NEEDED       = 10;
    var SERVER       = config.serverName || "Operações Especiais";
    var VETO_TIMEOUT = 180000; // 3 minutos

    // ─── Mapas ────────────────────────────────────────────────
    var MAPS_CONFIG = [];
    for (var mi = 1; mi <= 10; mi++) {
      var m = config["map" + mi];
      if (m && m.trim() !== "") MAPS_CONFIG.push(m.trim());
    }
    var DEFAULT_MAPS = ["Mexico-T","Olho de Aguia-T","Sub-Base-T","Viuva Negra-T","Satelite-T","Ankara-T"];
    var MAPS = MAPS_CONFIG.length >= 2 ? MAPS_CONFIG : DEFAULT_MAPS;

    var RULES = config.rules || "Nenhuma regra cadastrada.";

    // ─── Admins ───────────────────────────────────────────────
    var adminUids    = store.get("adminUids") || ["B9cKswU86lKLDWUNYs0bXTuIR5U="];
    var matchCounter = store.get("matchCounter") || 0;


    // ─── Ranking ──────────────────────────────────────────────
    // Estrutura: { 'uid': { name: 'Nick', pts: 0, wins: 0, losses: 0 } }
    var RANK_WIN  =  3;
    var RANK_LOSS = -3;

    function getRanking() { return store.get('ranking') || {}; }
    function saveRanking(r) { store.set('ranking', r); }

    function applyResult(winnerUids, loserUids) {
      var r = getRanking();
      winnerUids.forEach(function(u) {
        var nick = nameOf(u) !== '(offline)' ? nameOf(u) : u;
        if (!r[u]) r[u] = { name: nick, pts: 0, wins: 0, losses: 0 };
        else r[u].name = nick;
        r[u].pts  += RANK_WIN;
        r[u].wins += 1;
      });
      loserUids.forEach(function(u) {
        var nick = nameOf(u) !== '(offline)' ? nameOf(u) : u;
        if (!r[u]) r[u] = { name: nick, pts: 0, wins: 0, losses: 0 };
        else r[u].name = nick;
        r[u].pts    += RANK_LOSS;
        r[u].losses += 1;
      });
      saveRanking(r);
      updateRankingChannel();
    }

    function buildRankingText() {
      var r = getRanking();
      var list = [];
      for (var u in r) { if (r.hasOwnProperty(u)) list.push(r[u]); }
      list.sort(function(a, b) { return b.pts - a.pts; });
      if (list.length === 0) return 'Nenhuma partida registrada ainda.';
      var medals = ['1 lugar','2 lugar','3 lugar'];
      var lines  = ['RANKING   MIX CROSSFIRE', '================================='];
      list.forEach(function(p, i) {
        var pos = (i + 1) + '.';
        lines.push(pos + '  ' + p.name + '  |  ' + p.pts + ' pts  (' + p.wins + 'V / ' + p.losses + 'D)');
      });
      lines.push('=================================');
      lines.push('Total de partidas: ' + matchCounter);
      return lines.join('\n');
    }

    function updateRankingChannel() {
      if (!config.rankingChannelId) return;
      var ch = getChannel(config.rankingChannelId);
      if (!ch) return;
      try {
        ch.getClients().forEach(function(c) {
          if (!c.isSelf()) c.chat(buildRankingText());
        });
      } catch(e) {}
    }

    function saveAdmins() { store.set("adminUids", adminUids); }
    function addAdminUid(uid) {
      if (adminUids.indexOf(uid) === -1) { adminUids.push(uid); saveAdmins(); return true; }
      return false;
    }
    function removeAdminUid(uid) {
      var i = adminUids.indexOf(uid);
      if (i !== -1) { adminUids.splice(i, 1); saveAdmins(); return true; }
      return false;
    }
    function isAdmin(client) {
      if (adminUids.indexOf(client.uid()) !== -1) return true;
      if (ADMIN_GID !== 0) {
        var gs = client.getServerGroups();
        for (var i = 0; i < gs.length; i++)
          if (parseInt(gs[i].id()) === ADMIN_GID) return true;
      }
      return false;
    }

    // ─── Estado por slot ──────────────────────────────────────
    // status: "open" | "starting" | "veto" | "side" | "playing" | "disputed"
    // Canais criados por fase:
    //   veto/side → capChId  (CAPITÃES VETANDO FILA#N)
    //   playing   → grChId   (Global Risk FILA#N)
    //               blChId   (Black List FILA#N)

    function makeSlot(slotIndex) {
      return {
        slotIndex:   slotIndex,
        status:      "open",
        players:     [],
        matchNum:    null,
        capChId:     null,   // canal dos capitães (veto/lado)
        grChId:      null,   // canal Global Risk
        blChId:      null,   // canal Black List
        team1:       [],
        team2:       [],
        cap1:        null,
        cap2:        null,
        maps:        [],
        vetoTurn:    null,
        vetoTimer:   null,
        sideChooser: null,
        chosenMap:   null,
        team1Side:   null,
        team2Side:   null,
        blTeam:      [],
        grTeam:      [],
        blCap:       null,
        grCap:       null,
        blVote:      null,
        grVote:      null,
        password:    null,
        adminCalled: false,
      };
    }

    var slots = [makeSlot(0), makeSlot(1)];

    // Slot 1 só abre quando slot 0 estiver em "playing" ou "disputed"
    // (ou seja, o veto+lado já terminou)
    function slot1Unlocked() {
      var s0 = slots[0];
      return s0.status === "playing" || s0.status === "disputed";
    }

    // ─── Utilitários ──────────────────────────────────────────

    function shuffle(arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    }

    function randPass() {
      var s = String(Math.floor(Math.random() * 10000));
      while (s.length < 4) s = "0" + s;
      return s;
    }

    function getChannel(id) {
      if (!id) return null;
      var chs = backend.getChannels();
      for (var i = 0; i < chs.length; i++)
        if (chs[i].id() === id) return chs[i];
      return null;
    }

    function getClient(uid) {
      var cs = backend.getClients();
      for (var i = 0; i < cs.length; i++)
        if (cs[i].uid() === uid) return cs[i];
      return null;
    }

    function nameOf(uid) {
      var c = getClient(uid);
      return c ? c.name() : "(offline)";
    }

    function broadcast(msg) { backend.chat(msg); }

    // Envia mensagem para todos no canal da fila do slot
    function toFila(slot, msg) {
      var chId = slot.slotIndex === 0 ? config.filaChannelId : config.fila2ChannelId;
      var ch = getChannel(chId);
      if (!ch) return;
      ch.getClients().forEach(function(c) { if (!c.isSelf()) c.chat(msg); });
    }

    // Envia mensagem no canal dos capitães (veto/lado)
    function toCapChannel(slot, msg) {
      var ch = getChannel(slot.capChId);
      if (!ch) return;
      ch.getClients().forEach(function(c) { if (!c.isSelf()) c.chat(msg); });
    }

    function pm(uid, msg) {
      var c = getClient(uid);
      if (c) c.chat(msg);
    }

    function pokeClient(uid, msg) {
      var c = getClient(uid);
      if (c) c.poke(msg);
    }

    function pokeAdmins(msg) {
      backend.getClients().forEach(function(c) {
        if (!c.isSelf() && isAdmin(c)) c.poke("🚨 [ADMIN] " + msg);
      });
    }

    // ─── Canais ───────────────────────────────────────────────

    function createChannel(name) {
      try {
        var pid = config.parentChannelId || "0";
        var props = { name: name, parent: pid, permanent: false };
        var ch = backend.createChannel(props);
        if (ch) {
          engine.log("[Mix] Canal criado: '" + name + "' pai=" + pid + " id=" + ch.id());
          return ch.id();
        }
      } catch(e) {
        engine.log("[Mix] Erro ao criar canal '" + name + "': " + e);
      }
      return null;
    }

    function deleteChannel(chId) {
      if (!chId) return;
      try {
        var ch = getChannel(chId);
        if (ch) ch.delete();
      } catch(e) {}
    }

    function renameChannel(chId, newName) {
      if (!chId) return;
      try {
        var ch = getChannel(chId);
        if (ch) ch.setName(newName);
      } catch(e) {}
    }

    // ─── Nome dos canais de fila ──────────────────────────────
    // O canal de fila usa cspacer no TS3 — setName DEVE incluir o
    // prefixo exato do canal para não perder o separador.
    // Ajuste CSPACER_FILA1/2 para bater com o prefixo real do seu canal.
    // Exemplo: se o canal se chama "[cspacer]abc Fila 1 ...", use "[cspacer]abc "

    var CSPACER_FILA1 = "[cspacer]";
    var CSPACER_FILA2 = "[cspacer]";

    function updateFilaName(slot) {
      var chId    = slot.slotIndex === 0 ? config.filaChannelId : config.fila2ChannelId;
      var cspacer = slot.slotIndex === 0 ? CSPACER_FILA1 : CSPACER_FILA2;
      var ch = getChannel(chId);
      if (!ch) return;
      try {
        var n = slot.players.length;
        var suffix;
        if (slot.status === "open") {
          if (slot.slotIndex === 1 && !slot1Unlocked()) {
            suffix = "🔒 Fila de Espera — aguardando Fila 1 iniciar...";
          } else {
            var emoji = n <= 4 ? "🔴" : n <= 7 ? "🟡" : "🟢";
            var check = n >= NEEDED ? " ✅" : "";
            var label = slot.slotIndex === 0 ? "Fila 1" : "Fila 2";
            suffix = emoji + " " + label + " [ " + n + "/" + NEEDED + check + " ]";
          }
        } else {
          // Em partida: bolinha vermelha + aguardando
          var label2 = slot.slotIndex === 0 ? "Fila 1" : "Fila 2";
          suffix = "🔴 " + label2 + " [ aguardando... ]";
        }
        ch.setName(cspacer + suffix);
      } catch(e) {}
    }

    function updateAllFilaNames() {
      updateFilaName(slots[0]);
      updateFilaName(slots[1]);
    }

    // ─── Busca de estado ──────────────────────────────────────

    function slotOfQueue(uid) {
      for (var i = 0; i < slots.length; i++) {
        if (slots[i].status === "open" && slots[i].players.indexOf(uid) !== -1)
          return slots[i];
      }
      return null;
    }

    function slotOfMatch(uid) {
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        if (s.status === "veto" || s.status === "side" ||
            s.status === "playing" || s.status === "disputed") {
          if (s.team1.indexOf(uid) !== -1 || s.team2.indexOf(uid) !== -1)
            return s;
        }
      }
      return null;
    }

    function slotByMatchNum(num) {
      for (var i = 0; i < slots.length; i++) {
        if (slots[i].matchNum === num) return slots[i];
      }
      return null;
    }

    function isCaptainOf(slot, uid) {
      return uid === slot.cap1 || uid === slot.cap2;
    }

    // ─── INÍCIO DA PARTIDA ────────────────────────────────────

    function startMatch(slot) {
      matchCounter++;
      store.set("matchCounter", matchCounter);
      slot.matchNum = matchCounter;
      var tag = "FILA#" + matchCounter;

      // Resolve clientes online
      var players = [];
      for (var i = 0; i < slot.players.length; i++) {
        var c = getClient(slot.players[i]);
        if (c && !c.isSelf()) players.push(c);
      }

      if (players.length < 2) {
        broadcast("⚠️ [" + tag + "] Jogadores insuficientes online. Cancelando.");
        slot.players = []; slot.status = "open";
        updateAllFilaNames();
        return;
      }

      // Embaralha e divide os times
      var sh   = shuffle(players);
      var half = Math.floor(sh.length / 2);
      var t1p  = sh.slice(0, half);
      var t2p  = sh.slice(half);

      slot.team1       = t1p.map(function(c){ return c.uid(); });
      slot.team2       = t2p.map(function(c){ return c.uid(); });
      slot.cap1        = slot.team1[0];
      slot.cap2        = slot.team2[0];
      slot.maps        = MAPS.slice();
      slot.vetoTurn    = "cap1";
      slot.password    = randPass();
      slot.status      = "veto";
      slot.adminCalled = false;
      slot.players     = [];

      var capChId = createChannel("⚔️ CAPITÃES VETANDO " + tag);
      if (!capChId) {
        broadcast("⚠️ [" + tag + "] Erro ao criar canal de capitães! Verifique permissões do bot.");
        slot.players = []; slot.status = "open";
        updateAllFilaNames();
        return;
      }
      slot.capChId = capChId;

      // Arrasta os dois capitães para o canal de veto
      var cap1Client = getClient(slot.cap1);
      var cap2Client = getClient(slot.cap2);
      if (cap1Client) cap1Client.moveTo(capChId);
      if (cap2Client) cap2Client.moveTo(capChId);

      // Anuncia no canal principal
      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🎮  MIX INICIADO  —  " + tag + "\n" +
        "🖥️  Servidor : " + SERVER + "\n" +
        "🔑  Senha    : " + slot.password + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "⚪ Time 1  —  Cap: " + nameOf(slot.cap1) + "\n" +
        "   " + t1p.map(function(c){ return c.name(); }).join(", ") + "\n" +
        "⚪ Time 2  —  Cap: " + nameOf(slot.cap2) + "\n" +
        "   " + t2p.map(function(c){ return c.name(); }).join(", ") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "⚔️  Capitães foram movidos para o canal de veto!"
      );

      // Atualiza nomes (slot 1 ainda bloqueado enquanto veto não terminar)
      updateAllFilaNames();

      // Aguarda 1.5s para garantir que os caps já foram movidos para o canal
      // antes de enviar as mensagens de veto (moveTo é assíncrono no SinusBot)
      setTimeout(function() { startVeto(slot); }, 1500);
    }

    // ─── VETO ─────────────────────────────────────────────────

    function mapListText(maps) {
      return maps.map(function(m, i){ return "  " + (i+1) + ". " + m; }).join("\n");
    }

    function startVeto(slot) {
      if (slot.vetoTimer) { clearTimeout(slot.vetoTimer); slot.vetoTimer = null; }

      var capUid   = slot.vetoTurn === "cap1" ? slot.cap1 : slot.cap2;
      var otherUid = slot.vetoTurn === "cap1" ? slot.cap2 : slot.cap1;
      var tag      = "FILA#" + slot.matchNum;
      var listaTxt = mapListText(slot.maps);

      // Mensagem no canal dos capitães
      toCapChannel(slot,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🗺️  VETO DE MAPAS  —  " + tag + "\n" +
        listaTxt + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "👉 VEZ DE: " + nameOf(capUid) + "\n" +
        "   Use: " + P + "vetar <número>\n" +
        "⏳ " + nameOf(capUid) + " tem 3 minutos."
      );
      pokeClient(capUid, "👉 Sua vez de vetar em " + tag + "! Veja o canal de capitães.");

      slot.vetoTimer = setTimeout(function() {
        if (slot.status !== "veto") return;
        var idx = Math.floor(Math.random() * slot.maps.length);
        toCapChannel(slot, "⏰ Tempo esgotado! Bot vetou automaticamente: " + slot.maps[idx]);
        processVeto(slot, capUid, idx);
      }, VETO_TIMEOUT);
    }

    function processVeto(slot, voterUid, mapIdx) {
      if (slot.vetoTimer) { clearTimeout(slot.vetoTimer); slot.vetoTimer = null; }

      var vetoed = slot.maps.splice(mapIdx, 1)[0];
      var tag    = "FILA#" + slot.matchNum;

      toCapChannel(slot,
        "❌ " + nameOf(voterUid) + " vetou: [b]" + vetoed + "[/b]\n" +
        "   Restam " + slot.maps.length + " mapa(s)."
      );

      if (slot.maps.length === 1) {
        // Último mapa: vai para escolha de lado
        slot.chosenMap   = slot.maps[0];
        slot.status      = "side";
        // O adversário de quem fez o último veto escolhe o lado
        slot.sideChooser = voterUid === slot.cap1 ? slot.cap2 : slot.cap1;
        var otherSide    = slot.sideChooser === slot.cap1 ? slot.cap2 : slot.cap1;

        toCapChannel(slot,
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "🗺️  MAPA DEFINIDO: [b]" + slot.chosenMap + "[/b]\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "👉 " + nameOf(slot.sideChooser) + " escolhe o lado!\n" +
          "   " + P + "lado gr  →  🔵 Global Risk\n" +
          "   " + P + "lado bl  →  🔴 Black List\n" +
          "⏳ 3 minutos para escolher."
        );
        pokeClient(slot.sideChooser, "👉 Escolha o lado em " + tag + "! Veja o canal de capitães.");

        slot.vetoTimer = setTimeout(function() {
          if (slot.status !== "side") return;
          var rSide = Math.random() < 0.5 ? "gr" : "bl";
          toCapChannel(slot, "⏰ Tempo esgotado! Bot escolheu: " + (rSide === "gr" ? "🔵 Global Risk" : "🔴 Black List"));
          processSide(slot, slot.sideChooser, rSide);
        }, VETO_TIMEOUT);
        return;
      }

      // Alterna turno e continua veto
      slot.vetoTurn = slot.vetoTurn === "cap1" ? "cap2" : "cap1";
      startVeto(slot);
    }

    // ─── ESCOLHA DE LADO ──────────────────────────────────────

    function processSide(slot, chooserUid, side) {
      if (slot.vetoTimer) { clearTimeout(slot.vetoTimer); slot.vetoTimer = null; }

      var tag           = "FILA#" + slot.matchNum;
      var chooserIsCap1 = chooserUid === slot.cap1;
      var opponentSide  = side === "gr" ? "bl" : "gr";

      if (chooserIsCap1) {
        slot.team1Side = side; slot.team2Side = opponentSide;
      } else {
        slot.team2Side = side; slot.team1Side = opponentSide;
      }

      // Define quem é GR e quem é BL
      if (slot.team1Side === "gr") {
        slot.grTeam = slot.team1; slot.blTeam = slot.team2;
        slot.grCap  = slot.cap1;  slot.blCap  = slot.cap2;
      } else {
        slot.blTeam = slot.team1; slot.grTeam = slot.team2;
        slot.blCap  = slot.cap1;  slot.grCap  = slot.cap2;
      }

      slot.blVote = null; slot.grVote = null;
      slot.status = "playing";

      // Avisa no canal dos capitães antes de criar os canais
      toCapChannel(slot,
        "✅ Lado escolhido! Criando canais dos times...\n" +
        "🔵 Global Risk: " + nameOf(slot.grCap) + "\n" +
        "🔴 Black List: " + nameOf(slot.blCap)
      );

      // Deleta canal de capitães após 2s
      var capChToDelete = slot.capChId;
      slot.capChId = null;
      setTimeout(function() { deleteChannel(capChToDelete); }, 2000);

      // Cria os dois canais IMEDIATAMENTE (sem delay entre eles)
      var grChId = createChannel("🔵 Global Risk " + tag);
      var blChId = createChannel("🔴 Black List " + tag);

      slot.grChId = grChId;
      slot.blChId = blChId;

      if (!grChId || !blChId) {
        broadcast("⚠️ [" + tag + "] Falha ao criar canais! Verifique permissões do bot.");
        // Deleta o que foi criado se um deles falhou
        if (grChId) deleteChannel(grChId);
        if (blChId) deleteChannel(blChId);
        return;
      }

      // Move os jogadores após 1s (tempo para os canais estabilizarem no TS3)
      setTimeout(function() {
        slot.grTeam.forEach(function(u) {
          var c = getClient(u);
          if (c) c.moveTo(grChId);
        });
        slot.blTeam.forEach(function(u) {
          var c = getClient(u);
          if (c) c.moveTo(blChId);
        });
      }, 1000);

      // Anuncia no canal principal
      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🏁  PARTIDA DEFINIDA  —  " + tag + "\n" +
        "🗺️  Mapa     : " + slot.chosenMap + "\n" +
        "🖥️  Servidor : " + SERVER + "\n" +
        "🔑  Senha    : " + slot.password + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🔵 Global Risk  —  Cap: " + nameOf(slot.grCap) + "\n" +
        "   " + slot.grTeam.map(nameOf).join(", ") + "\n" +
        "🔴 Black List   —  Cap: " + nameOf(slot.blCap) + "\n" +
        "   " + slot.blTeam.map(nameOf).join(", ") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "ℹ️  Capitão: use " + P + "blwin ou " + P + "grwin ao fim."
      );

      pokeClient(slot.grCap, "👑 Você é CAP da 🔵 Global Risk em " + tag + "! Use " + P + "grwin para reportar vitória.");
      pokeClient(slot.blCap, "👑 Você é CAP da 🔴 Black List em " + tag + "! Use " + P + "blwin para reportar vitória.");

      // Desbloqueia fila 2
      updateAllFilaNames();
      if (slot.slotIndex === 0) {
        toFila(slots[1], "🔓 Fila 2 desbloqueada! Use " + P + "entrar para o próximo mix.");
      }
    }

    // ─── RESULTADO ────────────────────────────────────────────

    function registerVote(slot, voterUid, winner) {
      var isBL = voterUid === slot.blCap;
      if (isBL) slot.blVote = winner; else slot.grVote = winner;

      var tag       = "FILA#" + slot.matchNum;
      var teamLabel = isBL ? "🔴 Black List" : "🔵 Global Risk";
      var winLabel  = winner === "bl" ? "🔴 Black List" : "🔵 Global Risk";

      broadcast("🗳️  [" + tag + "] Cap da " + teamLabel + " (" + nameOf(voterUid) + ") reportou: " + winLabel + " venceu!");

      if (slot.blVote !== null && slot.grVote !== null) {
        if (slot.blVote === slot.grVote) {
          finishMatch(slot, slot.blVote, false);
        } else {
          slot.status = "disputed";
          broadcast(
            "⚠️  [" + tag + "] Capitães divergiram!\n" +
            "   Cap BL votou: " + (slot.blVote === "bl" ? "🔴 Black List" : "🔵 Global Risk") + "\n" +
            "   Cap GR votou: " + (slot.grVote === "bl" ? "🔴 Black List" : "🔵 Global Risk") + "\n" +
            "🚨 Admin necessário. Use " + P + "mix forçar <N> bl|gr"
          );
          pokeAdmins("Divergência em " + tag + "! Use " + P + "mix forçar " + slot.matchNum + " bl|gr");
        }
      }
    }

    function finishMatch(slot, winner, forced) {
      if (slot.vetoTimer) { clearTimeout(slot.vetoTimer); slot.vetoTimer = null; }

      var tag    = "FILA#" + slot.matchNum;
      var wLabel = winner === "bl" ? "🔴 Black List" : "🔵 Global Risk";

      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🏆  RESULTADO  —  " + tag + "\n" +
        "   Vencedor: " + wLabel + (forced ? " (admin)" : "") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

      slot.team1.concat(slot.team2).forEach(function(u) {
        var c = getClient(u);
        if (c) c.moveTo(config.lobbyChannelId);
      });

      var grCh = slot.grChId, blCh = slot.blChId, capCh = slot.capChId;
      setTimeout(function() {
        deleteChannel(grCh);
        deleteChannel(blCh);
        deleteChannel(capCh);
      }, 2000);

      // Aplica pontos de ranking
      var winTeam  = winner === 'bl' ? slot.blTeam : slot.grTeam;
      var loseTeam = winner === 'bl' ? slot.grTeam : slot.blTeam;
      applyResult(winTeam, loseTeam);

      resetSlot(slot);
    }

    function resetSlot(slot) {
      slot.status      = "open";
      slot.players     = [];
      slot.matchNum    = null;
      slot.capChId     = null;
      slot.grChId      = null;
      slot.blChId      = null;
      slot.team1       = []; slot.team2       = [];
      slot.cap1        = null; slot.cap2       = null;
      slot.maps        = []; slot.vetoTurn    = null;
      if (slot.vetoTimer) { clearTimeout(slot.vetoTimer); slot.vetoTimer = null; }
      slot.sideChooser = null; slot.chosenMap  = null;
      slot.team1Side   = null; slot.team2Side  = null;
      slot.blTeam = []; slot.grTeam = [];
      slot.blCap  = null; slot.grCap  = null;
      slot.blVote = null; slot.grVote = null;
      slot.password = null; slot.adminCalled = false;
      updateAllFilaNames();
    }

    // ─── Cancelar slot (admin) ────────────────────────────────

    function cancelSlot(slot, adminName) {
      var tag = slot.matchNum ? "FILA#" + slot.matchNum : "Fila " + (slot.slotIndex + 1);
      slot.team1.concat(slot.team2).concat(slot.players).forEach(function(u) {
        var c = getClient(u);
        if (c) c.moveTo(config.lobbyChannelId);
      });
      var grCh = slot.grChId, blCh = slot.blChId, capCh = slot.capChId;
      setTimeout(function() {
        deleteChannel(grCh);
        deleteChannel(blCh);
        deleteChannel(capCh);
      }, 1000);
      broadcast("🚫 [ADMIN] " + adminName + " cancelou " + tag + ". Todos voltaram ao lobby.");
      resetSlot(slot);
    }

    // ─── HANDLERS DE CHAT ─────────────────────────────────────

    event.on("chat", function(ev) {
      var raw    = ev.text.trim();
      var client = ev.client;
      if (client.isSelf()) return;

      var uid   = client.uid();
      var parts = raw.split(/\s+/);
      var cmd   = parts[0].toLowerCase();

      // ══ !entrar ══════════════════════════════════════════════
      if (cmd === P + "entrar") {
        if (slotOfMatch(uid)) {
          client.chat("🚫 Você já está em uma partida ativa! Aguarde terminar.");
          return;
        }
        if (slotOfQueue(uid)) {
          client.chat("⚠️ Você já está em uma fila. Use " + P + "sair para sair.");
          return;
        }

        var targetSlot = null;
        if (slots[0].status === "open") {
          if (config.filaChannelId) {
            var cch = client.getChannels()[0];
            if (!cch || cch.id() !== config.filaChannelId) {
              var fch = getChannel(config.filaChannelId);
              client.chat("❌ Vá para o canal [b]" + (fch ? fch.name() : "Fila 1") + "[/b] para entrar na fila!");
              return;
            }
          }
          targetSlot = slots[0];
        } else if (slot1Unlocked() && slots[1].status === "open") {
          if (config.fila2ChannelId) {
            var cch2 = client.getChannels()[0];
            if (!cch2 || cch2.id() !== config.fila2ChannelId) {
              var fch2 = getChannel(config.fila2ChannelId);
              client.chat("❌ Para a Fila 2, vá para o canal [b]" + (fch2 ? fch2.name() : "Fila 2") + "[/b]!");
              return;
            }
          }
          targetSlot = slots[1];
        } else {
          client.chat("❌ Nenhuma fila disponível no momento.");
          return;
        }

        targetSlot.players.push(uid);
        toFila(targetSlot, "✅ [" + client.name() + "] entrou! (" + targetSlot.players.length + "/" + NEEDED + ")");
        updateFilaName(targetSlot);

        if (targetSlot.players.length >= NEEDED) {
          toFila(targetSlot, "🚀 Fila completa! Iniciando mix...");
          targetSlot.status = "starting";
          startMatch(targetSlot);
        }
        return;
      }

      // ══ !sair ═════════════════════════════════════════════════
      if (cmd === P + "sair") {
        var sq = slotOfQueue(uid);
        if (!sq) { client.chat("⚠️ Você não está em nenhuma fila de espera."); return; }
        sq.players = sq.players.filter(function(u){ return u !== uid; });
        toFila(sq, "❌ [" + client.name() + "] saiu da fila. (" + sq.players.length + "/" + NEEDED + ")");
        updateFilaName(sq);
        return;
      }

      // ══ !fila ═════════════════════════════════════════════════
      if (cmd === P + "fila" || cmd === P + "filas") {
        var statusMap = { open:"🟢 Aberta", veto:"🟡 Veto", side:"🟡 Escolha de lado", playing:"🔴 Em jogo", disputed:"🟠 Em disputa", starting:"🔄 Iniciando" };
        var lines = ["📋 Status das filas:"];
        slots.forEach(function(s, i) {
          var sl = statusMap[s.status] || s.status;
          var extra = s.status === "open"
            ? " (" + s.players.length + "/" + NEEDED + ")"
            : s.matchNum ? " — FILA#" + s.matchNum : "";
          var lock = (i === 1 && !slot1Unlocked() && s.status === "open") ? " 🔒" : "";
          lines.push("  Fila " + (i+1) + ": " + sl + extra + lock);
        });
        lines.push("Total de partidas: " + matchCounter);
        client.chat(lines.join("\n"));
        return;
      }

      // ══ !regra ════════════════════════════════════════════════
      if (cmd === P + "regra" || cmd === P + "regras") {
        client.chat("📜 REGRAS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" + RULES + "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        return;
      }

      // ══ !vetar <n> ════════════════════════════════════════════
      if (cmd === P + "vetar") {
        var sm = slotOfMatch(uid);
        if (!sm || sm.status !== "veto") { client.chat("⚠️ Não há veto ativo para você agora."); return; }
        if (!isCaptainOf(sm, uid)) { client.chat("⚠️ Você não é capitão nesta partida."); return; }
        var currentCap = sm.vetoTurn === "cap1" ? sm.cap1 : sm.cap2;
        if (uid !== currentCap) {
          client.chat("⚠️ Não é sua vez! Aguarde " + nameOf(currentCap) + " vetar.");
          return;
        }
        var idx = parseInt(parts[1]) - 1;
        if (isNaN(idx) || idx < 0 || idx >= sm.maps.length) {
          client.chat("❌ Número inválido. Escolha entre 1 e " + sm.maps.length + ":\n" + mapListText(sm.maps));
          return;
        }
        processVeto(sm, uid, idx);
        return;
      }

      // ══ !lado gr|bl ═══════════════════════════════════════════
      if (cmd === P + "lado") {
        var sm2 = slotOfMatch(uid);
        if (!sm2 || sm2.status !== "side") { client.chat("⚠️ Não há escolha de lado ativa para você agora."); return; }
        if (uid !== sm2.sideChooser) {
          client.chat("⚠️ Não é você que escolhe o lado. É " + nameOf(sm2.sideChooser) + ".");
          return;
        }
        var side = (parts[1] || "").toLowerCase();
        if (side !== "gr" && side !== "bl") {
          client.chat("❌ Use: " + P + "lado gr  (🔵 Global Risk)  ou  " + P + "lado bl  (🔴 Black List)");
          return;
        }
        processSide(sm2, uid, side);
        return;
      }

      // ══ !blwin / !grwin ═══════════════════════════════════════
      if (cmd === P + "blwin" || cmd === P + "grwin") {
        var sm3 = slotOfMatch(uid);
        if (!sm3 || (sm3.status !== "playing" && sm3.status !== "disputed")) {
          client.chat("⚠️ Não há partida ativa para reportar resultado.");
          return;
        }
        if (uid !== sm3.blCap && uid !== sm3.grCap) {
          client.chat("⚠️ Você não é capitão desta partida.");
          return;
        }
        if (sm3.status === "disputed" && !isAdmin(client)) {
          client.chat("⚠️ Resultado em disputa. Aguarde um administrador.");
          return;
        }
        registerVote(sm3, uid, cmd === P + "blwin" ? "bl" : "gr");
        return;
      }

      // ══ !admin ════════════════════════════════════════════════
      if (cmd === P + "admin") {
        var sm4 = slotOfMatch(uid);
        if (!sm4) { client.chat("⚠️ Você não está em uma partida ativa."); return; }
        if (sm4.adminCalled) { client.chat("⏳ Um admin já foi chamado. Aguarde."); return; }
        sm4.adminCalled = true;
        var tag = "FILA#" + sm4.matchNum;
        broadcast("🚨 [" + tag + "] " + client.name() + " chamou um administrador!");
        pokeAdmins(client.name() + " chamou admin em " + tag + ".");
        client.chat("✅ Admins notificados!");
        return;
      }


      // ══ !ranking ══════════════════════════════════════════════
      if (cmd === P + 'ranking') {
        client.chat(buildRankingText());
        return;
      }

      // ══ !mix ══════════════════════════════════════════════════
      if (cmd === P + "mix") {
        var sub = (parts[1] || "").toLowerCase();

        if (sub === "help" || sub === "") {
          client.chat(
            "📖 Mix v8:\n" +
            P + "entrar               → Entra na fila disponível\n" +
            P + "sair                 → Sai da fila\n" +
            P + "fila                 → Status das filas\n" +
            P + "regra                → Regras do servidor\n" +
            P + "vetar <n>            → (Cap) Veta mapa no canal de capitães\n" +
            P + "lado gr|bl           → (Cap) Escolhe lado (gr=🔵 Global Risk, bl=🔴 Black List)\n" +
            P + "blwin / " + P + "grwin   → (Cap) Reporta resultado\n" +
            P + "admin                → Chama admin\n" +
            "── Admin ──\n" +
            P + "mix status                   → Status detalhado\n" +
            P + "mix cancelar <N>             → Cancela a FILA#N\n" +
            P + "mix cancelar todos           → Cancela todas as filas\n" +
            P + "mix filateste <n>            → Fila de teste com N jogadores\n" +
            P + "mix forçar <N> bl|gr         → Força resultado em disputa\n" +
            P + "mix admin add <uid>          → Adiciona admin\n" +
            P + "mix admin remove <uid>       → Remove admin\n" +
            P + 'mix admin listar             → Lista admins\n' +'── Resultados e Ranking ──\n' +P + 'mix vitoria <N> bl|gr        → Corrige vitória de partida ativa\n' +P + 'mix forçar <N> bl|gr         → Força resultado em disputa\n' +P + 'mix ranking                  → Ranking com UIDs (admin)\n' +P + 'mix pts <uid> <valor>        → Corrige pontos de jogador\n' +P + 'ranking                      → Ver ranking (todos)\n' +P + 'mix update                   → Instrução de atualização'
          );
          return;
        }

        if (!isAdmin(client)) { client.chat("❌ Permissão negada."); return; }

        // !mix status
        if (sub === "status") {
          var lines2 = ["📋 [ADMIN] Status — Total de partidas: " + matchCounter];
          slots.forEach(function(s, i) {
            var tag2 = s.matchNum ? "FILA#" + s.matchNum : "—";
            lines2.push("  Fila " + (i+1) + " | " + s.status + " | Partida: " + tag2 + " | Fila: " + s.players.length + "/" + NEEDED);
            if (s.cap1) lines2.push("    Cap1: " + nameOf(s.cap1) + " | Cap2: " + nameOf(s.cap2));
            if (s.chosenMap) lines2.push("    Mapa: " + s.chosenMap);
          });
          client.chat(lines2.join("\n"));
          return;
        }

        // !mix cancelar <N> | todos
        if (sub === "cancelar") {
          var arg = (parts[2] || "").toLowerCase();
          if (arg === "todos") {
            slots.forEach(function(s) {
              if (s.status !== "open" || s.players.length > 0) cancelSlot(s, client.name());
            });
            client.chat("✅ Todas as filas canceladas.");
            return;
          }
          var num = parseInt(arg);
          if (!isNaN(num) && num > 0) {
            var target = slotByMatchNum(num);
            if (target) { cancelSlot(target, client.name()); return; }
            client.chat("❌ Nenhuma partida ativa com número " + num + ".");
            return;
          }
          // Sem número: cancela a primeira ativa encontrada
          var canceled = false;
          for (var ci = 0; ci < slots.length; ci++) {
            if (slots[ci].status !== "open" || slots[ci].players.length > 0) {
              cancelSlot(slots[ci], client.name());
              canceled = true;
              break;
            }
          }
          if (!canceled) client.chat("⚠️ Nenhuma fila/partida ativa para cancelar.");
          return;
        }

        // !mix filateste <n>
        if (sub === "filateste") {
          var testSize = Math.max(2, Math.min(10, parseInt(parts[2]) || 2));
          var testSlot = null;
          if (slots[0].status === "open") testSlot = slots[0];
          else if (slot1Unlocked() && slots[1].status === "open") testSlot = slots[1];
          if (!testSlot) {
            client.chat("❌ Nenhuma fila aberta para teste. Use " + P + "mix cancelar primeiro.");
            return;
          }
          // Só usa jogadores que estão no canal correto da fila do slot
          var filaChId = testSlot.slotIndex === 0 ? config.filaChannelId : config.fila2ChannelId;
          var filaCh   = getChannel(filaChId);
          var inFila   = filaCh ? filaCh.getClients().filter(function(c){ return !c.isSelf(); }) : [];
          if (inFila.length < 2) {
            client.chat("❌ Precisa de pelo menos 2 jogadores no canal da fila para o teste. Estão lá: " + inFila.length);
            return;
          }
          var ordered2 = inFila.slice(0, testSize);
          testSlot.players = ordered2.map(function(c){ return c.uid(); });
          testSlot.status  = "starting";
          broadcast("🧪 [TESTE] " + client.name() + " iniciou teste na Fila " + (testSlot.slotIndex+1) + " com " + ordered2.length + " jogador(es): " + ordered2.map(function(c){ return c.name(); }).join(", "));
          var oldNeeded = NEEDED;
          NEEDED = ordered2.length;
          startMatch(testSlot);
          NEEDED = oldNeeded;
          return;
        }

        // !mix forçar <N> bl|gr
        if (sub === "forçar" || sub === "forcar") {
          var forceNum    = parseInt(parts[2]);
          var forceWinner = (parts[3] || "").toLowerCase();
          if (isNaN(forceNum) || (forceWinner !== "bl" && forceWinner !== "gr")) {
            client.chat("❌ Use: " + P + "mix forçar <número da fila> bl|gr\n   Ex: " + P + "mix forçar 3 bl");
            return;
          }
          var forceSlot = slotByMatchNum(forceNum);
          if (!forceSlot || (forceSlot.status !== "disputed" && forceSlot.status !== "playing")) {
            client.chat("❌ Sem partida ativa com número " + forceNum + " para forçar.");
            return;
          }
          broadcast("⚖️ [ADMIN] " + client.name() + " forçou resultado da FILA#" + forceNum + ".");
          finishMatch(forceSlot, forceWinner, true);
          return;
        }


        // !mix vitoria <N> bl|gr  — corrige resultado de partida ativa
        if (sub === 'vitoria') {
          var vitNum    = parseInt(parts[2]);
          var vitWinner = (parts[3] || '').toLowerCase();
          if (isNaN(vitNum) || (vitWinner !== 'bl' && vitWinner !== 'gr')) {
            client.chat('❌ Use: ' + P + 'mix vitoria <numero da fila> bl|gr  |  Ex: ' + P + 'mix vitoria 3 bl');
            return;
          }
          var vitSlot = slotByMatchNum(vitNum);
          if (!vitSlot || (vitSlot.status !== 'playing' && vitSlot.status !== 'disputed')) {
            client.chat('❌ Sem partida ativa com número ' + vitNum + '. Use !mix forçar para partidas já encerradas que travaram.');
            return;
          }
          var vitLabel = vitWinner === 'bl' ? '🔴 Black List' : '🔵 Global Risk';
          broadcast('⚖️ [ADMIN] ' + client.name() + ' corrigiu vitória da FILA#' + vitNum + ' para ' + vitLabel + '.');
          finishMatch(vitSlot, vitWinner, true);
          return;
        }

        // !mix pts <uid> <valor>  — corrige pontos de um jogador
        if (sub === 'pts') {
          var ptsUid = parts[2] || '';
          var ptsVal = parseInt(parts[3]);
          if (!ptsUid || isNaN(ptsVal)) {
            client.chat('❌ Use: ' + P + 'mix pts <uid> <pontos>  |  Ex: ' + P + 'mix pts ABC123= 15  | Dica: use !mix ranking para ver UIDs');
            return;
          }
          var r = getRanking();
          if (!r[ptsUid]) r[ptsUid] = { name: ptsUid, pts: 0, wins: 0, losses: 0 };
          var oldPts = r[ptsUid].pts;
          r[ptsUid].pts = ptsVal;
          // Tenta atualizar o nick se o jogador está online
          var ptsClient = getClient(ptsUid);
          if (ptsClient) r[ptsUid].name = ptsClient.name();
          saveRanking(r);
          updateRankingChannel();
          client.chat('✅ Pontos de ' + r[ptsUid].name + ' alterados: ' + oldPts + ' → ' + ptsVal);
          broadcast('📊 [ADMIN] ' + client.name() + ' ajustou pontos de ' + r[ptsUid].name + ': ' + oldPts + ' → ' + ptsVal + ' pts');
          return;
        }

        // !mix ranking  — mostra ranking completo (admin vê UIDs)
        if (sub === 'ranking') {
          var r2 = getRanking();
          var list2 = [];
          for (var u2 in r2) { if (r2.hasOwnProperty(u2)) list2.push({ uid: u2, data: r2[u2] }); }
          list2.sort(function(a, b) { return b.data.pts - a.data.pts; });
          var rlines = ['📋 [ADMIN] Ranking completo:'];
          list2.forEach(function(p, i) {
            rlines.push('  ' + (i+1) + '. ' + p.data.name + ' | ' + p.data.pts + ' pts (' + p.data.wins + 'V/' + p.data.losses + 'D) | UID: ' + p.uid);
          });
          if (list2.length === 0) rlines.push('  Nenhum jogador registrado ainda.');
          client.chat(rlines.join('\n'));
          return;
        }

        // !mix admin add/remove/listar
        if (sub === "admin") {
          var action = (parts[2] || "").toLowerCase();
          var target = parts[3] || "";
          if (action === "listar") {
            var alines = ["📋 Admins (" + adminUids.length + "):"];
            adminUids.forEach(function(u, i) {
              var ac = getClient(u);
              alines.push("  " + (i+1) + ". " + (ac ? ac.name() : "(offline)") + " — " + u);
            });
            client.chat(alines.join("\n"));
            return;
          }
          if (action === "add") {
            if (!target) { client.chat("❌ " + P + "mix admin add <uid>"); return; }
            if (addAdminUid(target)) {
              var ac2 = getClient(target);
              var aname2 = ac2 ? ac2.name() : target;
              client.chat("✅ " + aname2 + " adicionado como admin!");
              broadcast("🔑 " + client.name() + " adicionou " + aname2 + " como admin.");
              if (ac2) ac2.poke("✅ Você foi adicionado como admin do Mix por " + client.name() + "!");
            } else { client.chat("⚠️ UID já está na lista."); }
            return;
          }
          if (action === "remove") {
            if (!target) { client.chat("❌ " + P + "mix admin remove <uid>"); return; }
            if (removeAdminUid(target)) {
              var ac3 = getClient(target);
              client.chat("✅ " + (ac3 ? ac3.name() : target) + " removido dos admins.");
            } else { client.chat("⚠️ UID não encontrada."); }
            return;
          }
          client.chat("❌ " + P + "mix admin add <uid> | remove <uid> | listar");
          return;
        }



        // !mix pai  — mostra o canal pai de cada canal configurado
        if (sub === "pai") {
          var chs = backend.getChannels();
          function getChName(id) {
            for (var i = 0; i < chs.length; i++) if (chs[i].id() === id) return chs[i].name();
            return "?";
          }
          var f1 = backend.getChannelByID(config.filaChannelId);
          var lines3 = ["📋 Info dos canais configurados:"];
          if (f1) {
            var f1par = f1.parent ? f1.parent() : null;
            var f1parid = f1par ? f1par.id() : "raiz(0)";
            var f1parname = f1par ? f1par.name() : "raiz";
            lines3.push("Fila 1 [" + config.filaChannelId + "] → pai: [" + f1parid + "] " + f1parname);
          } else {
            lines3.push("Fila 1: canal não encontrado (ID=" + config.filaChannelId + ")");
          }
          lines3.push("parentChannelId configurado: [" + config.parentChannelId + "] " + getChName(config.parentChannelId));
          client.chat(lines3.join("\n"));
          return;
        }

        // !mix canais  — lista todos os canais com ID para configuração
        if (sub === "canais") {
          var chs = backend.getChannels();
          var lines = ["📋 Canais do servidor (use os IDs no SinusBot):"];
          chs.forEach(function(ch) {
            lines.push("  [" + ch.id() + "] " + ch.name());
          });
          // Divide em blocos de 20 para não estourar o limite de chat
          for (var ci = 0; ci < lines.length; ci += 20) {
            client.chat(lines.slice(ci, ci + 20).join("\n"));
          }
          return;
        }

        // !mix update
        if (sub === "update") {
          var URL  = "https://raw.githubusercontent.com/JoaoPedro004/mix_cf_ts/main/mix_shuffle.js";
          var PATH = "/opt/sinusbot/scripts/mix_shuffle.js";
          client.chat(
            "⚠️ Auto-update não suportado nesta versão do SinusBot.\n" +
            "Rode na VPS:\ncurl -o " + PATH + " " + URL + " && systemctl restart sinusbot"
          );
          return;
        }

        client.chat("❌ Subcomando inválido. Use " + P + "mix help");
        return;
      }
    });

    // ─── DESCONEXÃO ───────────────────────────────────────────

    event.on("clientDisconnect", function(ev) {
      if (!ev.client) return;
      var uid  = ev.client.uid();
      var name = ev.client.name();

      // Sai da fila de espera se estava em alguma
      slots.forEach(function(s) {
        if (s.status === "open" && s.players.indexOf(uid) !== -1) {
          s.players = s.players.filter(function(u){ return u !== uid; });
          toFila(s, "⚠️ [" + name + "] desconectou e saiu da fila. (" + s.players.length + "/" + NEEDED + ")");
          updateFilaName(s);
        }
      });

      // Avisa se capitão desconectou durante veto/lado
      slots.forEach(function(s) {
        if ((s.status === "veto" || s.status === "side") && (uid === s.cap1 || uid === s.cap2)) {
          broadcast("🚨 Capitão " + name + " desconectou durante veto/lado em FILA#" + s.matchNum + "!");
          pokeAdmins("Cap " + name + " desconectou em FILA#" + s.matchNum + ". Use " + P + "mix cancelar " + s.matchNum);
        }
        if ((s.status === "playing" || s.status === "disputed") && (uid === s.blCap || uid === s.grCap)) {
          var role = uid === s.blCap ? "🔴 Black List" : "🔵 Global Risk";
          broadcast("🚨 Capitão da " + role + " (" + name + ") desconectou em FILA#" + s.matchNum + "!");
          pokeAdmins("Cap " + name + " (" + role + ") desconectou em FILA#" + s.matchNum + ".");
        }
      });
    });

    // ─── INIT ─────────────────────────────────────────────────

    updateAllFilaNames();
    engine.log("✅ Mix Shuffle v8 carregado! Prefix=" + P + " | Partidas=" + matchCounter);
  }
);
