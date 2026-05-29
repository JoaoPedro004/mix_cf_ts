/**
 * Mix Shuffle - Crossfire v4.0
 * ─────────────────────────────────────────────────────────────
 * NOVIDADES v4:
 *   - Bot cria canais automaticamente ao iniciar o mix
 *     ex: "BL FILA#1" e "GR FILA#1" como subcanais de um pai configurado
 *   - Canais são deletados automaticamente ao fim da partida
 *   - Jogadores são arrastados para o canal do seu time
 *   - Contador global de partidas (FILA#1, FILA#2, ...)
 *   - !admin → chama um admin para a partida atual do jogador
 *
 * COMANDOS JOGADORES:
 *   !entrar      → entra na fila (precisa estar no canal FILA)
 *   !sair        → sai da fila de espera
 *   !filas       → lista todas as filas
 *   !fila <id>   → detalhes de uma fila
 *   !admin       → chama um admin para sua partida atual
 *
 * COMANDOS CAPITÃO:
 *   !blwin       → reporta vitória da Black List
 *   !grwin       → reporta vitória da Global Risk
 *
 * COMANDOS ADMIN:
 *   !mix listar              → lista todas as filas
 *   !mix reset <id>          → reseta partida e deleta canais
 *   !mix fechar <id>         → fecha fila sem partida
 *   !mix forçar <id> bl|gr   → força resultado em disputa
 *   !mix help                → ajuda
 */

