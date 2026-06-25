import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

interface Player {
  id: string;
  username: string;
  x: number;
  y: number;
  direction: string;
  moving: boolean;
  ws: WebSocket;
}

const players = new Map<string, Player>();
let nextId = 1;

function broadcast(data: object, exclude?: string) {
  const msg = JSON.stringify(data);
  players.forEach((p) => {
    if (p.id !== exclude && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  });
}

wss.on("connection", (ws) => {
  const id = String(nextId++);

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "join") {
      const player: Player = { id, username: msg.username, x: 400, y: 300, direction: "down", moving: false, ws };
      players.set(id, player);

      // envoie au nouveau joueur son id + tous les joueurs existants
      ws.send(JSON.stringify({ type: "init", id, players: [...players.values()].filter(p => p.id !== id).map(({ ws: _, ...p }) => p) }));

      // annonce aux autres
      broadcast({ type: "player_join", player: { id, username: player.username, x: player.x, y: player.y, direction: player.direction, moving: player.moving } }, id);
      console.log(`${msg.username} joined (${id})`);
    }

    if (msg.type === "move") {
      const player = players.get(id);
      if (!player) return;
      player.x = msg.x;
      player.y = msg.y;
      player.direction = msg.direction;
      player.moving = msg.moving;
      broadcast({ type: "player_move", id, x: msg.x, y: msg.y, direction: msg.direction, moving: msg.moving }, id);
    }

    if (msg.type === "chat") {
      const player = players.get(id);
      if (!player || !msg.text?.trim()) return;
      const text = String(msg.text).slice(0, 100);
      broadcast({ type: "chat", id, text }, undefined);
    }

    if (msg.type === "dm") {
      const from = players.get(id);
      const to = players.get(String(msg.toId));
      if (!from || !to || !msg.text?.trim()) return;
      const text = String(msg.text).slice(0, 500);
      if (to.ws.readyState === WebSocket.OPEN) {
        to.ws.send(JSON.stringify({ type: "dm", fromId: id, fromName: from.username, text }));
      }
    }
  });

  ws.on("close", () => {
    players.delete(id);
    broadcast({ type: "player_leave", id });
    console.log(`Player ${id} left`);
  });
});

const port = Number(process.env.PORT ?? 2567);
httpServer.listen(port, () => console.log(`Void World server running on port ${port}`));
