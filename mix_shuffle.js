/**
 * Mix Shuffle - Crossfire v7.0
 * ─────────────────────────────────────────────────────────────
 * REGRAS DE COMUNICAÇÃO:
 *   - Fila (entrou/saiu)      → chat do canal Fila de espera
 *   - Veto / lado             → PV dos DOIS capitães (nunca canal principal)
 *   - Mix iniciado / resultado → canal principal (broadcast)
 *   - Admin / erros           → PV do jogador/admin
 *
 * MUDANÇAS v7:
 *   - Duas filas simultâneas independentes (matches[0] e matches[1])
 *   - A segunda fila só aceita jogadores após a primeira completar 10
 *   - Canais nomeados: TIME 1#N e TIME 2#N (com número da partida)
 *   - Global Risk = 🔵 azul | Black List = 🔴 vermelho
 *   - !mix cancelar <N> — qualquer admin cancela qualquer fila/partida pelo número
 */

registerPlugin(
  {
    name: "Mix Shuffle - Crossfire v7",
    version: "7.0.0",
    description: "Mix Crossfire com duas filas simultâneas, veto de mapas e escolha de lado.",
    author: "Feito com Claude",
    vars: [
      { name: "filaChannelId",   title: "Canal 'Fila de espera' (jogadores aguardam aqui)", type: "channel" },
      { name: "fila2ChannelId",  title: "Canal 'Fila de espera 2' (segunda fila)", type: "channel" },
      { name: "parentChannelId", title: "Canal PAI — onde os canais de time serão criados",  type: "channel" },
      { name: "lobbyChannelId",  title: "Canal LOBBY — jogadores voltam aqui após a partida", type: "channel" },
      { name: "serverName",      title: "Nome do Servidor de Jogo", type: "string", placeholder: "Operações Especiais" },
      { name: "adminGroupId",    title: "ID do Grupo Admin no TS3 (0 = desativado)", type: "number", placeholder: "0" },
      { name: "commandPrefix",   title: "Prefixo dos comandos", type: "string", placeholder: "!" },
      { name: "map1",  title: "Mapa 1",            type: "string", placeholder: "Mexico-T" },
      { name: "map2",  title: "Mapa 2",            type: "string", placeholder: "Olho de Aguia-T" },
      { name: "map3",  title: "Mapa 3",            type: "string", placeholder: "Sub-Base-T" },
      { name: "map4",  title: "Mapa 4",            type: "string", placeholder: "Viuva Negra-T" },
      { name: "map5",  title: "Mapa 5",            type: "string", placeholder: "Satelite-T" },
      { name: "map6",  title: "Mapa 6",            type: "string", placeholder: "Ankara-T" },
      { name: "map7",  title: "Mapa 7 (opcional)", type: "string", placeholder: "" },
      { name: "map8",  title: "Mapa 8 (opcional)", type: "string", placeholder: "" },
      { name: "map9",  title: "Mapa 9 (opcional)", type: "string", placeholder: "" },
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

    // ─── Fábricas de estado ───────────────────────────────────
    // Cada "slot" representa uma fila/partida independente
    // slot 0 = fila principal | slot 1 = segunda fila
    // status: "open" | "starting" | "veto" | "side" | "playing" | "disputed"

    function makeSlot(slotIndex) {
      return {
        slotIndex:   slotIndex,
        status:      "open",
        players:     [],
        matchNum:    null,
        t1ChId:      null,
        t2ChId:      null,
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

    // Dois slots: slots[0] e slots[1]
    var slots = [makeSlot(0), makeSlot(1)];

    // O slot 1 (segunda fila) só fica ativo quando slot 0 já estiver em partida
    function slot1Unlocked() {
      var s0 = slots[0];
      return s0.status === "veto" || s0.status === "side" ||
             s0.status === "playing" || s0.status === "disputed";
    }

    // ─── Utilitários gerais ───────────────────────────────────

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

    // Mensagem só para quem está no canal da fila do slot
    function toFila(slot, msg) {
      var chId = slot.slotIndex === 0 ? config.filaChannelId : config.fila2ChannelId;
      var ch = getChannel(chId);
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
        var parentId = config.parentChannelId || config.lobbyChannelId || "0";
        var props = { name: name, parent: parentId, permanent: false };
        var ch = backend.createChannel(props);
        if (ch) {
          engine.log("[Mix] Canal criado: '" + name + "' id=" + ch.id());
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

    function updateFilaName(slot) {
      var chId = slot.slotIndex === 0 ? config.filaChannelId : config.fila2ChannelId;
      var ch = getChannel(chId);
      if (!ch) return;
      try {
        var n = slot.players.length;
        var name;
        if (slot.status === "open") {
          // Slot 1 mostra "bloqueado" se slot 0 ainda não tiver 10 players em partida
          if (slot.slotIndex === 1 && !slot1Unlocked()) {
            name = "🔒 Fila 2 — aguardando Fila 1 iniciar...";
          } else {
            var emoji = n <= 4 ? "🔴" : n <= 7 ? "🟡" : "🟢";
            var check = n >= NEEDED ? " ✅" : "";
            var label = slot.slotIndex === 0 ? "Fila 1" : "Fila 2";
            name = emoji + " " + label + " [ " + n + "/" + NEEDED + check + " ]";
          }
        } else {
          var label2 = slot.slotIndex === 0 ? "Fila 1" : "Fila 2";
          name = "⏳ " + label2 + " [ aguardando... ]";
        }
        ch.setName(name);
      } catch(e) {}
    }

    function updateAllFilaNames() {
      updateFilaName(slots[0]);
      updateFilaName(slots[1]);
    }

    // ─── Busca de estado ──────────────────────────────────────

    // Retorna o slot em que o uid está na fila de espera (ou null)
    function slotOfQueue(uid) {
      for (var i = 0; i < slots.length; i++) {
        if (slots[i].status === "open" && slots[i].players.indexOf(uid) !== -1)
          return slots[i];
      }
      return null;
    }

    // Retorna o slot em que o uid está em partida ativa (ou null)
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

    // Retorna slot pelo número da partida (matchNum)
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

      // Cria TIME 1#N e TIME 2#N
      var t1 = createChannel("TIME 1#" + matchCounter);
      var t2 = createChannel("TIME 2#" + matchCounter);

      if (!t1 || !t2) {
        broadcast("⚠️ [" + tag + "] Erro ao criar canais! Verifique permissões do bot.");
        if (t1) deleteChannel(t1);
        if (t2) deleteChannel(t2);
        slot.players = [];
        slot.status  = "open";
        updateFilaName(slot);
        return;
      }

      slot.t1ChId = t1;
      slot.t2ChId = t2;

      // Resolve clientes online
      var players = [];
      for (var i = 0; i < slot.players.length; i++) {
        var c = getClient(slot.players[i]);
        if (c && !c.isSelf()) players.push(c);
      }

      if (players.length < 2) {
        broadcast("⚠️ [" + tag + "] Jogadores insuficientes online. Cancelando.");
        deleteChannel(t1); deleteChannel(t2);
        slot.players = []; slot.status = "open";
        updateAllFilaNames();
        return;
      }

      // Embaralha e divide
      var sh   = shuffle(players);
      var half = Math.floor(sh.length / 2);
      var t1p  = sh.slice(0, half);
      var t2p  = sh.slice(half);

      slot.team1    = t1p.map(function(c){ return c.uid(); });
      slot.team2    = t2p.map(function(c){ return c.uid(); });
      slot.cap1     = slot.team1[0];
      slot.cap2     = slot.team2[0];
      slot.maps     = MAPS.slice();
      slot.vetoTurn = "cap1";
      slot.password = randPass();
      slot.status   = "veto";
      slot.adminCalled = false;
      slot.players  = [];

      // Move jogadores para os canais
      t1p.forEach(function(c){ c.moveTo(t1); });
      t2p.forEach(function(c){ c.moveTo(t2); });

      // Anuncia no canal principal
      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🎮  MIX INICIADO  —  " + tag + "\n" +
        "🖥️  Servidor : " + SERVER + "\n" +
        "🔑  Senha    : " + slot.password + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "⚪ TIME 1#" + matchCounter + "  —  Cap: " + nameOf(slot.cap1) + "\n" +
        "   " + t1p.map(function(c){ return c.name(); }).join(", ") + "\n" +
        "⚪ TIME 2#" + matchCounter + "  —  Cap: " + nameOf(slot.cap2) + "\n" +
        "   " + t2p.map(function(c){ return c.name(); }).join(", ") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🗺️  Veto de mapas em andamento no PV dos capitães..."
      );

      // Atualiza nomes das filas (pode desbloquear slot 1)
      updateAllFilaNames();
      toFila(slot, "✅ Use " + P + "entrar para o próximo mix nesta fila!");

      startVeto(slot);
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

      pm(capUid,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🗺️  VETO DE MAPAS  —  " + tag + "\n" +
        listaTxt + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "👉 É A SUA VEZ! Use: " + P + "vetar <número>\n" +
        "⏳ Você tem 3 minutos."
      );
      pokeClient(capUid, "👉 Sua vez de vetar em " + tag + "! Veja o PV.");

      pm(otherUid,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🗺️  VETO DE MAPAS  —  " + tag + "\n" +
        listaTxt + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "⏳ Aguardando " + nameOf(capUid) + " vetar..."
      );

      slot.vetoTimer = setTimeout(function() {
        if (slot.status !== "veto") return;
        var idx = Math.floor(Math.random() * slot.maps.length);
        pm(capUid, "⏰ Tempo esgotado! Bot vetou automaticamente: " + slot.maps[idx]);
        pm(otherUid, "⏰ " + nameOf(capUid) + " demorou! Bot vetou automaticamente: " + slot.maps[idx]);
        processVeto(slot, capUid, idx);
      }, VETO_TIMEOUT);
    }

    function processVeto(slot, voterUid, mapIdx) {
      if (slot.vetoTimer) { clearTimeout(slot.vetoTimer); slot.vetoTimer = null; }

      var vetoed   = slot.maps.splice(mapIdx, 1)[0];
      var tag      = "FILA#" + slot.matchNum;
      var otherUid = voterUid === slot.cap1 ? slot.cap2 : slot.cap1;

      pm(voterUid, "❌ Você vetou: [b]" + vetoed + "[/b] | Restam " + slot.maps.length + " mapa(s)");
      pm(otherUid, "❌ " + nameOf(voterUid) + " vetou: [b]" + vetoed + "[/b] | Restam " + slot.maps.length + " mapa(s)");

      if (slot.maps.length === 1) {
        slot.chosenMap   = slot.maps[0];
        slot.status      = "side";
        slot.sideChooser = voterUid === slot.cap1 ? slot.cap2 : slot.cap1;
        var otherSide    = slot.sideChooser === slot.cap1 ? slot.cap2 : slot.cap1;

        pm(slot.sideChooser,
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "🗺️  MAPA DEFINIDO: [b]" + slot.chosenMap + "[/b]\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "👉 É A SUA VEZ de escolher o lado!\n" +
          "   " + P + "lado gr  →  🔵 Global Risk\n" +
          "   " + P + "lado bl  →  🔴 Black List\n" +
          "⏳ Você tem 3 minutos."
        );
        pokeClient(slot.sideChooser, "👉 Escolha o lado em " + tag + "! Veja o PV.");

        pm(otherSide,
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "🗺️  MAPA DEFINIDO: [b]" + slot.chosenMap + "[/b]\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "⏳ Aguardando " + nameOf(slot.sideChooser) + " escolher o lado..."
        );

        slot.vetoTimer = setTimeout(function() {
          if (slot.status !== "side") return;
          var rSide = Math.random() < 0.5 ? "gr" : "bl";
          pm(slot.sideChooser, "⏰ Tempo esgotado! Bot escolheu: " + (rSide === "gr" ? "🔵 Global Risk" : "🔴 Black List"));
          processSide(slot, slot.sideChooser, rSide);
        }, VETO_TIMEOUT);
        return;
      }

      slot.vetoTurn = slot.vetoTurn === "cap1" ? "cap2" : "cap1";
      startVeto(slot);
    }

    // ─── ESCOLHA DE LADO ──────────────────────────────────────

    function processSide(slot, chooserUid, side) {
      if (slot.vetoTimer) { clearTimeout(slot.vetoTimer); slot.vetoTimer = null; }

      var tag           = "FILA#" + slot.matchNum;
      var chooserIsCap1 = chooserUid === slot.cap1;
      // "gr" = Global Risk (azul), "bl" = Black List (vermelho)
      var opponentSide  = side === "gr" ? "bl" : "gr";

      if (chooserIsCap1) {
        slot.team1Side = side; slot.team2Side = opponentSide;
      } else {
        slot.team2Side = side; slot.team1Side = opponentSide;
      }

      if (slot.team1Side === "gr") {
        slot.grTeam = slot.team1; slot.blTeam = slot.team2;
        slot.grCap  = slot.cap1;  slot.blCap  = slot.cap2;
      } else {
        slot.blTeam = slot.team1; slot.grTeam = slot.team2;
        slot.blCap  = slot.cap1;  slot.grCap  = slot.cap2;
      }

      slot.blVote = null; slot.grVote = null;
      slot.status = "playing";

      // Renomeia canais com lado definido — TIME 1#N (Global Risk) etc.
      var t1SideLabel = slot.team1Side === "gr" ? "Global Risk" : "Black List";
      var t2SideLabel = slot.team2Side === "gr" ? "Global Risk" : "Black List";
      renameChannel(slot.t1ChId, "TIME 1#" + slot.matchNum + " (" + t1SideLabel + ")");
      renameChannel(slot.t2ChId, "TIME 2#" + slot.matchNum + " (" + t2SideLabel + ")");

      // 🔵 Global Risk | 🔴 Black List
      var t1Emoji = slot.team1Side === "gr" ? "🔵" : "🔴";
      var t2Emoji = slot.team2Side === "gr" ? "🔵" : "🔴";

      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🏁  PARTIDA DEFINIDA  —  " + tag + "\n" +
        "🗺️  Mapa     : " + slot.chosenMap + "\n" +
        "🖥️  Servidor : " + SERVER + "\n" +
        "🔑  Senha    : " + slot.password + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        t1Emoji + " " + t1SideLabel + "  —  Cap: " + nameOf(slot.cap1) + "\n" +
        "   " + slot.team1.map(nameOf).join(", ") + "\n" +
        t2Emoji + " " + t2SideLabel + "  —  Cap: " + nameOf(slot.cap2) + "\n" +
        "   " + slot.team2.map(nameOf).join(", ") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "ℹ️  Capitão: use " + P + "blwin ou " + P + "grwin ao fim."
      );

      pokeClient(slot.cap1, "👑 Você é CAPITÃO em " + tag + "! Use " + P + "blwin ou " + P + "grwin para reportar.");
      pokeClient(slot.cap2, "👑 Você é CAPITÃO em " + tag + "! Use " + P + "blwin ou " + P + "grwin para reportar.");
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
      // 🔵 Global Risk | 🔴 Black List
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

      var t1 = slot.t1ChId, t2 = slot.t2ChId;
      setTimeout(function() { deleteChannel(t1); deleteChannel(t2); }, 2000);

      resetSlot(slot);
    }

    function resetSlot(slot) {
      slot.status      = "open";
      slot.players     = [];
      slot.matchNum    = null;
      slot.t1ChId      = null; slot.t2ChId      = null;
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
      var tag = slot.matchNum ? "FILA#" + slot.matchNum : "fila " + (slot.slotIndex + 1);
      slot.team1.concat(slot.team2).concat(slot.players).forEach(function(u) {
        var c = getClient(u);
        if (c) c.moveTo(config.lobbyChannelId);
      });
      var t1 = slot.t1ChId, t2 = slot.t2ChId;
      setTimeout(function() { deleteChannel(t1); deleteChannel(t2); }, 1000);
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
        // Verifica se já está em algum slot (fila ou partida)
        if (slotOfMatch(uid)) {
          client.chat("🚫 Você já está em uma partida ativa! Aguarde terminar.");
          return;
        }
        if (slotOfQueue(uid)) {
          client.chat("⚠️ Você já está em uma fila. Use " + P + "sair para sair.");
          return;
        }

        // Determina em qual slot o jogador deve entrar:
        // slot 0 sempre que estiver open; slot 1 só se slot 0 estiver em partida
        var targetSlot = null;
        if (slots[0].status === "open") {
          // Verifica canal (fila 1)
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
          // Verifica canal (fila 2)
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
          var lock = (i === 1 && !slot1Unlocked()) ? " 🔒" : "";
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

      // ══ !mix ══════════════════════════════════════════════════
      if (cmd === P + "mix") {
        var sub = (parts[1] || "").toLowerCase();

        if (sub === "help" || sub === "") {
          client.chat(
            "📖 Mix v7:\n" +
            P + "entrar               → Entra na fila disponível\n" +
            P + "sair                 → Sai da fila\n" +
            P + "fila                 → Status das filas\n" +
            P + "regra                → Regras do servidor\n" +
            P + "vetar <n>            → (Cap) Veta mapa\n" +
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
            P + "mix admin listar             → Lista admins\n" +
            P + "mix update                   → Atualiza do GitHub"
          );
          return;
        }

        if (!isAdmin(client)) { client.chat("❌ Permissão negada."); return; }

        // !mix status
        if (sub === "status") {
          var lines2 = ["📋 [ADMIN] Status — Total de partidas: " + matchCounter];
          slots.forEach(function(s, i) {
            var tag2 = s.matchNum ? "FILA#" + s.matchNum : "—";
            lines2.push("  Fila " + (i+1) + " | Status: " + s.status + " | Partida: " + tag2 + " | Fila: " + s.players.length + "/" + NEEDED);
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
            // Cancela pelo número da partida
            var target = slotByMatchNum(num);
            if (target) {
              cancelSlot(target, client.name());
              return;
            }
            client.chat("❌ Nenhuma partida ativa com número " + num + ".");
            return;
          }
          // Sem argumento: cancela a fila 1 (comportamento legado)
          if (slots[0].status !== "open" || slots[0].players.length > 0) {
            cancelSlot(slots[0], client.name());
          } else if (slots[1].status !== "open" || slots[1].players.length > 0) {
            cancelSlot(slots[1], client.name());
          } else {
            client.chat("⚠️ Nenhuma fila/partida ativa para cancelar.");
          }
          return;
        }

        // !mix filateste <n>
        if (sub === "filateste") {
          var testSize = Math.max(2, Math.min(10, parseInt(parts[2]) || 2));
          // Encontra slot disponível para teste
          var testSlot = null;
          if (slots[0].status === "open") testSlot = slots[0];
          else if (slot1Unlocked() && slots[1].status === "open") testSlot = slots[1];
          if (!testSlot) {
            client.chat("❌ Nenhuma fila aberta para teste. Use " + P + "mix cancelar primeiro.");
            return;
          }
          var allOnline = backend.getClients().filter(function(c){ return !c.isSelf(); });
          if (allOnline.length < 2) { client.chat("❌ Precisa de pelo menos 2 jogadores online."); return; }
          var others2  = allOnline.filter(function(c){ return c.uid() !== uid; });
          var admins2  = others2.filter(function(c){ return isAdmin(c); });
          var normals2 = others2.filter(function(c){ return !isAdmin(c); });
          var ordered2 = [client].concat(admins2).concat(normals2).slice(0, testSize);
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
          var forceNum = parseInt(parts[2]);
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

      // Verifica saída de fila de espera
      slots.forEach(function(s) {
        if (s.status === "open" && s.players.indexOf(uid) !== -1) {
          s.players = s.players.filter(function(u){ return u !== uid; });
          toFila(s, "⚠️ [" + name + "] desconectou e saiu da fila. (" + s.players.length + "/" + NEEDED + ")");
          updateFilaName(s);
        }
      });

      // Verifica desconexão de capitão durante veto/lado ou partida
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
    engine.log("✅ Mix Shuffle v7 carregado! Prefix=" + P + " | Partidas=" + matchCounter);
  }
);
