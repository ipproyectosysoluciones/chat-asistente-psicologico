import type { FlowState } from "./flow";

/**
 * Flow-state persistence (design §4.2). The pilot stores dialogue state
 * in-memory per process; the interface stays so a Redis-backed store can
 * replace it when the service scales horizontally (configuration-only swap,
 * same contract as the provider and database pillars).
 */

export interface FlowStateStore {
  get(contactKeyAnon: string): Promise<FlowState | undefined>;
  set(contactKeyAnon: string, state: FlowState): Promise<void>;
}

export class InMemoryFlowStateStore implements FlowStateStore {
  private readonly states = new Map<string, FlowState>();

  async get(contactKeyAnon: string): Promise<FlowState | undefined> {
    return this.states.get(contactKeyAnon);
  }

  async set(contactKeyAnon: string, state: FlowState): Promise<void> {
    this.states.set(contactKeyAnon, state);
  }
}
