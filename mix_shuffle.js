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
    name: "Mix Shuffle - Crossfire v9",
    version: "9.1.0",
    description: "Mix Crossfire — fila única, jogos simultâneos, cargo FILA, canal de capitães, veto e ranking.",
    author: "Feito com Claude",
    vars: [
      { name: "filaChannelId",   title: "Canal 'Fila de espera' (único canal para todas as filas)", type: "channel" },
      { name: "parentChannelId", title: "Canal PAI dos canais de jogo (GR, BL, Capitães) — deve ser o canal FILA ou um canal dentro dele", type: "channel" },
      { name: "lobbyChannelId",  title: "Canal LOBBY — jogadores voltam aqui após a partida", type: "channel" },
      { name: "rankingChannelId", title: "Canal RANKING (somente leitura, bot atualiza lá)", type: "channel" },
      { name: "serverName",      title: "Nome do Servidor de Jogo", type: "string", placeholder: "Operações Especiais" },
      { name: "adminGroupId",    title: "ID do Grupo Admin no TS3 (0 = desativado)", type: "number", placeholder: "0" },
      { name: "filaGroupId",     title: "ID do Grupo 'FILA' no TS3 (aplicado ao entrar na fila, removido ao sair)", type: "number", placeholder: "0" },
      { name: "pugGroupId",      title: "ID do Grupo 'PUG/MIX' no TS3 (comando !registrar)", type: "number", placeholder: "0" },
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
    var bannedUids   = store.get("bannedUids")   || [];
    function saveBanned() { store.set("bannedUids", bannedUids); }
    function banPlayer(uid) {
      if (bannedUids.indexOf(uid) === -1) { bannedUids.push(uid); saveBanned(); return true; }
      return false;
    }
    function unbanPlayer(uid) {
      var i = bannedUids.indexOf(uid);
      if (i !== -1) { bannedUids.splice(i, 1); saveBanned(); return true; }
      return false;
    }
    function isBanned(uid) { return bannedUids.indexOf(uid) !== -1; }


    // ─── Cargo FILA ───────────────────────────────────────────
    var FILA_GID = parseInt(config.filaGroupId) || 0;
    var PUG_GID  = parseInt(config.pugGroupId)  || 0;


    function getDbId(uid) {
      var c = getClient(uid);
      if (!c) return null;
      if (typeof c.databaseID === "function") return c.databaseID();
      if (typeof c.databaseId === "function") return c.databaseId();
      if (typeof c.dbID === "function") return c.dbID();
      if (typeof c.dbId === "function") return c.dbId();
      return null;
    }

    function addFilaGroup(uid) {
      if (!FILA_GID) return;
      try {
        var dbid = getDbId(uid);
        if (!dbid) { engine.log("[Mix] addFilaGroup: dbid nao encontrado para " + uid); return; }
        var ext = backend.extended();
        if (!ext) { engine.log("[Mix] addFilaGroup: backend.extended() nao disponivel"); return; }
        ext.exec("servergroupaddclient", { sgid: String(FILA_GID), cldbid: String(dbid) }, function(err) {
          if (err) engine.log("[Mix] Erro ao adicionar FILA: " + JSON.stringify(err));
          else engine.log("[Mix] Cargo FILA adicionado para dbid=" + dbid);
        });
      } catch(e) {
        engine.log("[Mix] Erro ao adicionar cargo FILA: " + e);
      }
    }

    function removeFilaGroup(uid) {
      if (!FILA_GID) return;
      try {
        var dbid = getDbId(uid);
        if (!dbid) { engine.log("[Mix] removeFilaGroup: dbid nao encontrado para " + uid); return; }
        var ext = backend.extended();
        if (!ext) { engine.log("[Mix] removeFilaGroup: backend.extended() nao disponivel"); return; }
        ext.exec("servergroupdelclient", { sgid: String(FILA_GID), cldbid: String(dbid) }, function(err) {
          if (err) engine.log("[Mix] Erro ao remover FILA: " + JSON.stringify(err));
          else engine.log("[Mix] Cargo FILA removido de dbid=" + dbid);
        });
      } catch(e) {
        engine.log("[Mix] Erro ao remover cargo FILA: " + e);
      }
    }

    function addPugGroup(uid) {
      if (!PUG_GID) return;
      try {
        var dbid = getDbId(uid);
        if (!dbid) return;
        var ext = backend.extended();
        if (!ext) return;
        ext.exec("servergroupaddclient", { sgid: String(PUG_GID), cldbid: String(dbid) }, function(err) {
          if (err) engine.log("[Mix] Erro ao adicionar PUG: " + JSON.stringify(err));
          else engine.log("[Mix] Cargo PUG adicionado para dbid=" + dbid);
        });
      } catch(e) { engine.log("[Mix] Erro addPugGroup: " + e); }
    }

    function removePugGroup(uid) {
      if (!PUG_GID) return;
      try {
        var dbid = getDbId(uid);
        if (!dbid) return;
        var ext = backend.extended();
        if (!ext) return;
        ext.exec("servergroupdelclient", { sgid: String(PUG_GID), cldbid: String(dbid) }, function(err) {
          if (err) engine.log("[Mix] Erro ao remover PUG: " + JSON.stringify(err));
          else engine.log("[Mix] Cargo PUG removido de dbid=" + dbid);
        });
      } catch(e) { engine.log("[Mix] Erro removePugGroup: " + e); }
    }

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

    // ─── Fila única + múltiplos jogos ────────────────────────
    // Um único array de jogadores aguardando.
    // Quando chegar 10, os primeiros 10 são removidos e viram uma partida.
    // Slots de partida são criados dinamicamente (sem limite fixo).

    var queue   = [];   // jogadores esperando: array de UIDs
    var matches = [];   // partidas ativas: array de objetos slot

    function makeMatch(matchNum) {
      return {
        matchNum:    matchNum,
        status:      "veto",   // veto | side | playing | disputed
        capChId:     null,
        grChId:      null,
        blChId:      null,
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

    // Compatibilidade: slots[] aponta para matches[] para não quebrar
    // funções que iteram sobre slots (cancelSlot, desconexão, etc.)
    var slots = matches;

    function slotByMatchNum(num) {
      for (var i = 0; i < matches.length; i++)
        if (matches[i].matchNum === num) return matches[i];
      return null;
    }

    function matchOfPlayer(uid) {
      for (var i = 0; i < matches.length; i++) {
        var s = matches[i];
        if (s.team1.indexOf(uid) !== -1 || s.team2.indexOf(uid) !== -1)
          return s;
      }
      return null;
    }

    // slotOfQueue: verifica se uid está na fila de espera
    function slotOfQueue(uid) {
      return queue.indexOf(uid) !== -1 ? { players: queue, fake: true } : null;
    }

    // slotOfMatch: retorna objeto match se uid estiver em partida
    function slotOfMatch(uid) {
      return matchOfPlayer(uid);
    }

    function isCaptainOf(slot, uid) {
      return uid === slot.cap1 || uid === slot.cap2;
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

    // Envia mensagem para todos no canal da fila
    function toFila(slotOrNull, msg) {
      var ch = getChannel(config.filaChannelId);
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

    // ─── Nome do canal de fila único ─────────────────────────
    // Ajuste CSPACER para bater com o prefixo cspacer do seu canal.
    var CSPACER_FILA = "[cspacer]";

    function updateFilaName() {
      var ch = getChannel(config.filaChannelId);
      if (!ch) return;
      try {
        var n = queue.length;
        var emoji = n === 0 ? "🔴" : n <= 4 ? "🔴" : n <= 7 ? "🟡" : "🟢";
        var check  = n >= NEEDED ? " ✅" : "";
        var suffix = emoji + " Fila de Espera [ " + n + "/" + NEEDED + check + " ]";
        if (matches.length > 0) {
          suffix += " | 🎮 " + matches.length + " partida(s) ativa(s)";
        }

        // Detecta o prefixo cspacer real do canal automaticamente
        // O nome atual pode ser "[cspacer]<qualquer_coisa>" — preservamos tudo antes do emoji
        var currentName = ch.name();
        // Preserva QUALQUER prefixo entre colchetes no início do nome
        var cspacerPrefix = "";
        var cspacerMatch = currentName.match(/^(\[.*?\])/);
        if (cspacerMatch) {
          cspacerPrefix = cspacerMatch[1];
        }

        var newName = cspacerPrefix + suffix;
        if (newName !== currentName) {
          ch.setName(newName);
          engine.log("[Mix] Canal fila atualizado: " + newName);
        }
      } catch(e) {
        engine.log("[Mix] updateFilaName erro: " + e);
      }
    }

    function updateAllFilaNames() { updateFilaName(); }

    // ─── Busca de estado ──────────────────────────────────────

    // slotOfQueue / slotOfMatch / slotByMatchNum / isCaptainOf definidos acima (fila dinâmica)

    // ─── INÍCIO DA PARTIDA ────────────────────────────────────
    // tryStartMatch: drena a fila em blocos de NEEDED, cria um match por bloco

    function tryStartMatch() {
      while (queue.length >= NEEDED) {
        var pickedUids = queue.splice(0, NEEDED);
        // Remove cargo FILA de quem vai jogar
        pickedUids.forEach(function(u) {
          removeFilaGroup(u);
          try { var pc2 = getClient(u); if (pc2) pc2.setDescription(""); } catch(e) {}
        });

        matchCounter++;
        store.set("matchCounter", matchCounter);
        var slot = makeMatch(matchCounter);
        matches.push(slot);

        var tag = "FILA#" + matchCounter;

        // Resolve clientes online
        var players = [];
        for (var pi = 0; pi < pickedUids.length; pi++) {
          var pc = getClient(pickedUids[pi]);
          if (pc && !pc.isSelf()) players.push(pc);
        }

        if (players.length < 2) {
          broadcast("\u26a0\ufe0f [" + tag + "] Jogadores insuficientes online. Cancelando.");
          matches.splice(matches.indexOf(slot), 1);
          updateFilaName();
          continue;
        }

        var sh   = shuffle(players);
        var half = Math.max(1, Math.floor(sh.length / 2));
        var t1p  = sh.slice(0, half);
        var t2p  = sh.slice(half);
        if (t2p.length === 0) t2p.push(t1p.pop());

        slot.team1       = t1p.map(function(c){ return c.uid(); });
        slot.team2       = t2p.map(function(c){ return c.uid(); });
        slot.cap1        = slot.team1[0];
        slot.cap2        = slot.team2[0];
        slot.maps        = MAPS.slice();
        slot.vetoTurn    = "cap1";
        slot.password    = randPass();
        slot.adminCalled = false;

        var capChId = createChannel("\u2694\ufe0f CAPIT\u00c3ES VETANDO " + tag);
        if (!capChId) {
          broadcast("\u26a0\ufe0f [" + tag + "] Erro ao criar canal de capit\u00e3es! Verifique permiss\u00f5es.");
          matches.splice(matches.indexOf(slot), 1);
          pickedUids.forEach(function(u) { queue.push(u); addFilaGroup(u); });
          updateFilaName();
          continue;
        }
        slot.capChId = capChId;

        var cap1c = getClient(slot.cap1);
        var cap2c = getClient(slot.cap2);
        if (cap1c) cap1c.moveTo(capChId);
        if (cap2c) cap2c.moveTo(capChId);

        broadcast(
          "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n" +
          "\ud83c\udfae  MIX INICIADO  \u2014  " + tag + "\n" +
          "\ud83d\udda5\ufe0f  Servidor : " + SERVER + "\n" +
          "\ud83d\udd11  Senha    : " + slot.password + "\n" +
          "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n" +
          "\u26aa Time 1  \u2014  Cap: " + nameOf(slot.cap1) + "\n" +
          "   " + t1p.map(function(c){ return c.name(); }).join(", ") + "\n" +
          "\u26aa Time 2  \u2014  Cap: " + nameOf(slot.cap2) + "\n" +
          "   " + t2p.map(function(c){ return c.name(); }).join(", ") + "\n" +
          "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n" +
          "\u2694\ufe0f  Capit\u00e3es foram movidos para o canal de veto!"
        );

        (function(s) {
          setTimeout(function() { startVeto(s); }, 1500);
        })(slot);
      }
      updateFilaName();
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

      // Avisa no canal dos capitães
      toCapChannel(slot,
        "✅ Lado escolhido! Criando canais dos times...\n" +
        "🔵 Global Risk: " + nameOf(slot.grCap) + "\n" +
        "🔴 Black List: " + nameOf(slot.blCap)
      );

      // Deleta canal de capitães após 4s (tempo para os outros canais serem criados)
      var capChToDelete = slot.capChId;
      slot.capChId = null;
      setTimeout(function() { deleteChannel(capChToDelete); }, 4000);

      // PASSO 1 — Cria canal GR
      var grChId = createChannel("🔵 Global Risk " + tag);
      if (!grChId) {
        broadcast("⚠️ [" + tag + "] Falha ao criar canal Global Risk! Verifique permissões do bot.");
        return;
      }
      slot.grChId = grChId;

      // PASSO 2 — Após 1.5s: move time GR para o canal GR
      setTimeout(function() {
        slot.grTeam.forEach(function(u) {
          var c = getClient(u);
          if (c) c.moveTo(grChId);
        });

        // PASSO 3 — Após mais 1.5s: cria canal BL
        setTimeout(function() {
          var blChId = createChannel("🔴 Black List " + tag);
          if (!blChId) {
            broadcast("⚠️ [" + tag + "] Falha ao criar canal Black List! Verifique permissões do bot.");
            return;
          }
          slot.blChId = blChId;

          // PASSO 4 — Após mais 1.5s: move time BL para o canal BL
          setTimeout(function() {
            slot.blTeam.forEach(function(u) {
              var c = getClient(u);
              if (c) c.moveTo(blChId);
            });

            // Bot volta para o canal da fila de espera
            var botClient = backend.getBotClient();
            if (botClient) botClient.moveTo(config.filaChannelId);

            // PASSO 5 — Anuncia partida, poke nos caps, desbloqueia fila 2
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

            updateFilaName();

          }, 1500); // delay mover BL

        }, 1500); // delay criar BL

      }, 1500); // delay mover GR
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

      // Move todos de volta para o canal lobby
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
      if (slot.vetoTimer) { clearTimeout(slot.vetoTimer); slot.vetoTimer = null; }
      // Remove do array de partidas ativas
      var idx = matches.indexOf(slot);
      if (idx !== -1) matches.splice(idx, 1);
      updateFilaName();
    }

    // ─── Cancelar slot (admin) ────────────────────────────────

    function cancelSlot(slot, adminName) {
      var tag = slot.matchNum ? "FILA#" + slot.matchNum : "partida";
      slot.team1.concat(slot.team2).forEach(function(u) {
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

    function cancelQueue(adminName) {
      // Cancela toda a fila de espera
      queue.forEach(function(u) { removeFilaGroup(u); });
      queue.length = 0;
      broadcast("🚫 [ADMIN] " + adminName + " limpou a fila de espera.");
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

      // ══ !x5 (entrar na fila) ═════════════════════════════════
      if (cmd === P + "x5" || cmd === P + "entrar") {
        if (isBanned(uid)) {
          client.chat("🚫 Você está banido da fila. Entre em contato com um administrador.");
          return;
        }
        if (slotOfMatch(uid)) {
          client.chat("🚫 Você já está em uma partida ativa! Aguarde terminar.");
          return;
        }
        if (queue.indexOf(uid) !== -1) {
          client.chat("⚠️ Você já está na fila. Use " + P + "sair para sair.");
          return;
        }

        // Verifica se está no canal da fila
        if (config.filaChannelId) {
          var cch = client.getChannels ? client.getChannels()[0] : null;
          if (cch && cch.id() !== config.filaChannelId) {
            var fch = getChannel(config.filaChannelId);
            client.chat("❌ Vá para o canal [b]" + (fch ? fch.name() : "Fila de Espera") + "[/b] para entrar na fila!");
            return;
          }
        }

        queue.push(uid);
        addFilaGroup(uid);
        // Adiciona [NA FILA] ao apelido
        try {
          var curName = client.name();
          if (curName.indexOf("[NA FILA]") === -1) {
            client.setDescription("[NA FILA] " + curName);
          }
        } catch(e) {}
        toFila(null, "✅ [" + client.name() + "] entrou! (" + queue.length + "/" + NEEDED + ")");
        updateFilaName();

        if (queue.length >= NEEDED) {
          toFila(null, "🚀 Fila completa! Iniciando mix...");
          tryStartMatch();
        }
        return;
      }

      // ══ !sair ═════════════════════════════════════════════════
      if (cmd === P + "sair") {
        var idx = queue.indexOf(uid);
        if (idx === -1) { client.chat("⚠️ Você não está na fila de espera."); return; }
        queue.splice(idx, 1);
        removeFilaGroup(uid);
        try { client.setDescription(""); } catch(e) {}
        toFila(null, "❌ [" + client.name() + "] saiu da fila. (" + queue.length + "/" + NEEDED + ")");
        updateFilaName();
        return;
      }

      // ══ !fila ═════════════════════════════════════════════════
      if (cmd === P + "fila" || cmd === P + "filas") {
        var statusMap = { veto:"🟡 Veto", side:"🟡 Escolha de lado", playing:"🔴 Em jogo", disputed:"🟠 Disputa" };
        var lines = ["📋 Fila de espera: " + queue.length + "/" + NEEDED + " jogadores"];
        if (queue.length > 0) {
          lines.push("   " + queue.map(nameOf).join(", "));
        }
        lines.push("🎮 Partidas ativas: " + matches.length);
        matches.forEach(function(s) {
          var sl = statusMap[s.status] || s.status;
          lines.push("   FILA#" + s.matchNum + " — " + sl);
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
        var motivo = parts.slice(1).join(" ") || "sem motivo informado";
        var sm4    = slotOfMatch(uid);
        var contexto;

        if (sm4) {
          // Dentro de uma partida — usa adminCalled para evitar spam
          if (sm4.adminCalled) {
            client.chat("⏳ Um admin já foi chamado para esta partida. Aguarde.");
            return;
          }
          sm4.adminCalled = true;
          contexto = "FILA#" + sm4.matchNum;
        } else if (queue.indexOf(uid) !== -1) {
          contexto = "fila de espera";
        } else {
          contexto = "servidor";
        }

        var msg = "🚨 " + client.name() + " chamou admin (" + contexto + "): " + motivo;
        broadcast(msg);
        pokeAdmins(client.name() + " chamou admin em " + contexto + ". Motivo: " + motivo);
        client.chat("✅ Todos os admins foram notificados!");
        return;
      }


      // ══ !uid — lista UIDs de todos no servidor ══════════════
      if (cmd === P + "uid") {
        if (!isAdmin(client)) { client.chat("❌ Permissão negada."); return; }
        var allC = backend.getClients();
        var lines2 = ["📋 UIDs online (" + allC.length + "):"];
        allC.forEach(function(c) {
          if (!c.isSelf()) lines2.push("  " + c.name() + "  →  " + c.uid());
        });
        client.chat(lines2.join("
"));
        return;
      }

      // ══ !registrar ═══════════════════════════════════════════
      if (cmd === P + "registrar") {
        if (!PUG_GID) {
          client.chat("⚠️ Cargo PUG/MIX não configurado. Peça ao admin para configurar o pugGroupId.");
          return;
        }
        // Verifica se já tem o cargo
        var gs = client.getServerGroups();
        var jaTemPug = false;
        for (var gi = 0; gi < gs.length; gi++) {
          if (parseInt(gs[gi].id()) === PUG_GID) { jaTemPug = true; break; }
        }
        if (jaTemPug) {
          client.chat("✅ Você já possui o cargo PUG/MIX!");
          return;
        }
        addPugGroup(uid);
        client.chat("✅ Cargo PUG/MIX atribuído! Agora você receberá notificações de mix.");
        broadcast("🎮 [" + client.name() + "] se registrou para o PUG/MIX!");
        return;
      }

      // ══ !desregistrar ═════════════════════════════════════════
      if (cmd === P + "desregistrar") {
        if (!PUG_GID) {
          client.chat("⚠️ Cargo PUG/MIX não configurado.");
          return;
        }
        removePugGroup(uid);
        client.chat("✅ Cargo PUG/MIX removido. Use " + P + "registrar para voltar.");
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
            P + "x5                   → Entra na fila\n" +
            P + "registrar            → Recebe o cargo PUG/MIX\n" +
            P + "desregistrar         → Remove o cargo PUG/MIX\n" +
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
            P + "mix resetar                  → ⚠️ Reseta TUDO à força (emergência)\n" +
            P + "mix limparfila               → Limpa fila de espera (mantém partidas)\n" +
            P + "mix ban <uid>                → Bane usuário da fila\n" +
            P + "mix unban <uid>              → Remove banimento\n" +
            P + "mix banlist                  → Lista banidos\n" +
            P + "mix uid (ou !uid)            → Lista UIDs de todos online\n" +
            P + "mix filateste <n>            → Fila de teste com N jogadores\n" +
            P + "mix forçar <N> bl|gr         → Força resultado em disputa\n" +
            P + "mix admin add <uid>          → Adiciona admin\n" +
            P + "mix admin remove <uid>       → Remove admin\n" +
            P + 'mix admin listar             → Lista admins\n' +'── Resultados e Ranking ──\n' +P + 'mix vitoria <N> bl|gr        → Corrige vitória de partida ativa\n' +P + 'mix forçar <N> bl|gr         → Força resultado em disputa\n' +P + 'mix vetar <N> <mapa>         → Força veto (cap ausente)\n' +P + 'mix lado <N> gr|bl           → Força escolha de lado (cap ausente)\n' +P + 'mix ranking                  → Ranking com UIDs (admin)\n' +P + 'mix pts <uid> <valor>        → Corrige pontos de jogador\n' +P + 'ranking                      → Ver ranking (todos)\n' +P + 'mix update                   → Instrução de atualização'
          );
          return;
        }

        if (!isAdmin(client)) { client.chat("❌ Permissão negada."); return; }

        // !mix ban <uid> — bane um usuário da fila
        if (sub === "ban") {
          var target = parts[2] || "";
          if (!target) { client.chat("❌ Use: " + P + "mix ban <uid>"); return; }
          if (banPlayer(target)) {
            var bc = getClient(target);
            var bn = bc ? bc.name() : target;
            client.chat("✅ " + bn + " banido da fila!");
            broadcast("🚫 [ADMIN] " + client.name() + " baniu " + bn + " da fila.");
            // Remove da fila se estiver
            var bi = queue.indexOf(target);
            if (bi !== -1) {
              queue.splice(bi, 1);
              removeFilaGroup(target);
              try { var bc2 = getClient(target); if (bc2) bc2.setDescription(""); } catch(e) {}
              updateFilaName();
            }
          } else { client.chat("⚠️ Este usuário já está banido."); }
          return;
        }

        // !mix unban <uid> — remove banimento
        if (sub === "unban") {
          var target2 = parts[2] || "";
          if (!target2) { client.chat("❌ Use: " + P + "mix unban <uid>"); return; }
          if (unbanPlayer(target2)) {
            var bc3 = getClient(target2);
            client.chat("✅ " + (bc3 ? bc3.name() : target2) + " desbanido!");
          } else { client.chat("⚠️ Este usuário não está banido."); }
          return;
        }

        // !mix banlist — lista banidos
        if (sub === "banlist") {
          if (bannedUids.length === 0) { client.chat("📋 Nenhum usuário banido."); return; }
          var blines = ["📋 Banidos (" + bannedUids.length + "):"];
          bannedUids.forEach(function(u, i) {
            var bc4 = getClient(u);
            blines.push("  " + (i+1) + ". " + (bc4 ? bc4.name() : "(offline)") + " — " + u);
          });
          client.chat(blines.join("
"));
          return;
        }

        // !mix limparfila — limpa fila de espera sem cancelar partidas
        if (sub === "limparfila") {
          queue.forEach(function(u) {
            removeFilaGroup(u);
            try { var lc = getClient(u); if (lc) lc.setDescription(""); } catch(e) {}
          });
          var removed = queue.length;
          queue.length = 0;
          updateFilaName();
          broadcast("🧹 [ADMIN] " + client.name() + " limpou a fila de espera. (" + removed + " jogador(es) removidos)");
          client.chat("✅ Fila de espera limpa!");
          return;
        }

        // !mix status
        if (sub === "status") {
          var lines2 = ["📋 [ADMIN] Status — Total: " + matchCounter + " | Fila: " + queue.length + "/" + NEEDED];
          if (queue.length > 0) lines2.push("  Fila: " + queue.map(nameOf).join(", "));
          matches.forEach(function(s) {
            lines2.push("  FILA#" + s.matchNum + " | " + s.status + (s.cap1 ? " | Cap1: " + nameOf(s.cap1) + " Cap2: " + nameOf(s.cap2) : "") + (s.chosenMap ? " | Mapa: " + s.chosenMap : ""));
          });
          if (matches.length === 0) lines2.push("  Nenhuma partida ativa.");
          client.chat(lines2.join("\n"));
          return;
        }

        // !mix cancelar <N> | todos | fila
        if (sub === "cancelar") {
          var arg = (parts[2] || "").toLowerCase();
          if (arg === "todos") {
            var ms = matches.slice();
            ms.forEach(function(s) { cancelSlot(s, client.name()); });
            cancelQueue(client.name());
            client.chat("✅ Todas as partidas e fila canceladas.");
            return;
          }
          if (arg === "fila") {
            cancelQueue(client.name());
            client.chat("✅ Fila de espera limpa.");
            return;
          }
          var num = parseInt(arg);
          if (!isNaN(num) && num > 0) {
            var target = slotByMatchNum(num);
            if (target) { cancelSlot(target, client.name()); client.chat("✅ FILA#" + num + " cancelada."); return; }
            client.chat("❌ Nenhuma partida ativa com número " + num + ".");
            return;
          }
          if (matches.length > 0) {
            cancelSlot(matches[0], client.name());
          } else {
            client.chat("⚠️ Nenhuma partida ativa para cancelar. Use: " + P + "mix cancelar fila");
          }
          return;
        }

        // !mix resetar — reseta TUDO à força (emergência)
        if (sub === "resetar") {
          var totalMoved = 0;
          var totalChannels = 0;

          slots.forEach(function(s) {
            // Remove cargo FILA de todos na fila de espera
            s.players.forEach(function(u){ removeFilaGroup(u); });

            // Move todos os jogadores em partida para o lobby
            s.team1.concat(s.team2).forEach(function(u) {
              var c = getClient(u);
              if (c) { c.moveTo(config.lobbyChannelId); totalMoved++; }
            });

            // Deleta canais criados
            if (s.capChId) { deleteChannel(s.capChId); totalChannels++; }
            if (s.grChId)  { deleteChannel(s.grChId);  totalChannels++; }
            if (s.blChId)  { deleteChannel(s.blChId);  totalChannels++; }

            // Para timers de veto
            if (s.vetoTimer) { clearTimeout(s.vetoTimer); }

            // Reseta o slot completamente
            resetSlot(s);
          });

          // Garante que o bot volta para o canal da fila
          var botCl = backend.getBotClient();
          if (botCl) botCl.moveTo(config.filaChannelId);

          broadcast(
            "🔄 [ADMIN] " + client.name() + " resetou todas as filas!\n" +
            "   " + totalMoved + " jogador(es) movidos ao lobby | " + totalChannels + " canal(is) deletado(s)."
          );
          client.chat("✅ Reset completo! Todas as filas estão limpas e abertas.");
          return;
        }
        if (sub === "filateste") {
          var testSize = Math.max(2, Math.min(10, parseInt(parts[2]) || 2));
          var testSlot = null;
          if (slots[0].status === "open") testSlot = slots[0];
          else if (slot1Unlocked() && slots[1].status === "open") testSlot = slots[1];
          if (!testSlot) {
            client.chat("❌ Nenhuma fila aberta para teste. Use " + P + "mix cancelar primeiro.");
            return;
          }

          // Pega SOMENTE quem está no canal da fila (exceto bot)
          var filaChId = testSlot.slotIndex === 0 ? config.filaChannelId : config.fila2ChannelId;
          var filaCh   = getChannel(filaChId);
          var inFila   = filaCh ? filaCh.getClients().filter(function(c){ return !c.isSelf(); }) : [];

          if (inFila.length < 2) {
            client.chat(
              "❌ Precisa de pelo menos 2 jogadores no canal da fila para o teste.\n" +
              "   Agora no canal: " + inFila.length + " jogador(es)."
            );
            return;
          }

          // Prioriza: quem chamou → outros admins → resto
          var others2  = inFila.filter(function(c){ return c.uid() !== uid; });
          var admins2  = others2.filter(function(c){ return isAdmin(c); });
          var normals2 = others2.filter(function(c){ return !isAdmin(c); });

          // Se quem chamou não está no canal da fila, avisa mas continua sem ele
          var callerInFila = inFila.some(function(c){ return c.uid() === uid; });
          var ordered2;
          if (callerInFila) {
            ordered2 = [client].concat(admins2).concat(normals2);
          } else {
            client.chat("⚠️ Você não está no canal da fila, mas o teste será iniciado com quem está lá.");
            ordered2 = admins2.concat(normals2);
          }
          ordered2 = ordered2.slice(0, testSize);

          if (ordered2.length < 2) {
            client.chat("❌ Jogadores insuficientes no canal da fila (" + ordered2.length + " encontrado(s)).");
            return;
          }

          testSlot.players = ordered2.map(function(c){ return c.uid(); });
          testSlot.status  = "starting";
          broadcast(
            "🧪 [TESTE] " + client.name() + " iniciou teste na Fila " + (testSlot.slotIndex+1) +
            " com " + ordered2.length + " jogador(es): " +
            ordered2.map(function(c){ return c.name(); }).join(", ")
          );
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


        // !mix vetar <N> <num_mapa>  — admin força veto quando capitão se ausentou
        if (sub === "vetar") {
          var fvNum = parseInt(parts[2]);
          var fvMap = parseInt(parts[3]) - 1;
          if (isNaN(fvNum)) {
            client.chat("❌ Use: " + P + "mix vetar <fila> <num_mapa>  |  Ex: " + P + "mix vetar 3 2");
            return;
          }
          var fvSlot = slotByMatchNum(fvNum);
          if (!fvSlot || fvSlot.status !== "veto") {
            client.chat("❌ FILA#" + fvNum + " não está em fase de veto. Use !fila para ver o status.");
            return;
          }
          if (isNaN(fvMap) || fvMap < 0 || fvMap >= fvSlot.maps.length) {
            client.chat("❌ Mapa inválido. Disponíveis em FILA#" + fvNum + ":\n" + mapListText(fvSlot.maps));
            return;
          }
          var currentCapUid = fvSlot.vetoTurn === "cap1" ? fvSlot.cap1 : fvSlot.cap2;
          broadcast("⚖️ [ADMIN] " + client.name() + " forçou veto do mapa " + fvSlot.maps[fvMap] + " em FILA#" + fvNum + " (pelo cap ausente " + nameOf(currentCapUid) + ").");
          processVeto(fvSlot, currentCapUid, fvMap);
          return;
        }

        // !mix lado <N> gr|bl  — admin força escolha de lado quando capitão se ausentou
        if (sub === "lado") {
          var flNum  = parseInt(parts[2]);
          var flSide = (parts[3] || "").toLowerCase();
          if (isNaN(flNum) || (flSide !== "gr" && flSide !== "bl")) {
            client.chat("❌ Use: " + P + "mix lado <fila> gr|bl  |  Ex: " + P + "mix lado 3 gr");
            return;
          }
          var flSlot = slotByMatchNum(flNum);
          if (!flSlot || flSlot.status !== "side") {
            client.chat("❌ FILA#" + flNum + " não está em fase de escolha de lado.");
            return;
          }
          broadcast("⚖️ [ADMIN] " + client.name() + " forçou lado " + (flSide === "gr" ? "🔵 Global Risk" : "🔴 Black List") + " em FILA#" + flNum + " (pelo cap ausente " + nameOf(flSlot.sideChooser) + ").");
          processSide(flSlot, flSlot.sideChooser, flSide);
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

      // Sai da fila de espera se estava aguardando
      var qidx = queue.indexOf(uid);
      if (qidx !== -1) {
        queue.splice(qidx, 1);
        removeFilaGroup(uid);
        toFila(null, "⚠️ [" + name + "] desconectou e saiu da fila. (" + queue.length + "/" + NEEDED + ")");
        updateFilaName();
      }

      // Avisa se capitão desconectou durante veto/lado
      matches.forEach(function(s) {
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

    updateFilaName();
    engine.log("✅ Mix Shuffle v9 carregado! Prefix=" + P + " | !x5 para entrar | Partidas=" + matchCounter);
  }
);
