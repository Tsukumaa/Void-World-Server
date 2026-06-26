interface Player {
  id: string;
  username: string;
  x: number;
  y: number;
  direction: string;
  moving: boolean;
  lastSavedAt?: number;
}

export class WorldRoom implements DurableObject {
  private state: DurableObjectState;
  private players = new Map<string, Player>();
  private wsToId = new Map<WebSocket, string>();
  private nextId = 1;

  constructor(state: DurableObjectState) {
    this.state = state;
    // Ping auto toutes les 30s pour garder les connexions vivantes
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
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
      const id = String(this.nextId++);
      const username = msg.username ?? "Joueur";

      // Position sauvegardée pour ce pseudo (sinon spawn par défaut)
      const saved = await this.state.storage.get<{ x: number; y: number }>(`pos:${username}`);
      const player: Player = {
        id, username,
        x: saved?.x ?? 2400, y: saved?.y ?? 1920,
        direction: "down", moving: false,
      };
      this.players.set(id, player);
      this.wsToId.set(ws, id);

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

      // Sauvegarde throttlée (max 1x / 2s par joueur)
      const now = Date.now();
      if (now - (player.lastSavedAt ?? 0) > 2000) {
        player.lastSavedAt = now;
        this.state.storage.put(`pos:${player.username}`, { x: msg.x, y: msg.y });
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
