import type { EventLog } from '../events';
import { timedWrite } from './writes';

export type ResourceAttributes = Record<string, unknown>;
export interface ResourceInstancesApi { get(instanceKey: string): Promise<{ attributes?: object | null }>; update(instanceKey: string, d: { attributes: object }): Promise<unknown> }
export interface ResourceFactsUpdate { attributes: ResourceAttributes; ms: number; skipped: boolean }

/**
 * The single writer of resource-instance attributes, with the same read-modify-write per instance as
 * {@link FactsWriter}. Instances are keyed `type:key`, for example `organization:riders-of-rohan`.
 */
export class ResourceFactsWriter {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly instances: ResourceInstancesApi,
    private readonly events: EventLog,
  ) {}

  update(instanceKey: string, what: string, mutate: (a: ResourceAttributes) => ResourceAttributes): Promise<ResourceFactsUpdate> {
    const prev = this.tails.get(instanceKey) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async (): Promise<ResourceFactsUpdate> => {
      // Permit SDK: api.resourceInstances.get('type:key') reads the instance's current attributes.
      const current = structuredClone(((await this.instances.get(instanceKey)).attributes ?? {}) as ResourceAttributes);
      const next = mutate(structuredClone(current));
      if (JSON.stringify(next) === JSON.stringify(current)) return { attributes: current, ms: 0, skipped: true };
      // Permit SDK: api.resourceInstances.update('type:key', { attributes }) stores the new attribute set, such as an
      // organization's ownership_verified. It returns once the local PDP holds the change.
      const { ms } = await timedWrite(this.events, `${what} (${instanceKey})`, () => this.instances.update(instanceKey, { attributes: next }));
      return { attributes: next, ms, skipped: false };
    });
    this.tails.set(instanceKey, run);
    void run.finally(() => { if (this.tails.get(instanceKey) === run) this.tails.delete(instanceKey); }).catch(() => undefined);
    return run;
  }
}
