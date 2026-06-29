interface Player {
  id: string;
  username: string;
  x: number;
  y: number;
  direction: string;
  moving: boolean;
  charCfg?: object;
  lastSavedAt?: number;
}

export class WorldRoom implements DurableObject {
  private state: DurableObjectState;
  private players = new Map<string, Player>();
  private wsToId = new Map<WebSocket, string>();

  constructor(state: DurableObjectState) {
    this.state = state;
    // Auto-réponse ping/pong sans réveiller la DO de son hibernation
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
    // Réhydrate l'état en mémoire depuis les WebSockets hibernés (au réveil de la DO,
    // le constructeur se relance et les maps sont vides → on les reconstruit)
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as Player | null;
      if (att && att.id) {
        this.players.set(att.id, att);
        this.wsToId.set(ws, att.id);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket attendu", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let msg: any;
    try { msg = JSON.parse(message as string); } catch { return; }

    if (msg.type === "join") {
      const id = crypto.randomUUID();
      const username = msg.username ?? "Joueur";

      // Anti-fantôme : retire du suivi toute connexion existante avec le même pseudo.
      // On NE ferme PAS l'ancien socket (ça déclencherait une guerre de reconnexion) ;
      // ses futurs messages référenceront un id absent → ignorés.
      for (const [otherWs, otherId] of [...this.wsToId.entries()]) {
        const other = this.players.get(otherId);
        if (other && other.username === username) {
          this.players.delete(otherId);
          this.wsToId.delete(otherWs);
          this.broadcast({ type: "player_leave", id: otherId });
        }
      }

      // Position : fournie par le client (continuité reconnexion) > sauvegardée > défaut
      const saved = await this.state.storage.get<{ x: number; y: number }>(`pos:${username}`);
      const px = typeof msg.x === "number" ? msg.x : (saved?.x ?? 1280);
      const py = typeof msg.y === "number" ? msg.y : (saved?.y ?? 960);
      const player: Player = {
        id, username,
        x: px, y: py,
        direction: "down", moving: false,
        charCfg: msg.charCfg ?? undefined,
      };
      this.players.set(id, player);
      this.wsToId.set(ws, id);
      // Persiste l'identité/état sur le socket pour survivre à l'hibernation
      ws.serializeAttachment(player);

      // Envoie au nouveau joueur son id + sa position + tous les autres
      ws.send(JSON.stringify({
        type: "init", id,
        self: { x: player.x, y: player.y },
        players: [...this.players.values()].filter(p => p.id !== id),
      }));

      // Annonce aux autres
      this.broadcast({ type: "player_join", player }, id);
      console.log(`${username} joined (${id}) at ${player.x},${player.y}`);
    }

    const id = this.wsToId.get(ws);
    if (!id) return;

    if (msg.type === "move") {
      const player = this.players.get(id);
      if (!player) return;
      player.x = msg.x; player.y = msg.y;
      player.direction = msg.direction; player.moving = msg.moving;
      this.broadcast({ type: "player_move", id, x: msg.x, y: msg.y, direction: msg.direction, moving: msg.moving }, id);

      // Sauvegarde throttlée (max 1x / 2s par joueur) + maj de l'attachment hibernation
      const now = Date.now();
      if (now - (player.lastSavedAt ?? 0) > 2000) {
        player.lastSavedAt = now;
        this.state.storage.put(`pos:${player.username}`, { x: msg.x, y: msg.y });
        try { ws.serializeAttachment(player); } catch {}
      }
    }

    if (msg.type === "chat") {
      const player = this.players.get(id);
      if (!player || !msg.text?.trim()) return;
      const text = String(msg.text).slice(0, 100);
      this.broadcast({ type: "chat", id, text });
    }

    if (msg.type === "dm") {
      const from = this.players.get(id);
      if (!from || !msg.text?.trim()) return;
      const text = String(msg.text).slice(0, 500);
      const toId = String(msg.toId);
      const toWs = [...this.wsToId.entries()].find(([, pid]) => pid === toId)?.[0];
      if (toWs) toWs.send(JSON.stringify({ type: "dm", fromId: id, fromName: from.username, text }));
    }
  }

  async webSocketClose(ws: WebSocket) {
    const id = this.wsToId.get(ws);
    if (!id) return;
    const player = this.players.get(id);
    // Sauvegarde la position finale
    if (player) {
      await this.state.storage.put(`pos:${player.username}`, { x: player.x, y: player.y });
    }
    this.players.delete(id);
    this.wsToId.delete(ws);
    this.broadcast({ type: "player_leave", id });
    console.log(`Player ${id} left`);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  private broadcast(data: object, excludeId?: string) {
    const msg = JSON.stringify(data);
    for (const [ws, pid] of this.wsToId) {
      if (pid === excludeId) continue;
      try { ws.send(msg); } catch {}
    }
  }
}

export interface Env {
  WORLD_ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Room demandée : "main" (monde) ou "house:<pseudo>" (maison instanciée)
    let roomName = url.searchParams.get("room") ?? "main";
    // Sécurité : on limite les caractères et la longueur
    roomName = roomName.slice(0, 60).replace(/[^a-zA-Z0-9:_-]/g, "");
    if (!roomName) roomName = "main";

    const id = env.WORLD_ROOM.idFromName(roomName);
    const room = env.WORLD_ROOM.get(id);
    return room.fetch(request);
  },
};
