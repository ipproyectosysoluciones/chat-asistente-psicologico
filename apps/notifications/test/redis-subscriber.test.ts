import { describe, expect, it } from "vitest";

import {
  IoredisSubscriber,
  type SubscriberClient,
} from "../src/redis-subscriber";

/**
 * Redis pub-sub subscriber (design §2.2): subscribes to the telemetry
 * channel and forwards raw messages to the handler without parsing (parsing
 * is the alert router's job, task 2.2). Failures must never be silent.
 */
function fakeClient(): {
  client: SubscriberClient;
  getMessageListener: () => ((channel: string, message: string) => void) | undefined;
  calls: string[];
} {
  let messageListener: ((channel: string, message: string) => void) | undefined;
  const calls: string[] = [];
  const client: SubscriberClient = {
    on(event, listener) {
      if (event === "message") {
        messageListener = listener;
      }
    },
    async subscribe(channel: string) {
      calls.push(`subscribe:${channel}`);
    },
    async quit() {
      calls.push("quit");
    },
  };
  return { client, getMessageListener: () => messageListener, calls };
}

describe("IoredisSubscriber", () => {
  it("subscribes to the exact channel", async () => {
    const { client, calls } = fakeClient();
    const subscriber = new IoredisSubscriber(client);
    await subscriber.subscribe("telemetry:alert_raised", async () => {});
    expect(calls).toEqual(["subscribe:telemetry:alert_raised"]);
  });

  it("forwards raw messages for the subscribed channel to the handler", async () => {
    const { client, getMessageListener } = fakeClient();
    const subscriber = new IoredisSubscriber(client);
    const received: string[] = [];
    await subscriber.subscribe("telemetry:alert_raised", async (message) => {
      received.push(message);
    });

    const listener = getMessageListener();
    if (listener === undefined) {
      throw new Error("expected a message listener");
    }
    listener("telemetry:alert_raised", '{"type":"alert_raised"}');
    expect(received).toEqual(['{"type":"alert_raised"}']);
  });

  it("ignores messages published on other channels", async () => {
    const { client, getMessageListener } = fakeClient();
    const subscriber = new IoredisSubscriber(client);
    const received: string[] = [];
    await subscriber.subscribe("telemetry:alert_raised", async (message) => {
      received.push(message);
    });

    const listener = getMessageListener();
    if (listener === undefined) {
      throw new Error("expected a message listener");
    }
    listener("telemetry:alert_updated", '{"type":"alert_updated"}');
    expect(received).toEqual([]);
  });

  it("routes handler failures to onError instead of swallowing them", async () => {
    const { client, getMessageListener } = fakeClient();
    const errors: unknown[] = [];
    const subscriber = new IoredisSubscriber(client, (error) => {
      errors.push(error);
    });
    await subscriber.subscribe("telemetry:alert_raised", async () => {
      throw new Error("handler boom");
    });

    const listener = getMessageListener();
    if (listener === undefined) {
      throw new Error("expected a message listener");
    }
    listener("telemetry:alert_raised", "ignored");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "handler boom" });
  });

  it("close() releases the underlying client connection", async () => {
    const { client, calls } = fakeClient();
    const subscriber = new IoredisSubscriber(client);
    await subscriber.close();
    expect(calls).toContain("quit");
  });
});