registerPlugin(
  {
    name: "Mix Shuffle - Crossfire v4",
    version: "4.1.0",
    description: "Mix Crossfire com canais dinâmicos, capitães, votação de resultado e chamada de admin.",
    author: "Feito com Claude",
    vars: [
      {
        name: "filaChannelId",
        title: "Canal 'Fila de espera' (jogadores precisam estar aqui para usar !entrar)",
        type: "channel",
      },
      {
        name: "stopBeforeChannelId",
        title: "Canal limite — canais BL/GR serão criados ANTES deste canal (ex: [cspacer3333])",
        type: "channel",
      },
      {
        name: "lobbyChannelId",
        title: "Canal LOBBY — para onde os jogadores voltam após o fim da partida",
        type: "channel",
      },
      {
        name: "serverName",
        title: "Nome do Servidor de Jogo (ex: Operações Especiais)",
        type: "string",
        placeholder: "Operações Especiais",
      },
      {
        name: "adminGroupId",
        title: "ID do Grupo de Servidor Admin no TS3 (usado para verificar admins automaticamente)",
        type: "number",
        placeholder: "0",
      },
      {
        name: "commandPrefix",
        title: "Prefixo dos comandos",
        type: "string",
        placeholder: "!",
      },
    ],
  },

  function (sinusbot, config) {
    var event   = require("event");
    var backend = require("backend");
    var engine  = require("engine");

    var P          = config.commandPrefix || "!";
    var ADMIN_GID  = parseInt(config.adminGroupId) || 0;
    var NEEDED     = 10;
    var SERVER     = config.serverName || "Operações Especiais";

    // ─── Lista dinâmica de admins por UID ──────────────────────
    // Persiste em disco via store do SinusBot
    var store = require("store");
    var adminUids = store.get("adminUids") || ["B9cKswU86lKLDWUNYs0bXTuIR5U="];

    function saveAdmins() {
      store.set("adminUids", adminUids);
    }

    function addAdminUid(uid) {
      if (adminUids.indexOf(uid) === -1) {
        adminUids.push(uid);
        saveAdmins();
        return true;
      }
      return false;
    }

    function removeAdminUid(uid) {
      var idx = adminUids.indexOf(uid);
      if (idx !== -1) {
        adminUids.splice(idx, 1);
        saveAdmins();
        return true;
      }
      return false;
    }

    // Contador global de partidas — nunca volta atrás
    var matchCounter = store.get("matchCounter") || 0;

    // Estado das filas
    // status: "open" | "playing" | "disputed" | "closed"
    var queues = {};
    var nextQueueId = 1;

    // ─── Criação de fila ───────────────────────────────────────

    function makeQueue() {
      var id = nextQueueId++;
      queues[id] = {
        id:         id,
        status:     "open",
        players:    [],   // UIDs aguardando
        matchNum:   null, // número global da partida (ex: 7 → "FILA#7")
        // canais criados dinamicamente:
        blChannelId: null,
        grChannelId: null,
        // times:
        blTeam:      [],
        grTeam:      [],
        blCaptain:   null,
        grCaptain:   null,
        blVote:      null,
        grVote:      null,
        password:    null,
        adminCalled: false, // evita spam de !admin
      };
      return queues[id];
    }

    // Única fila permanente — aberta ao iniciar o bot
    var mainQueue = makeQueue();

    // ─── Utilitários gerais ────────────────────────────────────

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
      // Verifica lista dinâmica de UIDs
      if (adminUids.indexOf(client.uid()) !== -1) return true;
      // Verifica grupo de servidor configurado no painel
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

    function broadcast(msg) {
      backend.chat(msg);
    }

    // Manda mensagem apenas para os clientes dentro de um canal específico
    function broadcastToChannel(channelId, msg) {
      var ch = getChannelById(channelId);
      if (!ch) return;
      var clients = ch.getClients();
      for (var i = 0; i < clients.length; i++) {
        if (!clients[i].isSelf()) {
          clients[i].chat(msg);
        }
      }
    }

    function pokeAdmins(msg) {
      var clients = backend.getClients();
      for (var i = 0; i < clients.length; i++) {
        var c = clients[i];
        if (!c.isSelf() && isAdmin(c))
          c.poke("🚨 [ADMIN] " + msg);
      }
    }

    // ─── Busca de estado ───────────────────────────────────────

    function findQueueOfPlayer(uid) {
      for (var id in queues) {
        var q = queues[id];
        if (q.status === "open") {
          for (var i = 0; i < q.players.length; i++)
            if (q.players[i] === uid) return q;
        }
      }
      return null;
    }

    function isInActiveMatch(uid) {
      for (var id in queues) {
        var q = queues[id];
        if (q.status === "playing" || q.status === "disputed") {
          for (var i = 0; i < q.blTeam.length; i++)
            if (q.blTeam[i] === uid) return q;
          for (var j = 0; j < q.grTeam.length; j++)
            if (q.grTeam[j] === uid) return q;
        }
      }
      return null;
    }

    function findMatchOfCaptain(uid) {
      for (var id in queues) {
        var q = queues[id];
        if (q.status === "playing" || q.status === "disputed") {
          if (q.blCaptain === uid || q.grCaptain === uid) return q;
        }
      }
      return null;
    }

    // Encontra a partida ativa de qualquer membro (para !admin)
    function findActiveMatchOfPlayer(uid) {
      for (var id in queues) {
        var q = queues[id];
        if (q.status === "playing" || q.status === "disputed") {
          for (var i = 0; i < q.blTeam.length; i++)
            if (q.blTeam[i] === uid) return q;
          for (var j = 0; j < q.grTeam.length; j++)
            if (q.grTeam[j] === uid) return q;
        }
      }
      return null;
    }

    // ─── Criação e remoção de canais ───────────────────────────

    /**
     * Cria um subcanal dentro do canal "Fila de espera" (filaChannelId),
     * posicionado ANTES do canal [cspacer3333] (stopBeforeChannelId).
     */
    function createMatchChannel(name) {
      try {
        var parentId = config.filaChannelId || "0";
        var orderBefore = config.stopBeforeChannelId || null;
        var props = {
          name:      name,
          parent:    parentId,
          permanent: false,
        };
        // "order" no TS3 define após qual canal este fica.
        // Para ficar ANTES do spacer, precisamos do canal imediatamente anterior a ele.
        // Buscamos o canal que vem antes do stopBeforeChannel na lista de subcanais.
        if (orderBefore) {
          var siblings = backend.getChannels().filter(function(c) {
            return c.parent() && c.parent().id() === parentId;
          });
          var stopIdx = -1;
          for (var i = 0; i < siblings.length; i++) {
            if (siblings[i].id() === orderBefore) { stopIdx = i; break; }
          }
          // Insere antes do spacer: order = canal anterior ao spacer (ou 0 se for o primeiro)
          props.order = stopIdx > 0 ? siblings[stopIdx - 1].id() : "0";
        }
        var ch = backend.createChannel(props);
        if (ch) {
          engine.log("[Mix] Canal criado: " + name + " (id=" + ch.id() + " parent=" + parentId + ")");
          return ch.id();
        }
      } catch (e) {
        engine.log("[Mix] Erro ao criar canal '" + name + "': " + e);
      }
      return null;
    }

    function deleteChannel(chId) {
      if (!chId) return;
      try {
        var ch = getChannelById(chId);
        if (ch) {
          ch.delete();
          engine.log("[Mix] Canal deletado: id=" + chId);
        }
      } catch (e) {
        engine.log("[Mix] Erro ao deletar canal id=" + chId + ": " + e);
      }
    }

    // ─── Início da partida ─────────────────────────────────────

    function startMatch(q) {
      // Incrementa contador global e persiste
      matchCounter++;
      store.set("matchCounter", matchCounter);
      q.matchNum = matchCounter;

      var tag = "FILA#" + q.matchNum;

      // Cria os canais dinamicamente
      var blChId = createMatchChannel("BL " + tag);
      var grChId = createMatchChannel("GR " + tag);

      if (!blChId || !grChId) {
        // Fallback: se não conseguiu criar, usa canal lobby
        broadcast("⚠️ Não foi possível criar canais para a partida. Verifique as permissões do bot. Os jogadores não serão movidos automaticamente.");
        blChId = config.lobbyChannelId;
        grChId = config.lobbyChannelId;
      }

      q.blChannelId = blChId;
      q.grChannelId = grChId;

      // Resolve objetos de client
      var players = [];
      for (var i = 0; i < q.players.length; i++) {
        var c = getClientByUid(q.players[i]);
        if (c) players.push(c);
      }

      // Embaralha e divide
      var shuffled = shuffle(players);
      var half     = Math.floor(shuffled.length / 2);
      var blTeam   = shuffled.slice(0, half);
      var grTeam   = shuffled.slice(half);

      var blCap = blTeam[0];
      var grCap = grTeam[0];

      q.blTeam    = blTeam.map(function(c){ return c.uid(); });
      q.grTeam    = grTeam.map(function(c){ return c.uid(); });
      q.blCaptain = blCap.uid();
      q.grCaptain = grCap.uid();
      q.blVote    = null;
      q.grVote    = null;
      q.password  = randomPassword();
      q.status    = "playing";
      q.adminCalled = false;
      q.players   = [];

      // Arrasta jogadores para os canais criados
      for (var j = 0; j < blTeam.length; j++) blTeam[j].moveTo(blChId);
      for (var k = 0; k < grTeam.length; k++) grTeam[k].moveTo(grChId);

      var blNames = blTeam.map(function(c){ return c.name(); });
      var grNames = grTeam.map(function(c){ return c.name(); });

      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🎮  MIX INICIADO  —  " + tag + "\n" +
        "🖥️  Servidor : " + SERVER + "\n" +
        "🔑  Senha    : " + q.password + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🔵 Black List  (BL " + tag + ")  —  Cap: " + blCap.name() + "\n" +
        "   " + blNames.join(", ") + "\n" +
        "🔴 Global Risk (GR " + tag + ")  —  Cap: " + grCap.name() + "\n" +
        "   " + grNames.join(", ") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "ℹ️  Capitão: use  " + P + "blwin  ou  " + P + "grwin  para reportar o resultado.\n" +
        "ℹ️  Precisa de admin? Use  " + P + "admin"
      );

      // Poke nos capitães
      blCap.poke("👑 Você é CAPITÃO da Black List em " + tag + "! Use " + P + "blwin ou " + P + "grwin para reportar o resultado.");
      grCap.poke("👑 Você é CAPITÃO da Global Risk em " + tag + "! Use " + P + "blwin ou " + P + "grwin para reportar o resultado.");

      // Reabre a fila principal para o próximo mix
      mainQueue.status = "open";
      updateChannelName();
      broadcastToChannel(config.filaChannelId, "✅ A fila está aberta novamente! Use " + P + "entrar para o próximo mix.");
    }

    // ─── Votação de resultado ──────────────────────────────────

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
            "⚠️  [" + tag + "] Os capitães divergiram no resultado!\n" +
            "   Cap BL votou: " + (q.blVote === "bl" ? "Black List" : "Global Risk") + "\n" +
            "   Cap GR votou: " + (q.grVote === "bl" ? "Black List" : "Global Risk") + "\n" +
            "🚨 Um admin foi chamado. Use  " + P + "mix forçar <id> bl|gr  para resolver."
          );
          pokeAdmins("Divergência em " + tag + " (fila ID " + q.id + ")! Use " + P + "mix forçar " + q.id + " bl|gr");
        }
      }
    }

    function finishMatch(q, winner, forced) {
      var winnerLabel = winner === "bl" ? "🔵 Black List" : "🔴 Global Risk";
      var tag         = "FILA#" + q.matchNum;
      var suffix      = forced ? " (decisão administrativa)" : "";

      broadcast(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🏆  RESULTADO  —  " + tag + "\n" +
        "   Vencedor: " + winnerLabel + suffix + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );

      // Move todos de volta ao lobby
      var allUids = q.blTeam.concat(q.grTeam);
      for (var i = 0; i < allUids.length; i++) {
        var c = getClientByUid(allUids[i]);
        if (c) c.moveTo(config.lobbyChannelId);
      }

      // Aguarda um segundo para mover antes de deletar os canais
      setTimeout(function() {
        deleteChannel(q.blChannelId);
        deleteChannel(q.grChannelId);
      }, 1500);

      // Limpa estado da fila (mantém aberta)
      q.blTeam     = []; q.grTeam    = [];
      q.blCaptain  = null; q.grCaptain = null;
      q.blVote     = null; q.grVote    = null;
      q.password   = null;
      q.blChannelId = null; q.grChannelId = null;
      q.matchNum   = null;
      q.adminCalled = false;
      q.status     = "open";
      updateChannelName();
    }

    // ─── Handlers de chat ──────────────────────────────────────

    event.on("chat", function (ev) {
      var raw    = ev.text.trim();
      var client = ev.client;
      if (client.isSelf()) return;

      var uid   = client.uid();
      var parts = raw.split(/\s+/);
      var cmd   = parts[0].toLowerCase();

      // ══ !entrar ══════════════════════════════════════════════
      if (cmd === P + "entrar") {

        // 1. Precisa estar no canal FILA
        if (config.filaChannelId) {
          var clientCh = client.getChannels()[0];
          if (!clientCh || clientCh.id() !== config.filaChannelId) {
            var filaCh = getChannelById(config.filaChannelId);
            client.chat(
              "❌ Você precisa estar no canal [b]" + (filaCh ? filaCh.name() : "FILA") + "[/b] para entrar na fila!\n" +
              "➡️ Entre no canal correto e tente novamente."
            );
            return;
          }
        }

        // 2. Já está em partida ativa?
        var active = isInActiveMatch(uid);
        if (active) {
          client.chat(
            "🚫 Você está em uma partida em andamento (FILA#" + active.matchNum + ")!\n" +
            "Aguarde a partida ser finalizada antes de entrar em uma nova fila."
          );
          return;
        }

        // 3. Já está na fila de espera?
        if (findQueueOfPlayer(uid)) {
          client.chat("⚠️ Você já está na fila. Use " + P + "sair para sair.");
          return;
        }

        // 4. A fila está aberta?
        if (mainQueue.status !== "open") {
          client.chat("❌ A fila não está aberta no momento. Tente novamente em instantes.");
          return;
        }

        mainQueue.players.push(uid);
        broadcastToChannel(config.filaChannelId, "✅ [" + client.name() + "] entrou na fila! (" + mainQueue.players.length + "/" + NEEDED + ")");
        updateChannelName();

        if (mainQueue.players.length >= NEEDED) {
          broadcastToChannel(config.filaChannelId, "🚀 Fila completa! Iniciando mix...");
          // Fecha a fila para novas entradas enquanto o mix está sendo montado
          mainQueue.status = "closed";
          startMatch(mainQueue);
        }
        return;
      }

      // ══ !sair ═════════════════════════════════════════════════
      if (cmd === P + "sair") {
        var found = findQueueOfPlayer(uid);
        if (!found) {
          client.chat("⚠️ Você não está em nenhuma fila de espera.");
          return;
        }
        found.players = found.players.filter(function(u){ return u !== uid; });
        broadcastToChannel(config.filaChannelId, "❌ [" + client.name() + "] saiu da fila. (" + found.players.length + "/" + NEEDED + ")");
        updateChannelName();
        return;
      }

      // ══ !filas ════════════════════════════════════════════════
      if (cmd === P + "filas") {
        var statusLabel = {
          open:     "🟢 Aberta",
          playing:  "🔴 Em jogo",
          disputed: "🟠 Em disputa",
          closed:   "⚫ Fechada",
        };
        var lines = ["📋 Status das filas:"];
        for (var id in queues) {
          var q = queues[id];
          var sl = statusLabel[q.status] || q.status;
          var extra = q.status === "open"
            ? " (" + q.players.length + "/" + NEEDED + ")"
            : q.matchNum ? " — FILA#" + q.matchNum : "";
          lines.push("  ID " + q.id + " " + sl + extra);
        }
        lines.push("\nPartidas realizadas até agora: " + matchCounter);
        client.chat(lines.join("\n"));
        return;
      }

      // ══ !fila <id> ════════════════════════════════════════════
      if (cmd === P + "fila") {
        var qid = parseInt(parts[1]);
        if (!qid || !queues[qid]) { client.chat("❌ ID inválido."); return; }
        var q = queues[qid];
        if (q.status === "open") {
          var ns = q.players.map(function(u, i){ return (i+1)+". "+nameOf(u); });
          client.chat("📋 Fila ID " + qid + " (" + q.players.length + "/" + NEEDED + "):\n" + (ns.length ? ns.join("\n") : "  Ninguém ainda."));
        } else if (q.status === "playing" || q.status === "disputed") {
          client.chat(
            "🎮 FILA#" + q.matchNum + " — Em andamento\n" +
            "🔵 BL: " + q.blTeam.map(nameOf).join(", ") + "  (Cap: " + nameOf(q.blCaptain) + ")\n" +
            "🔴 GR: " + q.grTeam.map(nameOf).join(", ") + "  (Cap: " + nameOf(q.grCaptain) + ")" +
            (q.status === "disputed" ? "\n⚠️ Resultado em disputa — aguardando admin." : "")
          );
        }
        return;
      }

      // ══ !blwin / !grwin ═══════════════════════════════════════
      if (cmd === P + "grwin" || cmd === P + "blwin") {
        var winner = cmd === P + "grwin" ? "gr" : "bl";
        var match  = findMatchOfCaptain(uid);
        if (!match) {
          client.chat("⚠️ Você não é capitão de nenhuma partida ativa.");
          return;
        }
        if (match.status === "disputed" && !isAdmin(client)) {
          client.chat("⚠️ Resultado em disputa. Aguarde a decisão de um administrador.");
          return;
        }
        registerVote(match, uid, winner);
        return;
      }

      // ══ !admin ════════════════════════════════════════════════
      if (cmd === P + "admin") {
        var match = findActiveMatchOfPlayer(uid);
        if (!match) {
          client.chat("⚠️ Você não está em nenhuma partida ativa no momento.");
          return;
        }
        if (match.adminCalled) {
          client.chat("⏳ Um admin já foi chamado para esta partida. Aguarde.");
          return;
        }
        match.adminCalled = true;
        var tag = "FILA#" + match.matchNum;
        broadcast("🚨 [" + tag + "] " + client.name() + " chamou um administrador para esta partida!");
        pokeAdmins(client.name() + " chamou um admin na " + tag + " (fila ID " + match.id + "). Verifique o que está acontecendo.");
        client.chat("✅ Os administradores foram notificados para a " + tag + ".");
        return;
      }

      // ══ !mix (admin) ══════════════════════════════════════════
      if (cmd === P + "mix") {
        var sub = (parts[1] || "").toLowerCase();

        if (sub === "help" || sub === "") {
          client.chat(
            "📖 Comandos Mix v4:\n" +
            P + "entrar               → Entra na fila (precisa estar em 'Fila de espera')\n" +
            P + "sair                 → Sai da fila de espera\n" +
            P + "filas                → Lista filas e partidas\n" +
            P + "fila <id>            → Detalhe de uma fila/partida\n" +
            P + "blwin / " + P + "grwin    → (Cap) Reporta resultado\n" +
            P + "admin                → Chama um admin para sua partida\n" +
            "── Admin ──\n" +
            P + "mix listar                  → Lista todas as filas\n" +
            P + "mix reset <id>              → Reseta partida e deleta canais\n" +
            P + "mix fechar <id>             → Fecha fila sem partida ativa\n" +
            P + "mix forçar <id> bl|gr       → Força resultado em disputa\n" +
            P + "mix update                  → Baixa versão mais recente do GitHub e reinicia\n" +
            P + "mix admin add <uid>         → Adiciona admin pela UID do TS3\n" +
            P + "mix admin remove <uid>      → Remove admin pela UID do TS3\n" +
            P + "mix admin listar            → Lista todos os admins cadastrados"
          );
          return;
        }

        if (!isAdmin(client)) { client.chat("❌ Permissão negada."); return; }

        // !mix admin add/remove/listar
        if (sub === "admin") {
          var action = (parts[2] || "").toLowerCase();
          var target = parts[3] || "";

          if (action === "listar") {
            if (adminUids.length === 0) {
              client.chat("📋 Nenhum admin cadastrado manualmente.\n(Admins pelo grupo TS3 ID=" + ADMIN_GID + " ainda funcionam)");
            } else {
              var lines = ["📋 Admins cadastrados (" + adminUids.length + "):"];
              for (var i = 0; i < adminUids.length; i++) {
                var ac = getClientByUid(adminUids[i]);
                lines.push("  " + (i+1) + ". " + (ac ? ac.name() : "(offline)") + " — UID: " + adminUids[i]);
              }
              client.chat(lines.join("\n"));
            }
            return;
          }

          if (action === "add") {
            if (!target) { client.chat("❌ Informe a UID: " + P + "mix admin add <uid>"); return; }
            if (addAdminUid(target)) {
              var ac = getClientByUid(target);
              var aname = ac ? ac.name() : target;
              client.chat("✅ " + aname + " adicionado como admin!");
              broadcast("🔑 [" + client.name() + "] adicionou " + aname + " como administrador do Mix.");
              if (ac) ac.poke("✅ Você foi adicionado como administrador do Mix por " + client.name() + "!");
            } else {
              client.chat("⚠️ Essa UID já está na lista de admins.");
            }
            return;
          }

          if (action === "remove") {
            if (!target) { client.chat("❌ Informe a UID: " + P + "mix admin remove <uid>"); return; }
            if (removeAdminUid(target)) {
              var ac = getClientByUid(target);
              var aname = ac ? ac.name() : target;
              client.chat("✅ " + aname + " removido dos admins.");
              broadcast("🔑 [" + client.name() + "] removeu " + aname + " dos administradores do Mix.");
            } else {
              client.chat("⚠️ Essa UID não está na lista de admins.");
            }
            return;
          }

          client.chat("❌ Uso: " + P + "mix admin add <uid> | remove <uid> | listar");
          return;
        }

        // !mix listar
        if (sub === "listar") {
          var lines = ["📋 [ADMIN] Todas as filas:"];
          for (var id in queues) {
            var q = queues[id];
            lines.push(
              "[" + q.id + "] status=" + q.status +
              (q.matchNum ? " | partida=FILA#" + q.matchNum : "") +
              " | jogadores=" + q.players.length +
              (q.blChannelId ? " | blCh=" + q.blChannelId : "") +
              (q.grChannelId ? " | grCh=" + q.grChannelId : "")
            );
          }
          lines.push("Total de partidas realizadas: " + matchCounter);
          client.chat(lines.join("\n"));
          return;
        }

        // !mix reset <id>
        if (sub === "reset") {
          var qid = parseInt(parts[2]);
          if (!queues[qid]) { client.chat("❌ Fila não encontrada."); return; }
          var q = queues[qid];
          // Move jogadores de volta ao lobby
          var allUids = q.blTeam.concat(q.grTeam).concat(q.players);
          var moved = 0;
          for (var i = 0; i < allUids.length; i++) {
            var c = getClientByUid(allUids[i]);
            if (c) { c.moveTo(config.lobbyChannelId); moved++; }
          }
          // Deleta canais criados
          deleteChannel(q.blChannelId);
          deleteChannel(q.grChannelId);
          // Reseta estado
          q.blTeam = []; q.grTeam = []; q.players = [];
          q.blCaptain = null; q.grCaptain = null;
          q.blVote = null; q.grVote = null;
          q.blChannelId = null; q.grChannelId = null;
          q.password = null; q.matchNum = null;
          q.adminCalled = false;
          q.status = "open";
          broadcast("🔄 [ADMIN] Fila ID " + qid + " resetada por " + client.name() + ". " + moved + " jogador(es) voltaram ao lobby. Canais deletados.");
          return;
        }

        // !mix fechar <id>
        if (sub === "fechar") {
          var qid = parseInt(parts[2]);
          if (!queues[qid]) { client.chat("❌ Fila não encontrada."); return; }
          if (queues[qid].status === "playing" || queues[qid].status === "disputed") {
            client.chat("⚠️ Há uma partida em andamento nessa fila. Use " + P + "mix reset " + qid + " para cancelá-la.");
            return;
          }
          queues[qid].status = "closed";
          broadcast("⚫ Fila ID " + qid + " fechada por " + client.name() + ".");
          return;
        }

        // !mix forçar <id> bl|gr
        if (sub === "forçar" || sub === "forcar") {
          var qid    = parseInt(parts[2]);
          var winner = (parts[3] || "").toLowerCase();
          if (!queues[qid]) { client.chat("❌ Fila não encontrada."); return; }
          if (winner !== "bl" && winner !== "gr") { client.chat("❌ Use: " + P + "mix forçar <id> bl|gr"); return; }
          var q = queues[qid];
          if (q.status !== "disputed" && q.status !== "playing") {
            client.chat("❌ Essa fila não tem partida ativa.");
            return;
          }
          broadcast("⚖️ [ADMIN] " + client.name() + " forçou o resultado da FILA#" + q.matchNum + ".");
          finishMatch(q, winner, true);
          return;
        }

        // !mix update
        if (sub === "update") {
          var GITHUB_URL = "https://raw.githubusercontent.com/JoaoPedro004/mix_cf_ts/main/mix_shuffle.js";
          var SCRIPT_PATH = "/opt/sinusbot/scripts/mix_shuffle.js";
          var http = require("http");

          client.chat("🔄 Baixando atualização do GitHub...");

          http.simpleGet(GITHUB_URL, function(err, data) {
            if (err || !data) {
              client.chat("❌ Erro ao baixar atualização: " + (err || "sem resposta"));
              return;
            }
            try {
              var fs = require("fs");
              fs.writeFile(SCRIPT_PATH, data, function(werr) {
                if (werr) {
                  client.chat("❌ Erro ao salvar o arquivo: " + werr);
                  return;
                }
                client.chat("✅ Script atualizado! Reiniciando em 3 segundos...");
                broadcast("🔄 [ADMIN] " + client.name() + " atualizou o bot. Reiniciando...");
                setTimeout(function() {
                  engine.restart();
                }, 3000);
              });
            } catch(e) {
              client.chat("❌ Erro: " + e);
            }
          });
          return;
        }

        client.chat("❌ Subcomando inválido. Use " + P + "mix help");
        return;
      }
    });

    // ─── Desconexão ────────────────────────────────────────────

    event.on("clientDisconnect", function (ev) {
      if (!ev.client) return;
      var uid  = ev.client.uid();
      var name = ev.client.name();

      // Remove da fila de espera
      var found = findQueueOfPlayer(uid);
      if (found) {
        found.players = found.players.filter(function(u){ return u !== uid; });
        broadcastToChannel(config.filaChannelId, "⚠️ [" + name + "] desconectou e saiu da fila. (" + found.players.length + "/" + NEEDED + ")");
        updateChannelName();
      }

      // Avisa se era capitão de partida ativa
      for (var id in queues) {
        var q = queues[id];
        if ((q.status === "playing" || q.status === "disputed") &&
            (q.blCaptain === uid || q.grCaptain === uid)) {
          var role = q.blCaptain === uid ? "Black List" : "Global Risk";
          var tag  = "FILA#" + q.matchNum;
          broadcast("🚨 Capitão da " + role + " (" + name + ") desconectou na " + tag + "!");
          pokeAdmins("Capitão " + name + " (" + role + ") desconectou na " + tag + " (ID " + id + ").");
        }
      }
    });

    engine.log("✅ Mix Shuffle v4 carregado! Prefix=" + P + " | Partidas realizadas=" + matchCounter);

    // ─── Atualiza nome do canal com contagem da fila ───────────
    function updateChannelName() {
      var ch = getChannelById(config.filaChannelId);
      if (!ch) return;
      try {
        var count = mainQueue.players.length;
        var newName;
        if (mainQueue.status === "open") {
          if (count === 0) {
            newName = "Fila de espera [ 0/" + NEEDED + " ]";
          } else if (count >= NEEDED) {
            newName = "Fila de espera [ " + count + "/" + NEEDED + " ] ✅";
          } else {
            newName = "Fila de espera [ " + count + "/" + NEEDED + " ]";
          }
        } else {
          newName = "Fila de espera [ aguardando... ]";
        }
        ch.setName(newName);
      } catch (e) {
        engine.log("[Mix] Erro ao renomear canal: " + e);
      }
    }

    // Atualiza imediatamente ao carregar
    updateChannelName();

    // ─── Aviso automático de fila a cada 30 segundos ───────────
    setInterval(function () {
      // Atualiza o nome do canal sempre
      updateChannelName();

      // Só manda mensagem no canal da fila se tiver alguém lá
      if (mainQueue.status !== "open") return;
      if (mainQueue.players.length === 0) return;

      var names = mainQueue.players.map(function (u) {
        return nameOf(u);
      });

      broadcastToChannel(
        config.filaChannelId,
        "📋 Fila atual: " + mainQueue.players.length + "/" + NEEDED + " jogadores\n" +
        "   " + names.join(", ") + "\n" +
        "ℹ️  Use " + P + "entrar para participar!"
      );
    }, 30000);
  }
);
