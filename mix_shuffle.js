/**
 * Mix Shuffle - Crossfire v5.0
 * ─────────────────────────────────────────────────────────────
 * FLUXO COMPLETO:
 *   1. Jogadores entram na fila com !entrar (canal "Fila de espera")
 *   2. Com 10 jogadores: bot embaralha, elege 2 capitães, cria "Time 1" e "Time 2"
 *   3. Veto de mapas: capitães alternam !vetar <número> (timeout 3min)
 *   4. Sobra 1 mapa → quem fez o ÚLTIMO veto = adversário escolhe lado
 *   5. Adversário usa !lado gr ou !lado tr
 *   6. Canais renomeados: "Global Risk" e "Black List"
 *   7. Bot anuncia servidor, senha, mapa e lados
 *   8. Ao fim: capitães usam !grwin ou !blwin
 *
 * MAPAS: Mexico-T, Olho de Aguia-T, Sub-Base-T, Viuva Negra-T, Satelite-T, Ankara-T
 */

registerPlugin(
  {
    name: "Mix Shuffle - Crossfire v5",
    version: "5.1.0",
    description: "Mix Crossfire com veto de mapas, escolha de lado e canais dinâmicos.",
    author: "Feito com Claude",
    vars: [
      {
        name: "filaChannelId",
        title: "Canal 'Fila de espera'",
        type: "channel",
      },
      {
        name: "stopBeforeChannelId",
        title: "Canal limite — canais criados ANTES deste (ex: [cspacer3333])",
        type: "channel",
      },
      {
        name: "lobbyChannelId",
        title: "Canal LOBBY — jogadores voltam aqui após a partida",
        type: "channel",
      },
      {
        name: "serverName",
        title: "Nome do Servidor de Jogo",
        type: "string",
        placeholder: "Operações Especiais",
      },
      {
        name: "adminGroupId",
        title: "ID do Grupo Admin no TS3 (0 = sem restrição por grupo)",
        type: "number",
        placeholder: "0",
      },
      {
        name: "commandPrefix",
        title: "Prefixo dos comandos",
        type: "string",
        placeholder: "!",
      },
      {
        name: "map1",  title: "Mapa 1",  type: "string", placeholder: "Mexico-T"
      },
      {
        name: "map2",  title: "Mapa 2",  type: "string", placeholder: "Olho de Aguia-T"
      },
      {
        name: "map3",  title: "Mapa 3",  type: "string", placeholder: "Sub-Base-T"
      },
      {
        name: "map4",  title: "Mapa 4",  type: "string", placeholder: "Viuva Negra-T"
      },
      {
        name: "map5",  title: "Mapa 5",  type: "string", placeholder: "Satelite-T"
      },
      {
        name: "map6",  title: "Mapa 6",  type: "string", placeholder: "Ankara-T"
      },
      {
        name: "map7",  title: "Mapa 7 (opcional)",  type: "string", placeholder: ""
      },
      {
        name: "map8",  title: "Mapa 8 (opcional)",  type: "string", placeholder: ""
      },
      {
        name: "map9",  title: "Mapa 9 (opcional)",  type: "string", placeholder: ""
      },
      {
        name: "map10", title: "Mapa 10 (opcional)", type: "string", placeholder: ""
      },
      {
        name: "rules",
        title: "Regras do servidor (aparece no !regra)",
        type: "multiline",
        placeholder: "1. Respeite todos os jogadores\n2. Sem cheats\n3. Boa sorte e bom jogo!",
      },
    ],
  },

  function (sinusbot, config) {
    var event   = require("event");
    var backend = require("backend");
    var engine  = require("engine");

    var P         = config.commandPrefix || "!";
    var ADMIN_GID = parseInt(config.adminGroupId) || 0;
    var NEEDED    = 10;
    var SERVER    = config.serverName || "Operações Especiais";
    var VETO_TIMEOUT = 180000; // 3 minutos em ms

    // Mapas: lê do painel, filtra vazios, fallback para lista padrão
    var MAPS_CONFIG = [];
    for (var mi = 1; mi <= 10; mi++) {
      var m = config["map" + mi];
      if (m && m.trim() !== "") MAPS_CONFIG.push(m.trim());
    }
    var MAPS = MAPS_CONFIG.length >= 2 ? MAPS_CONFIG : [
      "Mexico-T", "Olho de Aguia-T", "Sub-Base-T",
      "Viuva Negra-T", "Satelite-T", "Ankara-T",
    ];

    // Regras: lê do painel
    var RULES = config.rules || "Nenhuma regra cadastrada. Configure em Scripts → Mix Shuffle → Regras.";

    // ─── Store e admins ────────────────────────────────────────
    var store      = require("store");
    var adminUids  = store.get("adminUids") || ["B9cKswU86lKLDWUNYs0bXTuIR5U="];
    var matchCounter = store.get("matchCounter") || 0;

    function saveAdmins() { store.set("adminUids", adminUids); }

    function addAdminUid(uid) {
      if (adminUids.indexOf(uid) === -1) { adminUids.push(uid); saveAdmins(); return true; }
      return false;
    }

    function removeAdminUid(uid) {
      var idx = adminUids.indexOf(uid);
      if (idx !== -1) { adminUids.splice(idx, 1); saveAdmins(); return true; }
      return false;
    }

    // ─── Estado das filas ──────────────────────────────────────
    // status: "open" | "veto" | "side" | "playing" | "disputed" | "closed"
    var queues     = {};
    var nextQueueId = 1;

    function makeQueue() {
      var id = nextQueueId++;
      queues[id] = {
        id: id, status: "open", players: [],
        matchNum: null,
        team1ChannelId: null, team2ChannelId: null,
        team1: [], team2: [],           // UIDs
        cap1: null, cap2: null,         // UIDs dos capitães
        // veto
        maps: [],                       // cópia dos mapas disponíveis
        vetoTurn: null,                 // "cap1" | "cap2"
        vetoOrder: [],                  // quem vetou em cada rodada
        vetoTimer: null,
        // lado
        sideChooser: null,              // UID de quem escolhe o lado
        chosenMap: null,
        team1Side: null, team2Side: null, // "gr" | "bl"
        // resultado
        blTeam: [], grTeam: [],
        blCaptain: null, grCaptain: null,
        blVote: null, grVote: null,
        password: null,
        adminCalled: false,
      };
      return queues[id];
    }

    var mainQueue = makeQueue();

    // ─── Utilitários ───────────────────────────────────────────

    function shuffle(arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    }

    function randomPassword() {
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

    function getChannelById(id) {
      var chs = backend.getChannels();
      for (var i = 0; i < chs.length; i++)
        if (chs[i].id() === id) return chs[i];
      return null;
    }

    function getClientByUid(uid) {
      var cs = backend.getClients();
      for (var i = 0; i < cs.length; i++)
        if (cs[i].uid() === uid) return cs[i];
      return null;
    }

    function nameOf(uid) {
      var c = getClientByUid(uid);
      return c ? c.name() : "(desconectado)";
    }

    function broadcast(msg) { backend.chat(msg); }

    function broadcastToChannel(channelId, msg) {
      var ch = getChannelById(channelId);
      if (!ch) return;
      var clients = ch.getClients();
      for (var i = 0; i < clients.length; i++)
        if (!clients[i].isSelf()) clients[i].chat(msg);
    }

    function pokeAdmins(msg) {
      var clients = backend.getClients();
      for (var i = 0; i < clients.length; i++) {
        var c = clients[i];
        if (!c.isSelf() && isAdmin(c)) c.poke("🚨 [ADMIN] " + msg);
      }
    }

    function renameChannel(chId, newName) {
      try {
        var ch = getChannelById(chId);
        if (ch) ch.setName(newName);
      } catch(e) {
        engine.log("[Mix] Erro ao renomear canal: " + e);
      }
    }

    function deleteChannel(chId) {
      if (!chId) return;
      try {
        var ch = getChannelById(chId);
        if (ch) ch.delete();
      } catch(e) {
        engine.log("[Mix] Erro ao deletar canal: " + e);
      }
    }

    function createMatchChannel(name) {
      try {
        var parentId  = config.filaChannelId || "0";
        var orderBefore = config.stopBeforeChannelId || null;
        var props = { name: name, parent: parentId, permanent: false };
        if (orderBefore) {
          var siblings = backend.getChannels().filter(function(c) {
            return c.parent() && c.parent().id() === parentId;
          });
          var stopIdx = -1;
          for (var i = 0; i < siblings.length; i++)
            if (siblings[i].id() === orderBefore) { stopIdx = i; break; }
          props.order = stopIdx > 0 ? siblings[stopIdx - 1].id() : "0";
        }
        var ch = backend.createChannel(props);
        if (ch) return ch.id();
      } catch(e) {
        engine.log("[Mix] Erro ao criar canal: " + e);
      }
      return null;
    }

    // ─── Busca de estado ───────────────────────────────────────

    function findQueueOfPlayer(uid) {
      for (var id in queues) {
        var q = queues[id];
        if (q.status === "open")
          for (var i = 0; i < q.players.length; i++)
            if (q.players[i] === uid) return q;
      }
      return null;
    }

    function isInActiveMatch(uid) {
      for (var id in queues) {
        var q = queues[id];
        if (q.status === "veto" || q.status === "side" || q.status === "playing" || q.status === "disputed") {
          if (q.team1.indexOf(uid) !== -1 || q.team2.indexOf(uid) !== -1) return q;
        }
      }
      return null;
    }

    function findMatchOfCaptain(uid) {
      for (var id in queues) {
        var q = queues[id];
        if (q.status === "playing" || q.status === "disputed")
          if (q.blCaptain === uid || q.grCaptain === uid) return q;
      }
      return null;
    }

    function findActiveMatchOfPlayer(uid) {
      for (var id in queues) {
        var q = queues[id];
        if (q.status === "veto" || q.status === "side" || q.status === "playing" || q.status === "disputed")
          if (q.team1.indexOf(uid) !== -1 || q.team2.indexOf(uid) !== -1) return q;
      }
      return null;
    }

    // ─── Atualiza nome do canal da fila ────────────────────────

    function updateChannelName() {
      var ch = getChannelById(config.filaChannelId);
      if (!ch) return;
      try {
        var count = mainQueue.players.length;
        var newName;
        if (mainQueue.status === "open") {
          if (count === 0)       newName = "Fila de espera [ 0/" + NEEDED + " ]";
          else if (count >= NEEDED) newName = "Fila de espera [ " + count + "/" + NEEDED + " ] ✅";
          else                   newName = "Fila de espera [ " + count + "/" + NEEDED + " ]";
        } else {
          newName = "Fila de espera [ aguardando... ]";
        }
        ch.setName(newName);
      } catch(e) {}
    }

    // ─── INÍCIO DA PARTIDA ─────────────────────────────────────

    function startMatch(q) {
      matchCounter++;
      store.set("matchCounter", matchCounter);
      q.matchNum = matchCounter;
      var tag = "FILA#" + q.matchNum;

      // Cria canais "Time 1" e "Time 2" (serão renomeados após escolha de lado)
      var t1ChId = createMatchChannel("Time 1 — " + tag);
      var t2ChId = createMatchChannel("Time 2 — " + tag);

      if (!t1ChId || !t2ChId) {
        broadcast("⚠️ Não foi possível criar canais. Verifique as permissões do bot.");
        t1ChId = config.lobbyChannelId;
        t2ChId = config.lobbyChannelId;
      }

      q.team1ChannelId = t1ChId;
      q.team2ChannelId = t2ChId;

      // Resolve clientes
      var players = [];
      for (var i = 0; i < q.players.length; i++) {
        var c = getClientByUid(q.players[i]);
        if (c) players.push(c);
      }

      // Embaralha e divide
      var shuffled = shuffle(players);
      var half     = Math.floor(shuffled.length / 2);
      var team1    = shuffled.slice(0, half);
      var team2    = shuffled.slice(half);

      q.team1   = team1.map(function(c){ return c.uid(); });
      q.team2   = team2.map(function(c){ return c.uid(); });
      q.cap1    = team1[0].uid();
      q.cap2    = team2[0].uid();
      q.maps    = MAPS.slice();
      q.vetoTurn = "cap1"; // cap1 começa vetando
      q.vetoOrder = [];
      q.password = randomPassword();
      q.status   = "veto";
      q.players  = [];

      // Move jogadores para os canais temporários
      for (var j = 0; j < team1.length; j++) team1[j].moveTo(t1ChId);
      for (var k = 0; k < team2.length; k++) team2[k].moveTo(t2ChId);

      var t1Names = team1.map(function(c){ return c.name(); });
      var t2Names = team2.map(function(c){ return c.name(); });

      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🎮  MIX INICIADO  —  " + tag + "\n" +
        "🖥️  Servidor : " + SERVER + "\n" +
        "🔑  Senha    : " + q.password + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "⚪ Time 1  —  Cap: " + nameOf(q.cap1) + "\n" +
        "   " + t1Names.join(", ") + "\n" +
        "⚪ Time 2  —  Cap: " + nameOf(q.cap2) + "\n" +
        "   " + t2Names.join(", ") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

      // Inicia veto
      startVetoRound(q);

      // Reabre fila
      mainQueue.status = "open";
      updateChannelName();
      broadcastToChannel(config.filaChannelId, "✅ A fila está aberta! Use " + P + "entrar para o próximo mix.");
    }

    // ─── SISTEMA DE VETO ───────────────────────────────────────

    function buildMapList(maps) {
      var lines = ["🗺️  Mapas disponíveis:"];
      for (var i = 0; i < maps.length; i++)
        lines.push("  " + (i + 1) + ". " + maps[i]);
      return lines.join("\n");
    }

    function startVetoRound(q) {
      var capUid  = q.vetoTurn === "cap1" ? q.cap1 : q.cap2;
      var capName = nameOf(capUid);
      var tag     = "FILA#" + q.matchNum;

      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🗺️  VETO DE MAPAS  —  " + tag + "\n" +
        buildMapList(q.maps) + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "👉 " + capName + " (Cap " + q.vetoTurn + "), vete um mapa: " + P + "vetar <número>\n" +
        "⏳ Timeout: 3 minutos"
      );

      var capClient = getClientByUid(capUid);
      if (capClient) capClient.poke("👉 Sua vez de vetar! Use " + P + "vetar <número> no chat.");

      // Cancela timer anterior se existir
      if (q.vetoTimer) { clearTimeout(q.vetoTimer); q.vetoTimer = null; }

      // Timeout de 3 minutos — veta aleatoriamente
      q.vetoTimer = setTimeout(function() {
        if (q.status !== "veto") return;
        var randomIdx = Math.floor(Math.random() * q.maps.length);
        broadcast("⏰ [" + tag + "] " + capName + " demorou demais! Bot vetou automaticamente: " + q.maps[randomIdx]);
        processVeto(q, capUid, randomIdx);
      }, VETO_TIMEOUT);
    }

    function processVeto(q, voterUid, mapIdx) {
      if (q.vetoTimer) { clearTimeout(q.vetoTimer); q.vetoTimer = null; }

      var vetoed  = q.maps.splice(mapIdx, 1)[0];
      var tag     = "FILA#" + q.matchNum;
      var isCap1  = (voterUid === q.cap1);

      q.vetoOrder.push(voterUid);

      broadcast("❌ [" + tag + "] " + nameOf(voterUid) + " vetou: " + vetoed + " | Restam " + q.maps.length + " mapa(s)");

      // Sobrou 1 mapa?
      if (q.maps.length === 1) {
        q.chosenMap = q.maps[0];
        q.status    = "side";

        // Quem fez o ÚLTIMO veto = adversário escolhe o lado
        var lastVetoerIsCap1 = (voterUid === q.cap1);
        q.sideChooser = lastVetoerIsCap1 ? q.cap2 : q.cap1;

        broadcast(
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "🗺️  MAPA DEFINIDO: " + q.chosenMap + "\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "👉 " + nameOf(q.sideChooser) + " escolhe o lado:\n" +
          "   " + P + "lado gr  →  Global Risk\n" +
          "   " + P + "lado tr  →  Terroristas\n" +
          "⏳ Timeout: 3 minutos"
        );

        var sc = getClientByUid(q.sideChooser);
        if (sc) sc.poke("👉 Você escolhe o lado! Use " + P + "lado gr ou " + P + "lado tr no chat.");

        // Timer para escolha de lado
        q.vetoTimer = setTimeout(function() {
          if (q.status !== "side") return;
          var randomSide = Math.random() < 0.5 ? "gr" : "tr";
          broadcast("⏰ [" + tag + "] " + nameOf(q.sideChooser) + " demorou! Bot escolheu lado aleatório: " + (randomSide === "gr" ? "Global Risk" : "Terroristas"));
          processSideChoice(q, q.sideChooser, randomSide);
        }, VETO_TIMEOUT);

        return;
      }

      // Alterna o turno
      q.vetoTurn = q.vetoTurn === "cap1" ? "cap2" : "cap1";
      startVetoRound(q);
    }

    // ─── ESCOLHA DE LADO ───────────────────────────────────────

    function processSideChoice(q, chooserUid, side) {
      if (q.vetoTimer) { clearTimeout(q.vetoTimer); q.vetoTimer = null; }

      var tag         = "FILA#" + q.matchNum;
      var chooserIsCap1 = (chooserUid === q.cap1);

      // Quem escolheu o lado define seu time
      // O adversário fica com o lado oposto
      var chooserSide  = side;                          // "gr" ou "tr"
      var opponentSide = side === "gr" ? "tr" : "gr";  // lado oposto

      // Define BL = tr, GR = gr (padrão Crossfire)
      // Time do chooser
      if (chooserIsCap1) {
        q.team1Side = chooserSide;
        q.team2Side = opponentSide;
      } else {
        q.team2Side = chooserSide;
        q.team1Side = opponentSide;
      }

      // Define quem é BL e quem é GR baseado nos lados
      if (q.team1Side === "gr") {
        q.grTeam    = q.team1; q.blTeam    = q.team2;
        q.grCaptain = q.cap1;  q.blCaptain = q.cap2;
      } else {
        q.blTeam    = q.team1; q.grTeam    = q.team2;
        q.blCaptain = q.cap1;  q.grCaptain = q.cap2;
      }

      q.status    = "playing";
      q.blVote    = null;
      q.grVote    = null;
      q.adminCalled = false;

      // Renomeia os canais
      if (q.team1Side === "gr") {
        renameChannel(q.team1ChannelId, "Global Risk — " + tag);
        renameChannel(q.team2ChannelId, "Black List — " + tag);
      } else {
        renameChannel(q.team1ChannelId, "Black List — " + tag);
        renameChannel(q.team2ChannelId, "Global Risk — " + tag);
      }

      var sideLabel1 = q.team1Side === "gr" ? "🔴 Global Risk" : "🔵 Black List";
      var sideLabel2 = q.team2Side === "gr" ? "🔴 Global Risk" : "🔵 Black List";

      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🏁  PARTIDA DEFINIDA  —  " + tag + "\n" +
        "🗺️  Mapa     : " + q.chosenMap + "\n" +
        "🖥️  Servidor : " + SERVER + "\n" +
        "🔑  Senha    : " + q.password + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        sideLabel1 + "  —  Cap: " + nameOf(q.cap1) + "\n" +
        "   " + q.team1.map(nameOf).join(", ") + "\n" +
        sideLabel2 + "  —  Cap: " + nameOf(q.cap2) + "\n" +
        "   " + q.team2.map(nameOf).join(", ") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "ℹ️  Ao terminar: " + P + "blwin ou " + P + "grwin\n" +
        "ℹ️  Precisa de admin? " + P + "admin"
      );

      var cap1c = getClientByUid(q.cap1);
      var cap2c = getClientByUid(q.cap2);
      if (cap1c) cap1c.poke("👑 Você é CAPITÃO em " + tag + "! Use " + P + "blwin ou " + P + "grwin para reportar o resultado.");
      if (cap2c) cap2c.poke("👑 Você é CAPITÃO em " + tag + "! Use " + P + "blwin ou " + P + "grwin para reportar o resultado.");
    }

    // ─── VOTAÇÃO DE RESULTADO ──────────────────────────────────

    function registerVote(q, voterUid, winner) {
      var isBL = (q.blCaptain === voterUid);
      if (isBL) q.blVote = winner; else q.grVote = winner;

      var teamLabel   = isBL ? "Black List" : "Global Risk";
      var winnerLabel = winner === "bl" ? "Black List" : "Global Risk";
      var tag         = "FILA#" + q.matchNum;

      broadcast("🗳️  [" + tag + "] Cap da " + teamLabel + " (" + nameOf(voterUid) + ") reportou: " + winnerLabel + " venceu!");

      if (q.blVote !== null && q.grVote !== null) {
        if (q.blVote === q.grVote) {
          finishMatch(q, q.blVote, false);
        } else {
          q.status = "disputed";
          broadcast(
            "⚠️  [" + tag + "] Os capitães divergiram!\n" +
            "   Cap BL: " + (q.blVote === "bl" ? "Black List" : "Global Risk") + "\n" +
            "   Cap GR: " + (q.grVote === "bl" ? "Black List" : "Global Risk") + "\n" +
            "🚨 Admin chamado. Use " + P + "mix forçar <id> bl|gr"
          );
          pokeAdmins("Divergência em " + tag + " (ID " + q.id + ")! Use " + P + "mix forçar " + q.id + " bl|gr");
        }
      }
    }

    function finishMatch(q, winner, forced) {
      var winnerLabel = winner === "bl" ? "🔵 Black List" : "🔴 Global Risk";
      var tag         = "FILA#" + q.matchNum;
      var suffix      = forced ? " (decisão administrativa)" : "";

      if (q.vetoTimer) { clearTimeout(q.vetoTimer); q.vetoTimer = null; }

      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🏆  RESULTADO  —  " + tag + "\n" +
        "   Vencedor: " + winnerLabel + suffix + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

      // Move todos de volta ao lobby
      var allUids = q.team1.concat(q.team2);
      for (var i = 0; i < allUids.length; i++) {
        var c = getClientByUid(allUids[i]);
        if (c) c.moveTo(config.lobbyChannelId);
      }

      // Deleta canais após 1.5s
      setTimeout(function() {
        deleteChannel(q.team1ChannelId);
        deleteChannel(q.team2ChannelId);
      }, 1500);

      // Reseta fila
      q.team1 = []; q.team2 = [];
      q.cap1 = null; q.cap2 = null;
      q.maps = []; q.vetoTurn = null; q.vetoOrder = [];
      q.sideChooser = null; q.chosenMap = null;
      q.team1Side = null; q.team2Side = null;
      q.blTeam = []; q.grTeam = [];
      q.blCaptain = null; q.grCaptain = null;
      q.blVote = null; q.grVote = null;
      q.password = null;
      q.team1ChannelId = null; q.team2ChannelId = null;
      q.matchNum = null; q.adminCalled = false;
      q.status = "open";
      updateChannelName();
    }

    // ─── HANDLERS DE CHAT ──────────────────────────────────────

    event.on("chat", function(ev) {
      var raw    = ev.text.trim();
      var client = ev.client;
      if (client.isSelf()) return;

      var uid   = client.uid();
      var parts = raw.split(/\s+/);
      var cmd   = parts[0].toLowerCase();

      // ══ !entrar ══════════════════════════════════════════════
      if (cmd === P + "entrar") {
        if (config.filaChannelId) {
          var clientCh = client.getChannels()[0];
          if (!clientCh || clientCh.id() !== config.filaChannelId) {
            var filaCh = getChannelById(config.filaChannelId);
            client.chat("❌ Você precisa estar no canal [b]" + (filaCh ? filaCh.name() : "Fila de espera") + "[/b]!");
            return;
          }
        }
        if (isInActiveMatch(uid)) {
          client.chat("🚫 Você está em uma partida ativa! Aguarde ela terminar.");
          return;
        }
        if (findQueueOfPlayer(uid)) {
          client.chat("⚠️ Você já está na fila. Use " + P + "sair para sair.");
          return;
        }
        if (mainQueue.status !== "open") {
          client.chat("❌ A fila não está aberta no momento.");
          return;
        }
        mainQueue.players.push(uid);
        broadcastToChannel(config.filaChannelId, "✅ [" + client.name() + "] entrou na fila! (" + mainQueue.players.length + "/" + NEEDED + ")");
        updateChannelName();

        if (mainQueue.players.length >= NEEDED) {
          broadcastToChannel(config.filaChannelId, "🚀 Fila completa! Iniciando mix...");
          mainQueue.status = "closed";
          startMatch(mainQueue);
        }
        return;
      }

      // ══ !sair ═════════════════════════════════════════════════
      if (cmd === P + "sair") {
        var found = findQueueOfPlayer(uid);
        if (!found) { client.chat("⚠️ Você não está em nenhuma fila de espera."); return; }
        found.players = found.players.filter(function(u){ return u !== uid; });
        broadcastToChannel(config.filaChannelId, "❌ [" + client.name() + "] saiu da fila. (" + found.players.length + "/" + NEEDED + ")");
        updateChannelName();
        return;
      }

      // ══ !filas ════════════════════════════════════════════════
      if (cmd === P + "filas") {
        var statusLabel = { open:"🟢 Aberta", veto:"🟡 Veto de mapas", side:"🟡 Escolha de lado", playing:"🔴 Em jogo", disputed:"🟠 Em disputa", closed:"⚫ Fechada" };
        var lines = ["📋 Status das filas:"];
        for (var id in queues) {
          var q = queues[id];
          var sl = statusLabel[q.status] || q.status;
          var extra = q.status === "open" ? " (" + q.players.length + "/" + NEEDED + ")" : q.matchNum ? " — FILA#" + q.matchNum : "";
          lines.push("  ID " + q.id + " " + sl + extra);
        }
        lines.push("\nTotal de partidas: " + matchCounter);
        client.chat(lines.join("\n"));
        return;
      }

      // ══ !vetar <número> ═══════════════════════════════════════
      if (cmd === P + "vetar") {
        var match = isInActiveMatch(uid);
        if (!match || match.status !== "veto") {
          client.chat("⚠️ Não há veto de mapas ativo para você agora.");
          return;
        }
        var currentCapUid = match.vetoTurn === "cap1" ? match.cap1 : match.cap2;
        if (uid !== currentCapUid) {
          client.chat("⚠️ Não é sua vez de vetar. Aguarde " + nameOf(currentCapUid) + ".");
          return;
        }
        var idx = parseInt(parts[1]) - 1;
        if (isNaN(idx) || idx < 0 || idx >= match.maps.length) {
          client.chat("❌ Número inválido. Escolha entre 1 e " + match.maps.length + ".");
          return;
        }
        processVeto(match, uid, idx);
        return;
      }

      // ══ !lado gr|tr ═══════════════════════════════════════════
      if (cmd === P + "lado") {
        var match = isInActiveMatch(uid);
        if (!match || match.status !== "side") {
          client.chat("⚠️ Não há escolha de lado ativa para você agora.");
          return;
        }
        if (uid !== match.sideChooser) {
          client.chat("⚠️ Não é você que escolhe o lado. É " + nameOf(match.sideChooser) + ".");
          return;
        }
        var side = (parts[1] || "").toLowerCase();
        if (side !== "gr" && side !== "tr") {
          client.chat("❌ Use: " + P + "lado gr  ou  " + P + "lado tr");
          return;
        }
        processSideChoice(match, uid, side);
        return;
      }

      // ══ !blwin / !grwin ═══════════════════════════════════════
      if (cmd === P + "grwin" || cmd === P + "blwin") {
        var winner = cmd === P + "grwin" ? "gr" : "bl";
        var match  = findMatchOfCaptain(uid);
        if (!match) { client.chat("⚠️ Você não é capitão de nenhuma partida ativa."); return; }
        if (match.status === "disputed" && !isAdmin(client)) {
          client.chat("⚠️ Resultado em disputa. Aguarde um administrador.");
          return;
        }
        registerVote(match, uid, winner);
        return;
      }

      // ══ !admin ════════════════════════════════════════════════
      if (cmd === P + "admin") {
        var match = findActiveMatchOfPlayer(uid);
        if (!match) { client.chat("⚠️ Você não está em nenhuma partida ativa."); return; }
        if (match.adminCalled) { client.chat("⏳ Um admin já foi chamado. Aguarde."); return; }
        match.adminCalled = true;
        var tag = "FILA#" + match.matchNum;
        broadcast("🚨 [" + tag + "] " + client.name() + " chamou um administrador!");
        pokeAdmins(client.name() + " chamou admin na " + tag + " (ID " + match.id + ").");
        client.chat("✅ Administradores notificados para a " + tag + ".");
        return;
      }

      // ══ !regra ════════════════════════════════════════════════
      if (cmd === P + "regra" || cmd === P + "regras") {
        client.chat(
          "📜 REGRAS DO SERVIDOR\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          RULES + "\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        );
        return;
      }

      // ══ !mix (admin) ══════════════════════════════════════════
      if (cmd === P + "mix") {
        var sub = (parts[1] || "").toLowerCase();

        if (sub === "help" || sub === "") {
          client.chat(
            "📖 Comandos Mix v5:\n" +
            P + "entrar               → Entra na fila\n" +
            P + "sair                 → Sai da fila\n" +
            P + "filas                → Status das filas\n" +
            P + "regra                → Mostra as regras do servidor\n" +
            P + "vetar <n>            → (Cap) Veta um mapa\n" +
            P + "lado gr|tr           → (Cap) Escolhe lado\n" +
            P + "blwin / " + P + "grwin    → (Cap) Reporta resultado\n" +
            P + "admin                → Chama admin para sua partida\n" +
            "── Admin ──\n" +
            P + "mix listar                  → Lista todas as filas\n" +
            P + "mix reset <id>              → Reseta partida\n" +
            P + "mix forçar <id> bl|gr       → Força resultado em disputa\n" +
            P + "mix admin add <uid>         → Adiciona admin\n" +
            P + "mix admin remove <uid>      → Remove admin\n" +
            P + "mix admin listar            → Lista admins\n" +
            P + "mix update                  → Atualiza script do GitHub"
          );
          return;
        }

        if (!isAdmin(client)) { client.chat("❌ Permissão negada."); return; }

        // !mix listar
        if (sub === "listar") {
          var lines = ["📋 [ADMIN] Filas:"];
          for (var id in queues) {
            var q = queues[id];
            lines.push("[" + q.id + "] " + q.status + (q.matchNum ? " FILA#" + q.matchNum : "") + " jogadores=" + q.players.length);
          }
          lines.push("Total partidas: " + matchCounter);
          client.chat(lines.join("\n"));
          return;
        }

        // !mix reset <id>
        if (sub === "reset") {
          var qid = parseInt(parts[2]);
          if (!queues[qid]) { client.chat("❌ Fila não encontrada."); return; }
          var q = queues[qid];
          if (q.vetoTimer) { clearTimeout(q.vetoTimer); q.vetoTimer = null; }
          var allUids = q.team1.concat(q.team2).concat(q.players);
          var moved = 0;
          for (var i = 0; i < allUids.length; i++) {
            var c = getClientByUid(allUids[i]);
            if (c) { c.moveTo(config.lobbyChannelId); moved++; }
          }
          deleteChannel(q.team1ChannelId);
          deleteChannel(q.team2ChannelId);
          q.team1 = []; q.team2 = []; q.players = [];
          q.cap1 = null; q.cap2 = null;
          q.maps = []; q.vetoTurn = null; q.vetoOrder = [];
          q.sideChooser = null; q.chosenMap = null;
          q.team1Side = null; q.team2Side = null;
          q.blTeam = []; q.grTeam = [];
          q.blCaptain = null; q.grCaptain = null;
          q.blVote = null; q.grVote = null;
          q.password = null; q.team1ChannelId = null; q.team2ChannelId = null;
          q.matchNum = null; q.adminCalled = false; q.status = "open";
          updateChannelName();
          broadcast("🔄 [ADMIN] Fila ID " + qid + " resetada por " + client.name() + ". " + moved + " jogador(es) voltaram ao lobby.");
          return;
        }

        // !mix forçar <id> bl|gr
        if (sub === "forçar" || sub === "forcar") {
          var qid    = parseInt(parts[2]);
          var winner = (parts[3] || "").toLowerCase();
          if (!queues[qid]) { client.chat("❌ Fila não encontrada."); return; }
          if (winner !== "bl" && winner !== "gr") { client.chat("❌ Use: " + P + "mix forçar <id> bl|gr"); return; }
          var q = queues[qid];
          if (q.status !== "disputed" && q.status !== "playing") { client.chat("❌ Sem partida ativa."); return; }
          broadcast("⚖️ [ADMIN] " + client.name() + " forçou resultado da FILA#" + q.matchNum + ".");
          finishMatch(q, winner, true);
          return;
        }

        // !mix admin add/remove/listar
        if (sub === "admin") {
          var action = (parts[2] || "").toLowerCase();
          var target = parts[3] || "";
          if (action === "listar") {
            if (adminUids.length === 0) {
              client.chat("📋 Nenhum admin cadastrado manualmente.");
            } else {
              var lines = ["📋 Admins (" + adminUids.length + "):"];
              for (var i = 0; i < adminUids.length; i++) {
                var ac = getClientByUid(adminUids[i]);
                lines.push("  " + (i+1) + ". " + (ac ? ac.name() : "(offline)") + " — " + adminUids[i]);
              }
              client.chat(lines.join("\n"));
            }
            return;
          }
          if (action === "add") {
            if (!target) { client.chat("❌ " + P + "mix admin add <uid>"); return; }
            if (addAdminUid(target)) {
              var ac = getClientByUid(target);
              var aname = ac ? ac.name() : target;
              client.chat("✅ " + aname + " adicionado como admin!");
              broadcast("🔑 " + client.name() + " adicionou " + aname + " como admin do Mix.");
              if (ac) ac.poke("✅ Você foi adicionado como admin do Mix por " + client.name() + "!");
            } else { client.chat("⚠️ UID já está na lista."); }
            return;
          }
          if (action === "remove") {
            if (!target) { client.chat("❌ " + P + "mix admin remove <uid>"); return; }
            if (removeAdminUid(target)) {
              var ac = getClientByUid(target);
              client.chat("✅ " + (ac ? ac.name() : target) + " removido dos admins.");
            } else { client.chat("⚠️ UID não está na lista."); }
            return;
          }
          client.chat("❌ Uso: " + P + "mix admin add <uid> | remove <uid> | listar");
          return;
        }

        // !mix update
        if (sub === "update") {
          var GITHUB_URL  = "https://raw.githubusercontent.com/JoaoPedro004/mix_cf_ts/main/mix_shuffle.js";
          var SCRIPT_PATH = "/opt/sinusbot/scripts/mix_shuffle.js";

          client.chat("🔄 Baixando atualização do GitHub...");

          try {
            var net = require("net");
            net.request({
              method: "GET",
              url: GITHUB_URL,
            }, function(err, resp) {
              if (err || !resp || !resp.data) {
                client.chat("❌ Erro ao baixar: " + (err || "sem dados"));
                return;
              }
              try {
                var io = require("io");
                io.writeFile(SCRIPT_PATH, resp.data);
                client.chat("✅ Script atualizado! Reiniciando em 3s...");
                broadcast("🔄 [ADMIN] " + client.name() + " atualizou o bot. Reiniciando...");
                setTimeout(function() { engine.restart(); }, 3000);
              } catch(werr) {
                // Se io não funcionar, tenta pelo store e avisa para atualizar manualmente
                client.chat(
                  "⚠️ Não foi possível salvar automaticamente.\n" +
                  "Atualize manualmente na VPS:\n" +
                  "curl -o " + SCRIPT_PATH + " " + GITHUB_URL + " && systemctl restart sinusbot"
                );
              }
            });
          } catch(e) {
            // Fallback: instrui atualização manual
            client.chat(
              "⚠️ Auto-update não suportado nesta versão do SinusBot.\n" +
              "Rode na VPS:\n" +
              "curl -o " + SCRIPT_PATH + " " + GITHUB_URL + " && systemctl restart sinusbot"
            );
          }
          return;
        }

        client.chat("❌ Subcomando inválido. Use " + P + "mix help");
        return;
      }
    });

    // ─── Desconexão ────────────────────────────────────────────

    event.on("clientDisconnect", function(ev) {
      if (!ev.client) return;
      var uid  = ev.client.uid();
      var name = ev.client.name();

      var found = findQueueOfPlayer(uid);
      if (found) {
        found.players = found.players.filter(function(u){ return u !== uid; });
        broadcastToChannel(config.filaChannelId, "⚠️ [" + name + "] desconectou e saiu da fila. (" + found.players.length + "/" + NEEDED + ")");
        updateChannelName();
      }

      for (var id in queues) {
        var q = queues[id];
        if ((q.status === "veto" || q.status === "side") && (uid === q.cap1 || uid === q.cap2)) {
          var tag = "FILA#" + q.matchNum;
          broadcast("🚨 Capitão (" + name + ") desconectou durante o veto na " + tag + "!");
          pokeAdmins("Cap " + name + " desconectou no veto/lado da " + tag + " (ID " + id + ").");
        }
        if ((q.status === "playing" || q.status === "disputed") && (q.blCaptain === uid || q.grCaptain === uid)) {
          var role = q.blCaptain === uid ? "Black List" : "Global Risk";
          var tag  = "FILA#" + q.matchNum;
          broadcast("🚨 Capitão da " + role + " (" + name + ") desconectou na " + tag + "!");
          pokeAdmins("Cap " + name + " (" + role + ") desconectou na " + tag + " (ID " + id + ").");
        }
      }
    });

    // ─── Intervalo de atualização ──────────────────────────────

    updateChannelName();

    engine.log("✅ Mix Shuffle v5 carregado! Prefix=" + P + " | Partidas=" + matchCounter);
  }
);
