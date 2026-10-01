import type { Server } from "./types.js";

export type CreateSpec = {
  typeId: string;
  label: string;
  /** Plain-text cloud-init: what the new server does on first boot. */
  userData: string;
};

/** What the fleet needs from a server company. Linode implements it for real; the fake implements it for tests. */
export interface ComputeProvider {
  /** ONLY servers carrying this fleet's tag. A provider must never return, let alone delete, anything else. */
  list(): Promise<Server[]>;
  create(spec: CreateSpec): Promise<Server>;
  remove(id: string): Promise<void>;
}

/** An in-memory provider for tests and dry runs. */
export class FakeProvider implements ComputeProvider {
  servers: Server[] = [];
  created: CreateSpec[] = [];
  removed: string[] = [];
  failCreate = false;
  failRemove = new Set<string>();
  private next = 1;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async list(): Promise<Server[]> {
    return this.servers.map((s) => ({ ...s }));
  }

  async create(spec: CreateSpec): Promise<Server> {
    if (this.failCreate) throw new Error("provider refused to create");
    const server: Server = { id: String(this.next++), label: spec.label, typeId: spec.typeId, status: "provisioning", ip: null, createdAt: this.clock() };
    this.servers.push(server);
    this.created.push(spec);
    return { ...server };
  }

  async remove(id: string): Promise<void> {
    if (this.failRemove.has(id)) throw new Error(`could not delete ${id}`);
    this.servers = this.servers.filter((s) => s.id !== id);
    this.removed.push(id);
  }
}
