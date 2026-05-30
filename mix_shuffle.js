/**
 * Mix Shuffle - Crossfire v6.0
 * ─────────────────────────────────────────────────────────────
 * REGRAS DE COMUNICAÇÃO:
 *   - Fila (entrou/saiu)      → chat do canal Fila de espera
 *   - Veto / lado             → PV dos DOIS capitães (nunca canal principal)
 *   - Mix iniciado / resultado → canal principal (broadcast)
 *   - Admin / erros           → PV do jogador/admin
 */

registerPlugin(
  {
    name: "Mix Shuffle - Crossfire v6",
    version: "6.0.0",
    description: "Mix Crossfire com veto de mapas, escolha de lado e canais dinâmicos.",
    author: "Feito com Claude",
    vars: [
      { name: "filaChannelId",  title: "Canal 'Fila de espera' (jogadores aguardam aqui)", type: "channel" },
      { name: "parentChannelId",title: "Canal PAI — onde Time 1 e Time 2 serão criados",   type: "channel" },
      { name: "lobbyChannelId", title: "Canal LOBBY — jogadores voltam aqui após a partida",type: "channel" },
      { name: "serverName",     title: "Nome do Servidor de Jogo", type: "string", placeholder: "Operações Especiais" },
      { name: "adminGroupId",   title: "ID do Grupo Admin no TS3 (0 = desativado)", type: "number", placeholder: "0" },
      { name: "commandPrefix",  title: "Prefixo dos comandos", type: "string", placeholder: "!" },
      { name: "map1",  title: "Mapa 1",            type: "string", placeholder: "Mexico-T" },
      { name: "map2",  title: "Mapa 2",            type: "string", placeholder: "Olho de Aguia-T" },
      { name: "map3",  title: "Mapa 3",            type: "string", placeholder: "Sub-Base-T" },
      { name: "map4",  title: "Mapa 4",            type: "string", placeholder: "Viuva Negra-T" },
      { name: "map5",  title: "Mapa 5",            type: "string", placeholder: "Satelite-T" },
      { name: "map6",  title: "Mapa 6",            type: "string", placeholder: "Ankara-T" },
      { name: "map7",  title: "Mapa 7 (opcional)", type: "string", placeholder: "" },
      { name: "map8",  title: "Mapa 8 (opcional)", type: "string", placeholder: "" },
      { name: "map9",  title: "Mapa 9 (opcional)", type: "string", placeholder: "" },
      { name: "map10", title: "Mapa 10 (opcional)",type: "string", placeholder: "" },
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

    // ─── Estado ───────────────────────────────────────────────
    // status: "open" | "veto" | "side" | "playing" | "disputed"
    var queue = {
      status:   "open",
      players:  [],       // UIDs aguardando
      matchNum: null,
      t1ChId:   null,     // canal Time 1
      t2ChId:   null,     // canal Time 2
      team1:    [],       // UIDs time 1
      team2:    [],       // UIDs time 2
      cap1:     null,     // UID capitão time 1
      cap2:     null,     // UID capitão time 2
      maps:     [],
      vetoTurn: null,     // "cap1" | "cap2"
      vetoTimer: null,
      sideChooser: null,
      chosenMap: null,
      team1Side: null,    // "gr" | "bl"
      team2Side: null,
      blTeam:   [],
      grTeam:   [],
      blCap:    null,
      grCap:    null,
      blVote:   null,
      grVote:   null,
      password: null,
      adminCalled: false,
    };

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

    // Mensagem no chat principal (partida iniciada, resultado, admin)
    function broadcast(msg) { backend.chat(msg); }

    // Mensagem só para quem está no canal da fila
    function toFila(msg) {
      var ch = getChannel(config.filaChannelId);
      if (!ch) return;
      ch.getClients().forEach(function(c) { if (!c.isSelf()) c.chat(msg); });
    }

    // PV direto para um cliente específico
    function pm(uid, msg) {
      var c = getClient(uid);
      if (c) c.chat(msg);
    }

    // Poke em um cliente específico
    function pokeClient(uid, msg) {
      var c = getClient(uid);
      if (c) c.poke(msg);
    }

    // Poke em todos os admins online
    function pokeAdmins(msg) {
      backend.getClients().forEach(function(c) {
        if (!c.isSelf() && isAdmin(c)) c.poke("🚨 [ADMIN] " + msg);
      });
    }

    // ─── Canais ───────────────────────────────────────────────

    function createChannel(name, afterId) {
      try {
        var parentId = config.parentChannelId || config.lobbyChannelId || "0";
        var props = { name: name, parent: parentId, permanent: false };
        if (afterId) {
          props.order = afterId;
        }
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

    // ─── Nome da fila ─────────────────────────────────────────

    function updateFilaName() {
      var ch = getChannel(config.filaChannelId);
      if (!ch) return;
      try {
        var n = queue.players.length;
        var name;
        if (queue.status === "open") {
          var emoji = n <= 4 ? "🔴" : n <= 7 ? "🟡" : "🟢";
          var check  = n >= NEEDED ? " ✅" : "";
          name = emoji + " Fila de espera [ " + n + "/" + NEEDED + check + " ]";
        } else {
          name = "⏳ Fila de espera [ aguardando... ]";
        }
        ch.setName(name);
      } catch(e) {}
    }

    // ─── Busca de estado ──────────────────────────────────────

    function inQueue(uid) {
      return queue.status === "open" && queue.players.indexOf(uid) !== -1;
    }

    function inActiveMatch(uid) {
      if (queue.status === "veto" || queue.status === "side" ||
          queue.status === "playing" || queue.status === "disputed") {
        return queue.team1.indexOf(uid) !== -1 || queue.team2.indexOf(uid) !== -1;
      }
      return false;
    }

    function isCaptain(uid) {
      return uid === queue.cap1 || uid === queue.cap2;
    }

    // ─── INÍCIO DA PARTIDA ────────────────────────────────────

    function startMatch() {
      matchCounter++;
      store.set("matchCounter", matchCounter);
      queue.matchNum = matchCounter;
      var tag = "FILA#" + matchCounter;

      // Cria Time 1 primeiro, depois Time 2 logo abaixo
      var t1 = createChannel("Time 1 — " + tag, null);
      var t2 = createChannel("Time 2 — " + tag, t1);

      if (!t1 || !t2) {
        broadcast("⚠️ [" + tag + "] Erro ao criar canais! Verifique permissões do bot.");
        // Cancela e reabre a fila
        queue.players = [];
        queue.status  = "open";
        updateFilaName();
        return;
      }

      queue.t1ChId = t1;
      queue.t2ChId = t2;

      // Resolve clientes (apenas os que ainda estão online)
      var players = [];
      for (var i = 0; i < queue.players.length; i++) {
        var c = getClient(queue.players[i]);
        if (c && !c.isSelf()) players.push(c);
      }

      if (players.length < 2) {
        broadcast("⚠️ [" + tag + "] Jogadores insuficientes online. Cancelando.");
        deleteChannel(t1); deleteChannel(t2);
        queue.players = []; queue.status = "open";
        updateFilaName();
        return;
      }

      // Embaralha e divide — garante times iguais
      var sh   = shuffle(players);
      var half = Math.floor(sh.length / 2);
      var t1p  = sh.slice(0, half);
      var t2p  = sh.slice(half);

      queue.team1 = t1p.map(function(c){ return c.uid(); });
      queue.team2 = t2p.map(function(c){ return c.uid(); });
      queue.cap1  = queue.team1[0];
      queue.cap2  = queue.team2[0];
      queue.maps  = MAPS.slice();
      queue.vetoTurn = "cap1";
      queue.password = randPass();
      queue.status   = "veto";
      queue.adminCalled = false;
      queue.players  = [];

      // Arrasta jogadores para os canais
      t1p.forEach(function(c){ c.moveTo(t1); });
      t2p.forEach(function(c){ c.moveTo(t2); });

      // Anuncia no canal principal
      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🎮  MIX INICIADO  —  " + tag + "\n" +
        "🖥️  Servidor : " + SERVER + "\n" +
        "🔑  Senha    : " + queue.password + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "⚪ Time 1  —  Cap: " + nameOf(queue.cap1) + "\n" +
        "   " + t1p.map(function(c){ return c.name(); }).join(", ") + "\n" +
        "⚪ Time 2  —  Cap: " + nameOf(queue.cap2) + "\n" +
        "   " + t2p.map(function(c){ return c.name(); }).join(", ") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🗺️  Veto de mapas em andamento no PV dos capitães..."
      );

      // Reabre fila imediatamente
      queue.status = "veto"; // mantém veto, mas fila pode receber novos
      updateFilaName();
      toFila("✅ A fila está aberta! Use " + P + "entrar para o próximo mix.");

      // Inicia veto
      startVeto();
    }

    // ─── VETO ─────────────────────────────────────────────────

    function mapListText(maps) {
      return maps.map(function(m, i){ return "  " + (i+1) + ". " + m; }).join("\n");
    }

    function startVeto() {
      if (queue.vetoTimer) { clearTimeout(queue.vetoTimer); queue.vetoTimer = null; }

      var capUid   = queue.vetoTurn === "cap1" ? queue.cap1 : queue.cap2;
      var otherUid = queue.vetoTurn === "cap1" ? queue.cap2 : queue.cap1;
      var tag      = "FILA#" + queue.matchNum;

      var listaTxt = mapListText(queue.maps);

      // PV para quem deve vetar
      pm(capUid,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🗺️  VETO DE MAPAS  —  " + tag + "\n" +
        listaTxt + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "👉 É A SUA VEZ! Use: " + P + "vetar <número>\n" +
        "⏳ Você tem 3 minutos."
      );
      pokeClient(capUid, "👉 Sua vez de vetar em " + tag + "! Veja o PV.");

      // PV para o outro — só mostra a lista e informa que está aguardando
      pm(otherUid,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🗺️  VETO DE MAPAS  —  " + tag + "\n" +
        listaTxt + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "⏳ Aguardando " + nameOf(capUid) + " vetar..."
      );

      // Timeout automático
      queue.vetoTimer = setTimeout(function() {
        if (queue.status !== "veto") return;
        var idx = Math.floor(Math.random() * queue.maps.length);
        pm(capUid, "⏰ Tempo esgotado! Bot vetou automaticamente: " + queue.maps[idx]);
        pm(otherUid, "⏰ " + nameOf(capUid) + " demorou! Bot vetou automaticamente: " + queue.maps[idx]);
        processVeto(capUid, idx);
      }, VETO_TIMEOUT);
    }

    function processVeto(voterUid, mapIdx) {
      if (queue.vetoTimer) { clearTimeout(queue.vetoTimer); queue.vetoTimer = null; }

      var vetoed   = queue.maps.splice(mapIdx, 1)[0];
      var tag      = "FILA#" + queue.matchNum;
      var otherUid = voterUid === queue.cap1 ? queue.cap2 : queue.cap1;

      // Avisa ambos no PV
      pm(voterUid,  "❌ Você vetou: [b]" + vetoed + "[/b] | Restam " + queue.maps.length + " mapa(s)");
      pm(otherUid, "❌ " + nameOf(voterUid) + " vetou: [b]" + vetoed + "[/b] | Restam " + queue.maps.length + " mapa(s)");

      // Sobrou 1 mapa?
      if (queue.maps.length === 1) {
        queue.chosenMap   = queue.maps[0];
        queue.status      = "side";
        // Quem fez o último veto = adversário escolhe o lado
        queue.sideChooser = voterUid === queue.cap1 ? queue.cap2 : queue.cap1;
        var otherSide     = queue.sideChooser === queue.cap1 ? queue.cap2 : queue.cap1;

        pm(queue.sideChooser,
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "🗺️  MAPA DEFINIDO: [b]" + queue.chosenMap + "[/b]\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "👉 É A SUA VEZ de escolher o lado!\n" +
          "   " + P + "lado gr  →  Global Risk\n" +
          "   " + P + "lado tr  →  Terroristas\n" +
          "⏳ Você tem 3 minutos."
        );
        pokeClient(queue.sideChooser, "👉 Escolha o lado em " + tag + "! Veja o PV.");

        pm(otherSide,
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "🗺️  MAPA DEFINIDO: [b]" + queue.chosenMap + "[/b]\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "⏳ Aguardando " + nameOf(queue.sideChooser) + " escolher o lado..."
        );

        // Timeout escolha de lado
        queue.vetoTimer = setTimeout(function() {
          if (queue.status !== "side") return;
          var rSide = Math.random() < 0.5 ? "gr" : "tr";
          pm(queue.sideChooser, "⏰ Tempo esgotado! Bot escolheu: " + (rSide === "gr" ? "Global Risk" : "Terroristas"));
          processSide(queue.sideChooser, rSide);
        }, VETO_TIMEOUT);
        return;
      }

      // Alterna turno
      queue.vetoTurn = queue.vetoTurn === "cap1" ? "cap2" : "cap1";
      startVeto();
    }

    // ─── ESCOLHA DE LADO ──────────────────────────────────────

    function processSide(chooserUid, side) {
      if (queue.vetoTimer) { clearTimeout(queue.vetoTimer); queue.vetoTimer = null; }

      var tag          = "FILA#" + queue.matchNum;
      var chooserIsCap1 = chooserUid === queue.cap1;
      var opponentSide = side === "gr" ? "tr" : "gr";

      if (chooserIsCap1) {
        queue.team1Side = side; queue.team2Side = opponentSide;
      } else {
        queue.team2Side = side; queue.team1Side = opponentSide;
      }

      // Define BL e GR
      if (queue.team1Side === "gr") {
        queue.grTeam = queue.team1; queue.blTeam = queue.team2;
        queue.grCap  = queue.cap1;  queue.blCap  = queue.cap2;
      } else {
        queue.blTeam = queue.team1; queue.grTeam = queue.team2;
        queue.blCap  = queue.cap1;  queue.grCap  = queue.cap2;
      }

      queue.blVote = null; queue.grVote = null;
      queue.status = "playing";

      // Renomeia canais
      var t1Label = queue.team1Side === "gr" ? "Global Risk" : "Black List";
      var t2Label = queue.team2Side === "gr" ? "Global Risk" : "Black List";
      renameChannel(queue.t1ChId, t1Label + " — " + tag);
      renameChannel(queue.t2ChId, t2Label + " — " + tag);

      var t1Emoji = queue.team1Side === "gr" ? "🔴" : "🔵";
      var t2Emoji = queue.team2Side === "gr" ? "🔴" : "🔵";

      // Anuncia no canal principal
      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🏁  PARTIDA DEFINIDA  —  " + tag + "\n" +
        "🗺️  Mapa     : " + queue.chosenMap + "\n" +
        "🖥️  Servidor : " + SERVER + "\n" +
        "🔑  Senha    : " + queue.password + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        t1Emoji + " " + t1Label + "  —  Cap: " + nameOf(queue.cap1) + "\n" +
        "   " + queue.team1.map(nameOf).join(", ") + "\n" +
        t2Emoji + " " + t2Label + "  —  Cap: " + nameOf(queue.cap2) + "\n" +
        "   " + queue.team2.map(nameOf).join(", ") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "ℹ️  Capitão: use " + P + "blwin ou " + P + "grwin ao fim."
      );

      // Poke nos capitães
      pokeClient(queue.cap1, "👑 Você é CAPITÃO em " + tag + "! Use " + P + "blwin ou " + P + "grwin para reportar.");
      pokeClient(queue.cap2, "👑 Você é CAPITÃO em " + tag + "! Use " + P + "blwin ou " + P + "grwin para reportar.");
    }

    // ─── RESULTADO ────────────────────────────────────────────

    function registerVote(voterUid, winner) {
      var isBL = voterUid === queue.blCap;
      if (isBL) queue.blVote = winner; else queue.grVote = winner;

      var tag       = "FILA#" + queue.matchNum;
      var teamLabel = isBL ? "Black List" : "Global Risk";
      var winLabel  = winner === "bl" ? "Black List" : "Global Risk";

      broadcast("🗳️  [" + tag + "] Cap da " + teamLabel + " (" + nameOf(voterUid) + ") reportou: " + winLabel + " venceu!");

      if (queue.blVote !== null && queue.grVote !== null) {
        if (queue.blVote === queue.grVote) {
          finishMatch(queue.blVote, false);
        } else {
          queue.status = "disputed";
          broadcast(
            "⚠️  [" + tag + "] Capitães divergiram!\n" +
            "   Cap BL votou: " + (queue.blVote === "bl" ? "Black List" : "Global Risk") + "\n" +
            "   Cap GR votou: " + (queue.grVote === "bl" ? "Black List" : "Global Risk") + "\n" +
            "🚨 Admin necessário. Use " + P + "mix forçar bl|gr"
          );
          pokeAdmins("Divergência em " + tag + "! Use " + P + "mix forçar bl|gr");
        }
      }
    }

    function finishMatch(winner, forced) {
      if (queue.vetoTimer) { clearTimeout(queue.vetoTimer); queue.vetoTimer = null; }

      var tag    = "FILA#" + queue.matchNum;
      var wLabel = winner === "bl" ? "🔵 Black List" : "🔴 Global Risk";

      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🏆  RESULTADO  —  " + tag + "\n" +
        "   Vencedor: " + wLabel + (forced ? " (admin)" : "") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

      // Move todos ao lobby
      queue.team1.concat(queue.team2).forEach(function(uid) {
        var c = getClient(uid);
        if (c) c.moveTo(config.lobbyChannelId);
      });

      // Deleta canais após 2s
      var t1 = queue.t1ChId, t2 = queue.t2ChId;
      setTimeout(function() { deleteChannel(t1); deleteChannel(t2); }, 2000);

      resetQueue();
    }

    function resetQueue() {
      queue.status   = "open";
      queue.players  = [];
      queue.matchNum = null;
      queue.t1ChId   = null; queue.t2ChId   = null;
      queue.team1    = []; queue.team2    = [];
      queue.cap1     = null; queue.cap2    = null;
      queue.maps     = []; queue.vetoTurn = null;
      if (queue.vetoTimer) { clearTimeout(queue.vetoTimer); queue.vetoTimer = null; }
      queue.sideChooser = null; queue.chosenMap  = null;
      queue.team1Side   = null; queue.team2Side  = null;
      queue.blTeam = []; queue.grTeam = [];
      queue.blCap  = null; queue.grCap  = null;
      queue.blVote = null; queue.grVote = null;
      queue.password = null; queue.adminCalled = false;
      updateFilaName();
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
        // Deve estar no canal Fila de espera
        if (config.filaChannelId) {
          var cch = client.getChannels()[0];
          if (!cch || cch.id() !== config.filaChannelId) {
            var fch = getChannel(config.filaChannelId);
            client.chat("❌ Vá para o canal [b]" + (fch ? fch.name() : "Fila de espera") + "[/b] e tente novamente!");
            return;
          }
        }
        if (inActiveMatch(uid)) {
          client.chat("🚫 Você já está em uma partida ativa! Aguarde terminar.");
          return;
        }
        if (inQueue(uid)) {
          client.chat("⚠️ Você já está na fila. Use " + P + "sair para sair.");
          return;
        }
        if (queue.status !== "open") {
          client.chat("❌ A fila não está aberta no momento.");
          return;
        }
        queue.players.push(uid);
        toFila("✅ [" + client.name() + "] entrou na fila! (" + queue.players.length + "/" + NEEDED + ")");
        updateFilaName();

        if (queue.players.length >= NEEDED) {
          toFila("🚀 Fila completa! Iniciando mix...");
          queue.status = "starting";
          startMatch();
        }
        return;
      }

      // ══ !sair ═════════════════════════════════════════════════
      if (cmd === P + "sair") {
        if (!inQueue(uid)) { client.chat("⚠️ Você não está na fila de espera."); return; }
        queue.players = queue.players.filter(function(u){ return u !== uid; });
        toFila("❌ [" + client.name() + "] saiu da fila. (" + queue.players.length + "/" + NEEDED + ")");
        updateFilaName();
        return;
      }

      // ══ !fila ═════════════════════════════════════════════════
      if (cmd === P + "fila" || cmd === P + "filas") {
        var statusMap = { open:"🟢 Aberta", veto:"🟡 Veto", side:"🟡 Escolha de lado", playing:"🔴 Em jogo", disputed:"🟠 Em disputa", starting:"🔄 Iniciando" };
        var sl = statusMap[queue.status] || queue.status;
        var extra = queue.status === "open"
          ? " (" + queue.players.length + "/" + NEEDED + ")"
          : queue.matchNum ? " — FILA#" + queue.matchNum : "";
        client.chat("📋 Fila: " + sl + extra + "\nTotal de partidas: " + matchCounter);
        return;
      }

      // ══ !regra ════════════════════════════════════════════════
      if (cmd === P + "regra" || cmd === P + "regras") {
        client.chat("📜 REGRAS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" + RULES + "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        return;
      }

      // ══ !vetar <n> ════════════════════════════════════════════
      if (cmd === P + "vetar") {
        if (queue.status !== "veto") { client.chat("⚠️ Não há veto ativo agora."); return; }
        if (!isCaptain(uid)) { client.chat("⚠️ Você não é capitão nesta partida."); return; }
        var currentCap = queue.vetoTurn === "cap1" ? queue.cap1 : queue.cap2;
        if (uid !== currentCap) {
          client.chat("⚠️ Não é sua vez! Aguarde " + nameOf(currentCap) + " vetar.");
          return;
        }
        var idx = parseInt(parts[1]) - 1;
        if (isNaN(idx) || idx < 0 || idx >= queue.maps.length) {
          client.chat("❌ Número inválido. Escolha entre 1 e " + queue.maps.length + ":\n" + mapListText(queue.maps));
          return;
        }
        processVeto(uid, idx);
        return;
      }

      // ══ !lado gr|tr ═══════════════════════════════════════════
      if (cmd === P + "lado") {
        if (queue.status !== "side") { client.chat("⚠️ Não há escolha de lado ativa agora."); return; }
        if (uid !== queue.sideChooser) {
          client.chat("⚠️ Não é você que escolhe o lado. É " + nameOf(queue.sideChooser) + ".");
          return;
        }
        var side = (parts[1] || "").toLowerCase();
        if (side !== "gr" && side !== "tr") {
          client.chat("❌ Use: " + P + "lado gr  ou  " + P + "lado tr");
          return;
        }
        processSide(uid, side);
        return;
      }

      // ══ !blwin / !grwin ═══════════════════════════════════════
      if (cmd === P + "blwin" || cmd === P + "grwin") {
        if (queue.status !== "playing" && queue.status !== "disputed") {
          client.chat("⚠️ Não há partida ativa para reportar resultado.");
          return;
        }
        if (uid !== queue.blCap && uid !== queue.grCap) {
          client.chat("⚠️ Você não é capitão desta partida.");
          return;
        }
        if (queue.status === "disputed" && !isAdmin(client)) {
          client.chat("⚠️ Resultado em disputa. Aguarde um administrador.");
          return;
        }
        registerVote(uid, cmd === P + "blwin" ? "bl" : "gr");
        return;
      }

      // ══ !admin ════════════════════════════════════════════════
      if (cmd === P + "admin") {
        if (!inActiveMatch(uid)) { client.chat("⚠️ Você não está em uma partida ativa."); return; }
        if (queue.adminCalled) { client.chat("⏳ Um admin já foi chamado. Aguarde."); return; }
        queue.adminCalled = true;
        var tag = "FILA#" + queue.matchNum;
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
            "📖 Mix v6:\n" +
            P + "entrar            → Entra na fila\n" +
            P + "sair              → Sai da fila\n" +
            P + "fila              → Status da fila\n" +
            P + "regra             → Regras do servidor\n" +
            P + "vetar <n>         → (Cap) Veta mapa\n" +
            P + "lado gr|tr        → (Cap) Escolhe lado\n" +
            P + "blwin / " + P + "grwin → (Cap) Reporta resultado\n" +
            P + "admin             → Chama admin\n" +
            "── Admin ──\n" +
            P + "mix status               → Status detalhado\n" +
            P + "mix cancelar             → Cancela partida/fila atual\n" +
            P + "mix filateste <n>        → Fila de teste com N jogadores\n" +
            P + "mix forçar bl|gr         → Força resultado em disputa\n" +
            P + "mix admin add <uid>      → Adiciona admin\n" +
            P + "mix admin remove <uid>   → Remove admin\n" +
            P + "mix admin listar         → Lista admins\n" +
            P + "mix update               → Atualiza do GitHub"
          );
          return;
        }

        if (!isAdmin(client)) { client.chat("❌ Permissão negada."); return; }

        // !mix status
        if (sub === "status") {
          var tag = queue.matchNum ? "FILA#" + queue.matchNum : "—";
          var lines = [
            "📋 [ADMIN] Status:",
            "Status: " + queue.status,
            "Partida: " + tag,
            "Fila: " + queue.players.length + "/" + NEEDED,
            "Total partidas: " + matchCounter,
          ];
          if (queue.cap1) lines.push("Cap1: " + nameOf(queue.cap1) + " | Cap2: " + nameOf(queue.cap2));
          if (queue.chosenMap) lines.push("Mapa: " + queue.chosenMap);
          client.chat(lines.join("\n"));
          return;
        }

        // !mix cancelar
        if (sub === "cancelar") {
          var tag = queue.matchNum ? "FILA#" + queue.matchNum : "fila de espera";
          // Move todos de volta ao lobby
          queue.team1.concat(queue.team2).concat(queue.players).forEach(function(u) {
            var c = getClient(u);
            if (c) c.moveTo(config.lobbyChannelId);
          });
          var t1 = queue.t1ChId, t2 = queue.t2ChId;
          setTimeout(function() { deleteChannel(t1); deleteChannel(t2); }, 1000);
          broadcast("🚫 [ADMIN] " + client.name() + " cancelou a " + tag + ". Todos voltaram ao lobby.");
          resetQueue();
          return;
        }

        // !mix filateste <n>
        if (sub === "filateste") {
          var testSize = Math.max(2, Math.min(10, parseInt(parts[2]) || 2));

          if (queue.status !== "open") {
            client.chat("❌ Fila não está aberta. Use " + P + "mix cancelar primeiro.");
            return;
          }

          // Pega jogadores online, exclui o bot
          var allOnline = backend.getClients().filter(function(c){ return !c.isSelf(); });
          if (allOnline.length < 2) { client.chat("❌ Precisa de pelo menos 2 jogadores online."); return; }

          // Prioridade: quem chamou → outros admins → resto
          var others  = allOnline.filter(function(c){ return c.uid() !== uid; });
          var admins  = others.filter(function(c){ return isAdmin(c); });
          var normals = others.filter(function(c){ return !isAdmin(c); });
          var ordered = [client].concat(admins).concat(normals).slice(0, testSize);

          queue.players = ordered.map(function(c){ return c.uid(); });
          queue.status  = "starting";

          broadcast(
            "🧪 [TESTE] " + client.name() + " iniciou teste com " + ordered.length + " jogador(es): " +
            ordered.map(function(c){ return c.name(); }).join(", ")
          );

          var old = NEEDED;
          NEEDED = ordered.length;
          startMatch();
          NEEDED = old;
          return;
        }

        // !mix forçar bl|gr
        if (sub === "forçar" || sub === "forcar") {
          var winner = (parts[2] || "").toLowerCase();
          if (winner !== "bl" && winner !== "gr") { client.chat("❌ Use: " + P + "mix forçar bl|gr"); return; }
          if (queue.status !== "disputed" && queue.status !== "playing") {
            client.chat("❌ Sem partida ativa para forçar.");
            return;
          }
          broadcast("⚖️ [ADMIN] " + client.name() + " forçou resultado da FILA#" + queue.matchNum + ".");
          finishMatch(winner, true);
          return;
        }

        // !mix admin add/remove/listar
        if (sub === "admin") {
          var action = (parts[2] || "").toLowerCase();
          var target = parts[3] || "";

          if (action === "listar") {
            var lines = ["📋 Admins (" + adminUids.length + "):"];
            adminUids.forEach(function(u, i) {
              var ac = getClient(u);
              lines.push("  " + (i+1) + ". " + (ac ? ac.name() : "(offline)") + " — " + u);
            });
            client.chat(lines.join("\n"));
            return;
          }
          if (action === "add") {
            if (!target) { client.chat("❌ " + P + "mix admin add <uid>"); return; }
            if (addAdminUid(target)) {
              var ac = getClient(target);
              var aname = ac ? ac.name() : target;
              client.chat("✅ " + aname + " adicionado como admin!");
              broadcast("🔑 " + client.name() + " adicionou " + aname + " como admin.");
              if (ac) ac.poke("✅ Você foi adicionado como admin do Mix por " + client.name() + "!");
            } else { client.chat("⚠️ UID já está na lista."); }
            return;
          }
          if (action === "remove") {
            if (!target) { client.chat("❌ " + P + "mix admin remove <uid>"); return; }
            if (removeAdminUid(target)) {
              var ac = getClient(target);
              client.chat("✅ " + (ac ? ac.name() : target) + " removido dos admins.");
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

      if (inQueue(uid)) {
        queue.players = queue.players.filter(function(u){ return u !== uid; });
        toFila("⚠️ [" + name + "] desconectou e saiu da fila. (" + queue.players.length + "/" + NEEDED + ")");
        updateFilaName();
      }

      if (queue.status === "veto" || queue.status === "side") {
        if (uid === queue.cap1 || uid === queue.cap2) {
          broadcast("🚨 Capitão " + name + " desconectou durante o veto/lado em FILA#" + queue.matchNum + "!");
          pokeAdmins("Cap " + name + " desconectou em FILA#" + queue.matchNum + ". Use " + P + "mix cancelar se necessário.");
        }
      }
      if (queue.status === "playing" || queue.status === "disputed") {
        if (uid === queue.blCap || uid === queue.grCap) {
          var role = uid === queue.blCap ? "Black List" : "Global Risk";
          broadcast("🚨 Capitão da " + role + " (" + name + ") desconectou em FILA#" + queue.matchNum + "!");
          pokeAdmins("Cap " + name + " (" + role + ") desconectou em FILA#" + queue.matchNum + ".");
        }
      }
    });

    // ─── INIT ─────────────────────────────────────────────────

    updateFilaName();
    engine.log("✅ Mix Shuffle v6 carregado! Prefix=" + P + " | Partidas=" + matchCounter);
  }
);
