import { createTestCluster, jsonTestEvents } from "@test-utils";
import { KurrentDBClient } from "@kurrent/kurrentdb-client";

describe("Channel", () => {
  const cluster = createTestCluster();

  beforeAll(async () => {
    await cluster.up();
  });

  afterAll(async () => {
    await cluster.down();
  });

  test("a single client should connect to a single node", async () => {
    const client = KurrentDBClient.connectionString(
      cluster.connectionStringWithOverrides({
        nodePreference: "random",
      })
    );

    /*
         Spying on an internal api is more implementation specific than
         I would like, but there is no easy way to check this.
        */
    const discovery = jest.spyOn(client, "resolveUri" as never);

    const promises: Promise<unknown>[] = [
      client.appendToStream("stream_1", jsonTestEvents()),
      client.appendToStream("stream_2", jsonTestEvents()),
    ];

    await Promise.all(promises);

    expect(discovery).toBeCalledTimes(1);
  });
});
