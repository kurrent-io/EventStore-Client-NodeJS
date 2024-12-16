import { createTestNode } from "@test-utils";

import { KurrentDBClient } from "@kurrent/db-client";

describe("restartSubsystem", () => {
  const node = createTestNode();
  let client!: KurrentDBClient;

  beforeAll(async () => {
    await node.up();
    client = new KurrentDBClient(
      { endpoint: node.uri },
      { rootCertificate: node.certs.root },
      { username: "admin", password: "changeit" }
    );
  });

  afterAll(async () => {
    await node.down();
  });

  test("Doesnt error", async () => {
    await expect(client.restartSubsystem()).resolves.toBeUndefined();
  });
});
