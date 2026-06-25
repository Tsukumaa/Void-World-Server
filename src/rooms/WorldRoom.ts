import { Room, Client } from "@colyseus/core";
import { Schema, type, MapSchema } from "@colyseus/schema";

class Player extends Schema {
  @type("string") id: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("string") direction: string = "down";
  @type("boolean") moving: boolean = false;
  @type("string") username: string = "";
}

class WorldState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}

export class WorldRoom extends Room {
  maxClients = 50;

  onCreate() {
    this.setState(new WorldState());

    this.onMessage("move", (client: Client, data: { x: number; y: number; direction: string; moving: boolean }) => {
      const state = this.state as WorldState;
      const player = state.players.get(client.sessionId);
      if (!player) return;
      player.x = data.x;
      player.y = data.y;
      player.direction = data.direction;
      player.moving = data.moving;
    });
  }

  onJoin(client: Client, options: { username?: string }) {
    const state = this.state as WorldState;
    const player = new Player();
    player.id = client.sessionId;
    player.x = 400;
    player.y = 300;
    player.username = options?.username ?? "Player";
    state.players.set(client.sessionId, player);
    console.log(`${player.username} joined`);
  }

  onLeave(client: Client) {
    const state = this.state as WorldState;
    state.players.delete(client.sessionId);
  }
}
