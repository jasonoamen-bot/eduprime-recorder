import { randomBytes } from "node:crypto";
import type { ComputeProvider, CreateSpec } from "./provider.js";
import type { Server, ServerStatus } from "./types.js";

export type LinodeOptions = {
  token: string;
  /** "eu-central" = Frankfurt. Must support the Metadata service (cloud-init). */
  region?: string;
  image?: string;
  /** Every server we create carries this tag, and we ONLY ever list or delete servers that have it. */
  tag?: string;
  /** Public keys allowed to log in to the servers (for debugging). Optional: recording needs no login. */
  authorizedKeys?: string[];
  fetch?: typeof fetch;
  baseUrl?: string;
};

type LinodeInstance = {
  id: number; label: string; type: string; status: string; ipv4: string[]; created: string; tags: string[];
};

const mapStatus = (status: string): ServerStatus =>
  status === "running" ? "running" : ["provisioning", "booting", "rebooting", "migrating", "cloning"].includes(status) ? "provisioning" : "other";

/**
 * Akamai/Linode over its public REST API (v4).
 *
 * SAFETY, because this holds credentials that can spend money:
 *  - the token is only ever sent as a header; it never appears in an error message or a log line;
 *  - list() asks for the tag AND filters again on our side;
 *  - remove() re-reads the server and refuses unless it carries our tag, so a wrong id can never delete
 *    someone else's machine.
 */
export class LinodeProvider implements ComputeProvider {
  private readonly region: string;
  private readonly image: string;
  private readonly tag: string;
  private readonly base: string;
  private readonly http: typeof fetch;

  constructor(private readonly options: LinodeOptions) {
    if (!options.token || options.token.length < 20) throw new Error("a Linode API token is required");
    this.region = options.region ?? "eu-central";
    this.image = options.image ?? "linode/ubuntu24.04";
    this.tag = options.tag ?? "eduprime-recorder";
    this.base = (options.baseUrl ?? "https://api.linode.com/v4").replace(/\/+$/, "");
    this.http = options.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const response = await this.http(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.options.token}`, "content-type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json: unknown = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* leave empty */ }
    if (!response.ok) {
      const reason = (json as { errors?: { reason?: string }[] }).errors?.map((e) => e.reason).filter(Boolean).join("; ");
      throw new Error(`Linode ${method} ${path} -> HTTP ${response.status}${reason ? `: ${reason}` : ""}`);
    }
    return json as T;
  }

  private toServer(i: LinodeInstance): Server {
    return { id: String(i.id), label: i.label, typeId: i.type, status: mapStatus(i.status), ip: i.ipv4?.[0] ?? null, createdAt: new Date(i.created.endsWith("Z") ? i.created : `${i.created}Z`) };
  }

  async list(): Promise<Server[]> {
    const page = await this.call<{ data: LinodeInstance[] }>("GET", "/linode/instances?page_size=100", undefined, { "X-Filter": JSON.stringify({ tags: this.tag }) });
    return page.data.filter((i) => i.tags?.includes(this.tag)).map((i) => this.toServer(i));
  }

  async create(spec: CreateSpec): Promise<Server> {
    const instance = await this.call<LinodeInstance>("POST", "/linode/instances", {
      label: spec.label,
      region: this.region,
      type: spec.typeId,
      image: this.image,
      root_pass: randomBytes(24).toString("base64url"), // required by the API; never used (key login only)
      authorized_keys: this.options.authorizedKeys ?? [],
      tags: [this.tag],
      booted: true,
      metadata: { user_data: Buffer.from(spec.userData, "utf8").toString("base64") },
    });
    return this.toServer(instance);
  }

  async remove(id: string): Promise<void> {
    if (!/^\d+$/.test(id)) throw new Error(`refusing to delete: "${id}" is not a Linode id`);
    const instance = await this.call<LinodeInstance>("GET", `/linode/instances/${id}`);
    if (!instance.tags?.includes(this.tag)) throw new Error(`refusing to delete ${id}: it does not carry the "${this.tag}" tag, so it is not ours`);
    await this.call("DELETE", `/linode/instances/${id}`);
  }
}
