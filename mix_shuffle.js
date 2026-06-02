/**
 * Mix Shuffle - Crossfire v9.0
 * ─────────────────────────────────────────────────────────────
 * FLUXO:
 *   1. Jogador usa !x5 para entrar na fila (precisa estar no canal Fila de espera)
 *   2. Ao atingir 10/10: mix inicia, fila ZERA imediatamente (novos podem entrar)
 *   3. Bot cria canal "⚔️ CAPITÃES FILA#N", arrasta os 2 caps
 *   4. Veto de mapas no canal dos capitães (5 vetos, sobra 1 mapa)
 *   5. Quem fez o último veto = adversário escolhe o lado (!lado gr / !lado tr)
 *   6. Bot cria GR e BL, move os times, deleta canal de caps
 *   7. Bot volta para o canal Fila de espera
 *   8. Capitães reportam resultado com !blwin / !grwin
 *   9. Divergência = admin decide com !mix forçar bl|gr
 *
 * CARGO FILA:
 *   - Aplicado ao entrar na fila (!x5)
 *   - Removido ao sair (!sair), desconectar ou mix iniciar
 */

registerPlugin(
  {
    name: "Mix Shuffle - Crossfire v9",
    version: "9.0.0",
    description: "Mix Crossfire — fila única, veto de mapas, escolha de lado, cargo FILA automático.",
    author: "Feito com Claude",
    vars: [
      { name: "filaChannelId",   title: "Canal 'Fila de espera'",                                          type: "channel" },
      { name: "parentChannelId", title: "Canal PAI — onde GR, BL e Capitães serão criados",                type: "channel" },
      { name: "lobbyChannelId",  title: "Canal LOBBY — jogadores voltam aqui após a partida",              type: "channel" },
      { name: "serverName",      title: "Nome do Servidor de Jogo",    type: "string",  placeholder: "Operações Especiais" },
      { name: "adminGroupId",    title: "ID do Grupo Admin no TS3",    type: "number",  placeholder: "0" },
      { name: "filaGroupId",     title: "ID do Cargo FILA no TS3 (sgid=34)",  type: "number",  placeholder: "34" },
      { name: "commandPrefix",   title: "Prefixo dos comandos",        type: "string",  placeholder: "!" },
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
    var ADMIN_GID    = parseInt(config.adminGroupId)  || 0;
    var FILA_GID     = parseInt(config.filaGroupId)   || 34;
    var NEEDED       = 10;
    var SERVER       = config.serverName || "Operações Especiais";
    var VETO_TIMEOUT = 180000; // 3 minutos

    // ─── Mapas ────────────────────────────────────────────────
    var MAPS_CFG = [];
    for (var mi = 1; mi <= 10; mi++) {
      var m = config["map" + mi];
      if (m && m.trim()) MAPS_CFG.push(m.trim());
    }
    var MAPS = MAPS_CFG.length >= 2 ? MAPS_CFG : [
      "Mexico-T","Olho de Aguia-T","Sub-Base-T","Viuva Negra-T","Satelite-T","Ankara-T"
    ];
    var RULES = config.rules || "Nenhuma regra cadastrada.";

    // ─── Persistência ─────────────────────────────────────────
    var adminUids    = store.get("adminUids")    || ["B9cKswU86lKLDWUNYs0bXTuIR5U="];
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

    // ─── Estado único da fila ─────────────────────────────────
    // queue.status: "open" | "veto" | "side" | "playing" | "disputed"
    var queue = {
      status:   "open",
      players:  [],        // UIDs aguardando (zera ao iniciar o mix)
      matchNum: null,
      capChId:  null,      // canal temporário dos capitães
      grChId:   null,
      blChId:   null,
      team1:    [],        // UIDs time 1
      team2:    [],        // UIDs time 2
      cap1:     null,      // UID cap time 1
      cap2:     null,      // UID cap time 2
      maps:     [],
      vetoTurn: null,      // "cap1" | "cap2"
      vetoTimer: null,
      sideChooser: null,
      chosenMap:   null,
      grTeam:   [],
      blTeam:   [],
      grCap:    null,
      blCap:    null,
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

    function isAdmin(client) {
      if (adminUids.indexOf(client.uid()) !== -1) return true;
      if (ADMIN_GID !== 0) {
        var gs = client.getServerGroups();
        for (var i = 0; i < gs.length; i++)
          if (parseInt(gs[i].id()) === ADMIN_GID) return true;
      }
      return false;
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

    function broadcast(msg)      { backend.chat(msg); }

    function toFila(msg) {
      var ch = getChannel(config.filaChannelId);
      if (!ch) return;
      ch.getClients().forEach(function(c) { if (!c.isSelf()) c.chat(msg); });
    }

    function toCapCh(msg) {
      if (!queue.capChId) return;
      var ch = getChannel(queue.capChId);
      if (!ch) return;
      ch.getClients().forEach(function(c) { if (!c.isSelf()) c.chat(msg); });
    }

    function pm(uid, msg) {
      var c = getClient(uid);
      if (c) c.chat(msg);
    }

    function poke(uid, msg) {
      var c = getClient(uid);
      if (c) c.poke(msg);
    }

    function pokeAdmins(msg) {
      backend.getClients().forEach(function(c) {
        if (!c.isSelf() && isAdmin(c)) c.poke("🚨 [ADMIN] " + msg);
      });
    }

    // ─── Cargo FILA ───────────────────────────────────────────
    // Usa o método nativo do SinusBot via objeto Client

    function addFilaGroup(uid) {
      if (!FILA_GID) return;
      try {
        var c = getClient(uid);
        if (!c) return;
        // Verifica se já tem o cargo para não duplicar
        var grupos = c.getServerGroups();
        for (var i = 0; i < grupos.length; i++) {
          if (parseInt(grupos[i].id()) === FILA_GID) return; // já tem
        }
        c.addToServerGroup(FILA_GID);
        engine.log("[Mix] Cargo FILA +" + c.name());
      } catch(e) {
        engine.log("[Mix] addFilaGroup erro: " + e);
      }
    }

    function removeFilaGroup(uid) {
      if (!FILA_GID) return;
      try {
        var c = getClient(uid);
        if (!c) return;
        c.removeFromServerGroup(FILA_GID);
        engine.log("[Mix] Cargo FILA -" + c.name());
      } catch(e) {
        engine.log("[Mix] removeFilaGroup erro: " + e);
      }
    }

    // ─── Canal ───────────────────────────────────────────────

    function createChannel(name) {
      try {
        var parentId = config.parentChannelId || config.lobbyChannelId || "0";
        var ch = backend.createChannel({ name: name, parent: parentId, permanent: false });
        if (ch) { engine.log("[Mix] Canal criado: " + name); return ch.id(); }
      } catch(e) { engine.log("[Mix] Erro criar canal: " + e); }
      return null;
    }

    function deleteChannel(chId) {
      if (!chId) return;
      try { var ch = getChannel(chId); if (ch) ch.delete(); } catch(e) {}
    }

    function renameChannel(chId, name) {
      if (!chId) return;
      try { var ch = getChannel(chId); if (ch) ch.setName(name); } catch(e) {}
    }

    // ─── Nome do canal da fila ────────────────────────────────

    function updateFilaName() {
      var ch = getChannel(config.filaChannelId);
      if (!ch) return;
      try {
        var n     = queue.players.length;
        var emoji = n === 0 ? "🔴" : n <= 4 ? "🔴" : n <= 7 ? "🟡" : "🟢";
        var check = n >= NEEDED ? " ✅" : "";
        ch.setName(emoji + " Fila de espera [ " + n + "/" + NEEDED + check + " ]");
      } catch(e) {}
    }

    // ─── Busca de estado ──────────────────────────────────────

    function inQueue(uid) {
      return queue.players.indexOf(uid) !== -1;
    }

    function inActiveMatch(uid) {
      if (queue.status === "veto" || queue.status === "side" ||
          queue.status === "playing" || queue.status === "disputed") {
        return queue.team1.indexOf(uid) !== -1 || queue.team2.indexOf(uid) !== -1;
      }
      return false;
    }

    // ─── INÍCIO DO MIX ────────────────────────────────────────

    function startMatch(playersUids) {
      matchCounter++;
      store.set("matchCounter", matchCounter);
      queue.matchNum = matchCounter;
      var tag = "FILA#" + matchCounter;

      // Remove cargo FILA de todos que estavam na fila
      playersUids.forEach(function(u) { removeFilaGroup(u); });

      // Resolve clientes (apenas online, sem bot)
      var players = [];
      playersUids.forEach(function(u) {
        var c = getClient(u);
        if (c && !c.isSelf()) players.push(c);
      });

      if (players.length < 2) {
        broadcast("⚠️ Jogadores insuficientes online. Mix cancelado.");
        return;
      }

      // Embaralha e divide — pelo menos 1 por time
      var sh   = shuffle(players);
      var half = Math.max(1, Math.floor(sh.length / 2));
      var t1p  = sh.slice(0, half);
      var t2p  = sh.slice(half);
      if (t2p.length === 0) t2p.push(t1p.pop());

      queue.team1    = t1p.map(function(c){ return c.uid(); });
      queue.team2    = t2p.map(function(c){ return c.uid(); });
      queue.cap1     = queue.team1[0];
      queue.cap2     = queue.team2[0];
      queue.maps     = MAPS.slice();
      queue.vetoTurn = "cap1";
      queue.password = randPass();
      queue.status   = "veto";
      queue.adminCalled = false;
      queue.grChId   = null;
      queue.blChId   = null;

      // Cria canal de capitães
      var capChId = createChannel("⚔️ CAPITÃES " + tag);
      queue.capChId = capChId;

      // Anuncia no canal principal
      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🎮  MIX INICIADO  —  " + tag + "\n" +
        "🖥️  Servidor : " + SERVER + "\n" +
        "🔑  Senha    : " + queue.password + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "⚪ Time 1  Cap: " + nameOf(queue.cap1) + " | " + t1p.map(function(c){ return c.name(); }).join(", ") + "\n" +
        "⚪ Time 2  Cap: " + nameOf(queue.cap2) + " | " + t2p.map(function(c){ return c.name(); }).join(", ") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🗺️  Veto de mapas iniciando..."
      );

      // Move só os capitães para o canal de veto
      if (capChId) {
        var c1 = getClient(queue.cap1);
        var c2 = getClient(queue.cap2);
        if (c1) c1.moveTo(capChId);
        if (c2) c2.moveTo(capChId);
      }

      // Inicia veto
      startVeto();
    }

    // ─── VETO ─────────────────────────────────────────────────

    function mapList() {
      return queue.maps.map(function(m, i){ return "  " + (i+1) + ". " + m; }).join("\n");
    }

    function startVeto() {
      if (queue.vetoTimer) { clearTimeout(queue.vetoTimer); queue.vetoTimer = null; }

      var capUid   = queue.vetoTurn === "cap1" ? queue.cap1 : queue.cap2;
      var otherUid = queue.vetoTurn === "cap1" ? queue.cap2 : queue.cap1;
      var tag      = "FILA#" + queue.matchNum;

      var baseMsg =
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🗺️  VETO  —  " + tag + "\n" +
        mapList() + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "⏳ Timeout: 3 minutos";

      toCapCh(baseMsg + "\n👉 " + nameOf(capUid) + " vete um mapa: " + P + "vetar <número>");
      poke(capUid, "👉 Sua vez de vetar em " + tag + "!");

      queue.vetoTimer = setTimeout(function() {
        if (queue.status !== "veto") return;
        var idx = Math.floor(Math.random() * queue.maps.length);
        toCapCh("⏰ " + nameOf(capUid) + " demorou! Bot vetou: " + queue.maps[idx]);
        processVeto(capUid, idx);
      }, VETO_TIMEOUT);
    }

    function processVeto(voterUid, idx) {
      if (queue.vetoTimer) { clearTimeout(queue.vetoTimer); queue.vetoTimer = null; }

      var vetoed   = queue.maps.splice(idx, 1)[0];
      var tag      = "FILA#" + queue.matchNum;
      var otherUid = voterUid === queue.cap1 ? queue.cap2 : queue.cap1;

      toCapCh("❌ " + nameOf(voterUid) + " vetou: [b]" + vetoed + "[/b] | Restam " + queue.maps.length);

      if (queue.maps.length === 1) {
        queue.chosenMap   = queue.maps[0];
        queue.status      = "side";
        queue.sideChooser = voterUid === queue.cap1 ? queue.cap2 : queue.cap1;

        toCapCh(
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "🗺️  MAPA: [b]" + queue.chosenMap + "[/b]\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "👉 " + nameOf(queue.sideChooser) + " escolhe o lado:\n" +
          "   " + P + "lado gr  →  Global Risk\n" +
          "   " + P + "lado tr  →  Terroristas\n" +
          "⏳ Timeout: 3 minutos"
        );
        poke(queue.sideChooser, "👉 Escolha o lado em " + tag + "!");

        queue.vetoTimer = setTimeout(function() {
          if (queue.status !== "side") return;
          var rSide = Math.random() < 0.5 ? "gr" : "tr";
          toCapCh("⏰ " + nameOf(queue.sideChooser) + " demorou! Bot escolheu: " + (rSide === "gr" ? "Global Risk" : "Terroristas"));
          processSide(queue.sideChooser, rSide);
        }, VETO_TIMEOUT);
        return;
      }

      queue.vetoTurn = queue.vetoTurn === "cap1" ? "cap2" : "cap1";
      startVeto();
    }

    // ─── ESCOLHA DE LADO ──────────────────────────────────────

    function processSide(chooserUid, side) {
      if (queue.vetoTimer) { clearTimeout(queue.vetoTimer); queue.vetoTimer = null; }

      var tag           = "FILA#" + queue.matchNum;
      var chooserIsCap1 = chooserUid === queue.cap1;
      var opponentSide  = side === "gr" ? "tr" : "gr";

      var t1Side = chooserIsCap1 ? side : opponentSide;
      var t2Side = chooserIsCap1 ? opponentSide : side;

      if (t1Side === "gr") {
        queue.grTeam = queue.team1; queue.blTeam = queue.team2;
        queue.grCap  = queue.cap1;  queue.blCap  = queue.cap2;
      } else {
        queue.blTeam = queue.team1; queue.grTeam = queue.team2;
        queue.blCap  = queue.cap1;  queue.grCap  = queue.cap2;
      }

      queue.blVote = null; queue.grVote = null;
      queue.status = "playing";

      toCapCh("✅ Lado escolhido! Criando canais, aguarde...");

      // Deleta canal de caps após 5s
      var capChToDelete = queue.capChId;
      queue.capChId = null;
      setTimeout(function() { deleteChannel(capChToDelete); }, 5000);

      // PASSO 1: cria GR
      var grChId = createChannel("🔵 Global Risk " + tag);
      queue.grChId = grChId;

      if (!grChId) {
        broadcast("⚠️ [" + tag + "] Falha ao criar canal GR!");
        return;
      }

      // PASSO 2 (1.5s): move time GR
      setTimeout(function() {
        queue.grTeam.forEach(function(u) {
          var c = getClient(u); if (c) c.moveTo(grChId);
        });

        // PASSO 3 (mais 1.5s): cria BL
        setTimeout(function() {
          var blChId = createChannel("🔴 Black List " + tag);
          queue.blChId = blChId;

          if (!blChId) {
            broadcast("⚠️ [" + tag + "] Falha ao criar canal BL!");
            return;
          }

          // PASSO 4 (mais 1.5s): move time BL
          setTimeout(function() {
            queue.blTeam.forEach(function(u) {
              var c = getClient(u); if (c) c.moveTo(blChId);
            });

            // Bot volta para o canal da fila
            setTimeout(function() {
              var bot = backend.getBotClient();
              if (bot) bot.moveTo(config.filaChannelId);
            }, 500);

            // Anuncia resultado do veto
            broadcast(
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "🏁  PARTIDA  —  " + tag + "\n" +
              "🗺️  Mapa     : " + queue.chosenMap + "\n" +
              "🖥️  Servidor : " + SERVER + "\n" +
              "🔑  Senha    : " + queue.password + "\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "🔵 Global Risk  Cap: " + nameOf(queue.grCap) + "\n" +
              "   " + queue.grTeam.map(nameOf).join(", ") + "\n" +
              "🔴 Black List   Cap: " + nameOf(queue.blCap) + "\n" +
              "   " + queue.blTeam.map(nameOf).join(", ") + "\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "ℹ️  Use " + P + "blwin ou " + P + "grwin para reportar o resultado."
            );

            poke(queue.grCap, "👑 Você é CAP da 🔵 Global Risk em " + tag + "! Use " + P + "grwin para reportar vitória.");
            poke(queue.blCap, "👑 Você é CAP da 🔴 Black List em " + tag + "! Use " + P + "blwin para reportar vitória.");

          }, 1500);
        }, 1500);
      }, 1500);
    }

    // ─── RESULTADO ────────────────────────────────────────────

    function registerVote(voterUid, winner) {
      var isBL = voterUid === queue.blCap;
      if (isBL) queue.blVote = winner; else queue.grVote = winner;

      var tag   = "FILA#" + queue.matchNum;
      broadcast("🗳️  [" + tag + "] Cap da " + (isBL ? "BL" : "GR") + " (" + nameOf(voterUid) + ") votou: " + (winner === "bl" ? "Black List" : "Global Risk") + " venceu!");

      if (queue.blVote !== null && queue.grVote !== null) {
        if (queue.blVote === queue.grVote) {
          finishMatch(queue.blVote, false);
        } else {
          queue.status = "disputed";
          broadcast(
            "⚠️  [" + tag + "] Capitães divergiram!\n" +
            "   Cap BL votou: " + (queue.blVote === "bl" ? "Black List" : "Global Risk") + "\n" +
            "   Cap GR votou: " + (queue.grVote === "bl" ? "Black List" : "Global Risk") + "\n" +
            "🚨 Admin necessário! Use " + P + "mix forçar bl|gr"
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

      // Move todos de volta ao lobby
      queue.team1.concat(queue.team2).forEach(function(u) {
        var c = getClient(u); if (c) c.moveTo(config.lobbyChannelId);
      });

      // Deleta canais após 2s
      var g = queue.grChId, b = queue.blChId;
      setTimeout(function() { deleteChannel(g); deleteChannel(b); }, 2000);

      // Reseta estado
      queue.status   = "open";
      queue.matchNum = null;
      queue.capChId  = null;
      queue.grChId   = null; queue.blChId   = null;
      queue.team1    = []; queue.team2    = [];
      queue.cap1     = null; queue.cap2    = null;
      queue.maps     = []; queue.vetoTurn = null;
      queue.sideChooser = null; queue.chosenMap  = null;
      queue.grTeam   = []; queue.blTeam   = [];
      queue.grCap    = null; queue.blCap    = null;
      queue.blVote   = null; queue.grVote   = null;
      queue.password = null; queue.adminCalled = false;
      updateFilaName();
    }

    // ─── CHAT ─────────────────────────────────────────────────

    event.on("chat", function(ev) {
      var raw    = ev.text.trim();
      var client = ev.client;
      if (client.isSelf()) return;

      var uid   = client.uid();
      var parts = raw.split(/\s+/);
      var cmd   = parts[0].toLowerCase();

      // ══ !x5 — entrar na fila ══════════════════════════════
      if (cmd === P + "x5") {
        // Precisa estar no canal Fila de espera
        if (config.filaChannelId) {
          var cch = client.getChannels()[0];
          if (!cch || cch.id() !== config.filaChannelId) {
            var fch = getChannel(config.filaChannelId);
            client.chat("❌ Vá para o canal [b]" + (fch ? fch.name() : "Fila de espera") + "[/b] e tente novamente!");
            return;
          }
        }
        if (inActiveMatch(uid)) {
          client.chat("🚫 Você está em uma partida ativa! Aguarde terminar.");
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
        addFilaGroup(uid);
        toFila("✅ [" + client.name() + "] entrou na fila! (" + queue.players.length + "/" + NEEDED + ")");
        updateFilaName();

        if (queue.players.length >= NEEDED) {
          toFila("🚀 Fila completa! Iniciando mix...");
          // Salva jogadores e ZERA a fila imediatamente
          var playersSnap = queue.players.slice();
          queue.players = [];
          queue.status  = "starting";
          updateFilaName();
          startMatch(playersSnap);
        }
        return;
      }

      // ══ !sair ═════════════════════════════════════════════
      if (cmd === P + "sair") {
        if (!inQueue(uid)) { client.chat("⚠️ Você não está na fila."); return; }
        queue.players = queue.players.filter(function(u){ return u !== uid; });
        removeFilaGroup(uid);
        toFila("❌ [" + client.name() + "] saiu da fila. (" + queue.players.length + "/" + NEEDED + ")");
        updateFilaName();
        return;
      }

      // ══ !fila ═════════════════════════════════════════════
      if (cmd === P + "fila") {
        var sl = { open:"🟢 Aberta", veto:"🟡 Veto", side:"🟡 Escolha de lado", playing:"🔴 Em jogo", disputed:"🟠 Em disputa", starting:"🔄 Iniciando" };
        var extra = queue.status === "open" ? " (" + queue.players.length + "/" + NEEDED + ")" : queue.matchNum ? " FILA#" + queue.matchNum : "";
        client.chat("📋 Fila: " + (sl[queue.status] || queue.status) + extra + "\nTotal de partidas: " + matchCounter);
        return;
      }

      // ══ !regra ════════════════════════════════════════════
      if (cmd === P + "regra" || cmd === P + "regras") {
        client.chat("📜 REGRAS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" + RULES + "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        return;
      }

      // ══ !vetar <n> ════════════════════════════════════════
      if (cmd === P + "vetar") {
        if (queue.status !== "veto") { client.chat("⚠️ Não há veto ativo."); return; }
        if (uid !== queue.cap1 && uid !== queue.cap2) { client.chat("⚠️ Você não é capitão desta partida."); return; }
        var curCap = queue.vetoTurn === "cap1" ? queue.cap1 : queue.cap2;
        if (uid !== curCap) { client.chat("⚠️ Não é sua vez! Aguarde " + nameOf(curCap) + "."); return; }
        var idx = parseInt(parts[1]) - 1;
        if (isNaN(idx) || idx < 0 || idx >= queue.maps.length) {
          client.chat("❌ Número inválido. Escolha entre 1 e " + queue.maps.length + ":\n" + mapList());
          return;
        }
        processVeto(uid, idx);
        return;
      }

      // ══ !lado gr|tr ═══════════════════════════════════════
      if (cmd === P + "lado") {
        if (queue.status !== "side") { client.chat("⚠️ Não há escolha de lado ativa."); return; }
        if (uid !== queue.sideChooser) { client.chat("⚠️ Não é você que escolhe. É " + nameOf(queue.sideChooser) + "."); return; }
        var side = (parts[1] || "").toLowerCase();
        if (side !== "gr" && side !== "tr") { client.chat("❌ Use: " + P + "lado gr  ou  " + P + "lado tr"); return; }
        processSide(uid, side);
        return;
      }

      // ══ !blwin / !grwin ═══════════════════════════════════
      if (cmd === P + "blwin" || cmd === P + "grwin") {
        if (queue.status !== "playing" && queue.status !== "disputed") {
          client.chat("⚠️ Não há partida ativa."); return;
        }
        if (uid !== queue.blCap && uid !== queue.grCap) {
          client.chat("⚠️ Você não é capitão desta partida."); return;
        }
        if (queue.status === "disputed" && !isAdmin(client)) {
          client.chat("⚠️ Resultado em disputa. Aguarde um administrador."); return;
        }
        registerVote(uid, cmd === P + "blwin" ? "bl" : "gr");
        return;
      }

      // ══ !admin ════════════════════════════════════════════
      if (cmd === P + "admin") {
        if (!inActiveMatch(uid)) { client.chat("⚠️ Você não está em uma partida ativa."); return; }
        if (queue.adminCalled) { client.chat("⏳ Admin já foi chamado. Aguarde."); return; }
        queue.adminCalled = true;
        var tag = "FILA#" + queue.matchNum;
        broadcast("🚨 [" + tag + "] " + client.name() + " chamou um administrador!");
        pokeAdmins(client.name() + " chamou admin em " + tag + ".");
        client.chat("✅ Admins notificados!");
        return;
      }

      // ══ !mix (admin) ══════════════════════════════════════
      if (cmd === P + "mix") {
        var sub = (parts[1] || "").toLowerCase();

        if (sub === "help" || sub === "") {
          client.chat(
            "📖 Mix v9:\n" +
            P + "x5                → Entra na fila\n" +
            P + "sair              → Sai da fila\n" +
            P + "fila              → Status\n" +
            P + "regra             → Regras\n" +
            P + "vetar <n>         → (Cap) Veta mapa\n" +
            P + "lado gr|tr        → (Cap) Escolhe lado\n" +
            P + "blwin / " + P + "grwin → (Cap) Reporta resultado\n" +
            P + "admin             → Chama admin\n" +
            "── Admin ──\n" +
            P + "mix resetar               → Reseta tudo (emergência)\n" +
            P + "mix forçar bl|gr          → Força resultado em disputa\n" +
            P + "mix filateste <n>         → Fila de teste com N jogadores\n" +
            P + "mix admin add <uid>       → Adiciona admin\n" +
            P + "mix admin remove <uid>    → Remove admin\n" +
            P + "mix admin listar          → Lista admins\n" +
            P + "mix update                → Atualiza do GitHub"
          );
          return;
        }

        if (!isAdmin(client)) { client.chat("❌ Permissão negada."); return; }

        // !mix resetar
        if (sub === "resetar") {
          if (queue.vetoTimer) { clearTimeout(queue.vetoTimer); queue.vetoTimer = null; }
          // Remove cargos FILA de quem está na fila de espera
          queue.players.forEach(function(u){ removeFilaGroup(u); });
          // Move todos ao lobby
          var moved = 0;
          queue.team1.concat(queue.team2).forEach(function(u) {
            var c = getClient(u); if (c) { c.moveTo(config.lobbyChannelId); moved++; }
          });
          // Deleta canais
          deleteChannel(queue.capChId);
          deleteChannel(queue.grChId);
          deleteChannel(queue.blChId);
          // Reseta tudo
          queue.status = "open"; queue.players = [];
          queue.matchNum = null; queue.capChId = null;
          queue.grChId = null; queue.blChId = null;
          queue.team1 = []; queue.team2 = [];
          queue.cap1 = null; queue.cap2 = null;
          queue.maps = []; queue.vetoTurn = null;
          queue.sideChooser = null; queue.chosenMap = null;
          queue.grTeam = []; queue.blTeam = [];
          queue.grCap = null; queue.blCap = null;
          queue.blVote = null; queue.grVote = null;
          queue.password = null; queue.adminCalled = false;
          // Bot volta para fila
          var bot = backend.getBotClient();
          if (bot) bot.moveTo(config.filaChannelId);
          updateFilaName();
          broadcast("🔄 [ADMIN] " + client.name() + " resetou tudo! " + moved + " jogador(es) ao lobby.");
          return;
        }

        // !mix forçar bl|gr
        if (sub === "forçar" || sub === "forcar") {
          var winner = (parts[2] || "").toLowerCase();
          if (winner !== "bl" && winner !== "gr") { client.chat("❌ Use: " + P + "mix forçar bl|gr"); return; }
          if (queue.status !== "disputed" && queue.status !== "playing") {
            client.chat("❌ Sem partida ativa para forçar."); return;
          }
          broadcast("⚖️ [ADMIN] " + client.name() + " forçou resultado da FILA#" + queue.matchNum + ".");
          finishMatch(winner, true);
          return;
        }

        // !mix filateste <n>
        if (sub === "filateste") {
          var testSize = Math.max(2, Math.min(10, parseInt(parts[2]) || 2));

          if (queue.status !== "open") {
            client.chat("❌ Fila não está aberta. Use " + P + "mix resetar primeiro."); return;
          }

          // Pega somente quem está no canal da fila
          var filaCh  = getChannel(config.filaChannelId);
          var inFila  = filaCh ? filaCh.getClients().filter(function(c){ return !c.isSelf(); }) : [];

          if (inFila.length < 2) {
            client.chat("❌ Precisa de pelo menos 2 jogadores no canal da fila. Agora: " + inFila.length);
            return;
          }

          // Prioriza: quem chamou → outros admins → resto
          var others   = inFila.filter(function(c){ return c.uid() !== uid; });
          var adms     = others.filter(function(c){ return isAdmin(c); });
          var normals  = others.filter(function(c){ return !isAdmin(c); });
          var callerIn = inFila.some(function(c){ return c.uid() === uid; });
          var ordered  = (callerIn ? [client] : []).concat(adms).concat(normals).slice(0, testSize);

          if (ordered.length < 2) {
            client.chat("❌ Jogadores insuficientes no canal da fila."); return;
          }

          var snap = ordered.map(function(c){ return c.uid(); });
          // Remove cargo FILA dos que estavam esperando
          snap.forEach(function(u){ removeFilaGroup(u); });

          queue.status  = "starting";
          queue.players = [];
          updateFilaName();

          broadcast("🧪 [TESTE] " + client.name() + " iniciou teste com " + ordered.length + " jogador(es): " + ordered.map(function(c){ return c.name(); }).join(", "));

          var oldNeeded = NEEDED;
          NEEDED = ordered.length;
          startMatch(snap);
          NEEDED = oldNeeded;
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
              var an = ac ? ac.name() : target;
              client.chat("✅ " + an + " adicionado como admin!");
              broadcast("🔑 " + client.name() + " adicionou " + an + " como admin.");
              if (ac) ac.poke("✅ Você foi adicionado como admin por " + client.name() + "!");
            } else { client.chat("⚠️ UID já está na lista."); }
            return;
          }
          if (action === "remove") {
            if (!target) { client.chat("❌ " + P + "mix admin remove <uid>"); return; }
            if (removeAdminUid(target)) {
              var ac = getClient(target);
              client.chat("✅ " + (ac ? ac.name() : target) + " removido.");
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
          client.chat("⚠️ Auto-update não suportado.\nRode na VPS:\ncurl -o " + PATH + " " + URL + " && systemctl restart sinusbot");
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
        removeFilaGroup(uid);
        toFila("⚠️ [" + name + "] desconectou e saiu da fila. (" + queue.players.length + "/" + NEEDED + ")");
        updateFilaName();
      }

      if ((queue.status === "veto" || queue.status === "side") &&
          (uid === queue.cap1 || uid === queue.cap2)) {
        broadcast("🚨 Capitão " + name + " desconectou durante veto/lado em FILA#" + queue.matchNum + "!");
        pokeAdmins("Cap " + name + " desconectou em FILA#" + queue.matchNum + ". Use " + P + "mix resetar se necessário.");
      }

      if ((queue.status === "playing" || queue.status === "disputed") &&
          (uid === queue.blCap || uid === queue.grCap)) {
        var role = uid === queue.blCap ? "Black List" : "Global Risk";
        broadcast("🚨 Cap da " + role + " (" + name + ") desconectou em FILA#" + queue.matchNum + "!");
        pokeAdmins("Cap " + name + " (" + role + ") desconectou em FILA#" + queue.matchNum + ".");
      }
    });

    // ─── INIT ─────────────────────────────────────────────────

    updateFilaName();
    engine.log("✅ Mix Shuffle v9 carregado! Prefix=" + P + " | FILA_GID=" + FILA_GID + " | Partidas=" + matchCounter);
  }
);
