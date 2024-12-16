import { createTestNode, Defer, delay, jsonTestEvents } from "@test-utils";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import {
  SEMATTRS_EXCEPTION_STACKTRACE,
  SEMATTRS_EXCEPTION_TYPE,
} from "@opentelemetry/semantic-conventions";
import { KurrentDBInstrumentation } from "@kurrent/opentelemetry";
import { KurrentDBAttributes } from "@kurrent/opentelemetry/dist/attributes";
import { v4 } from "uuid";
import { collect } from "@test-utils";

const tracerProvider = new NodeTracerProvider();
tracerProvider.register();

const instrumentation = new KurrentDBInstrumentation();
instrumentation.disable();

import * as esdb from "@kurrent/db-client";
import {
  AppendToStreamOptions,
  ResolvedEvent,
  streamNameFilter,
  WrongExpectedVersionError,
} from "@kurrent/db-client";

describe("instrumentation", () => {
  const node = createTestNode();
  const moduleName = "@kurrent/opentelemetry";

  const memoryExporter = new InMemorySpanExporter();
  instrumentation.setTracerProvider(tracerProvider);
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));

  // @ts-expect-error the moduleExports property is private. This is needed to make the test work with auto-mocking
  instrumentation._modules[0].moduleExports = esdb;

  beforeAll(async () => {
    await node.up();
    instrumentation.enable();
  });

  afterAll(async () => {
    instrumentation.disable();
    await node.down();
  });

  afterEach(() => {
    memoryExporter.reset();
  });

  describe("append", () => {
    test.each([
      { withCredentials: false, credentials: undefined },
      {
        withCredentials: true,
        credentials: { username: "admin", password: "changeit" },
      },
    ])(
      "should create a span for append operation, withCredentials: $withCredentials",
      async ({ withCredentials, credentials }) => {
        const { KurrentDBClient, jsonEvent } = await import(
          "@kurrent/db-client"
        );

        const STREAM = v4();

        const client = new KurrentDBClient(
          { endpoint: node.uri },
          { rootCertificate: node.certs.root },
          { username: "admin", password: "changeit" }
        );

        const appendOptions: AppendToStreamOptions = {
          expectedRevision: "any",
        };

        if (withCredentials) {
          appendOptions.credentials = credentials;
        }

        await client.appendToStream(
          STREAM,
          jsonEvent({
            type: "test",
            data: {},
          }),
          appendOptions
        );

        const spans = memoryExporter.getFinishedSpans();
        const span = spans[0];

        const events = await collect(client.readStream(STREAM));
        const event = events[0];

        expect(events.length).toBe(1);
        expect(event.event?.metadata).toStrictEqual({
          $traceId: expect.any(String),
          $spanId: expect.any(String),
        });

        const expectedAttributes = {
          [KurrentDBAttributes.KURRENT_DB_STREAM]: STREAM,
          [KurrentDBAttributes.SERVER_ADDRESS]: node.endpoints[0].address,
          [KurrentDBAttributes.SERVER_PORT]: node.endpoints[0].port.toString(),
          [KurrentDBAttributes.DATABASE_SYSTEM]: moduleName,
          [KurrentDBAttributes.DATABASE_OPERATION]: "appendToStream",
        };

        if (withCredentials) {
          expectedAttributes[KurrentDBAttributes.DATABASE_USER] =
            credentials!.username;
        }

        expect(spans.length).toBe(1);
        expect(span.attributes).toStrictEqual(expectedAttributes);
      }
    );

    test("span contains error when append fails", async () => {
      const { KurrentDBClient } = await import("@kurrent/db-client");

      const client = new KurrentDBClient(
        { endpoint: node.uri },
        { rootCertificate: node.certs.root },
        { username: "admin", password: "changeit" }
      );

      const STREAM_NAME = v4();

      await client.appendToStream(STREAM_NAME, jsonTestEvents());

      try {
        const result = await client.appendToStream(
          STREAM_NAME,
          jsonTestEvents(),
          {
            expectedRevision: "no_stream",
          }
        );

        expect(result).toBe("unreachable");
      } catch (error) {
        const spans = memoryExporter.getFinishedSpans();
        expect(spans.length).toBe(2);

        const failedSpan = spans[1];

        const failedEvents = failedSpan.events;

        expect(failedEvents.length).toBe(1);

        const failedEvent = failedEvents[0];

        if (error instanceof WrongExpectedVersionError) {
          expect(error).toBeInstanceOf(WrongExpectedVersionError);
          expect(failedEvent).toEqual(
            expect.objectContaining({
              name: "exception",
              attributes: {
                [SEMATTRS_EXCEPTION_TYPE]: "Error",
                [SEMATTRS_EXCEPTION_STACKTRACE]: error.stack,
              },
            })
          );
        }
      }
    });
  });

  describe("catch up subscriptions", () => {
    test("should create child span in subscription to stream", async () => {
      const defer = new Defer();
      const { KurrentDBClient, jsonEvent } = await import("@kurrent/db-client");

      const STREAM = v4();

      const client = new KurrentDBClient(
        { endpoint: node.uri },
        { rootCertificate: node.certs.root },
        { username: "admin", password: "changeit" }
      );

      const handleError = jest.fn((error) => {
        defer.reject(error);
      });
      const handleEvent = jest.fn((event: ResolvedEvent) => {
        if (event.event?.streamId == STREAM) {
          subscription.unsubscribe();
        }
      });
      const handleEnd = jest.fn(defer.resolve);
      const handleConfirmation = jest.fn();

      const event = jsonEvent({
        type: "SomeType",
        data: {},
      });

      await client.appendToStream(STREAM, event);

      const subscription = client
        .subscribeToStream(STREAM, {
          credentials: {
            username: "admin",
            password: "changeit",
          },
        })
        .on("error", handleError)
        .on("data", handleEvent)
        .on("end", handleEnd)
        .on("confirmation", handleConfirmation);

      await delay(500);
      await defer.promise;

      const spans = memoryExporter.getFinishedSpans();

      const parentSpan = spans.find(
        (span) => span.name === KurrentDBAttributes.STREAM_APPEND
      );
      const childSpan = spans.find(
        (span) => span.name === KurrentDBAttributes.STREAM_SUBSCRIBE
      );

      expect(handleConfirmation).toHaveBeenCalledTimes(1);

      expect(parentSpan).toBeDefined();
      expect(childSpan).toBeDefined();
      expect(parentSpan?.spanContext().spanId).toBe(childSpan?.parentSpanId);

      expect(childSpan?.attributes).toMatchObject({
        [KurrentDBAttributes.KURRENT_DB_STREAM]: STREAM,
        [KurrentDBAttributes.KURRENT_DB_EVENT_ID]: event.id,
        [KurrentDBAttributes.KURRENT_DB_EVENT_TYPE]: event.type,
        [KurrentDBAttributes.KURRENT_DB_SUBSCRIPTION_ID]: subscription.id,
        [KurrentDBAttributes.SERVER_ADDRESS]: node.endpoints[0].address,
        [KurrentDBAttributes.SERVER_PORT]: node.endpoints[0].port.toString(),
        [KurrentDBAttributes.DATABASE_SYSTEM]: moduleName,
        [KurrentDBAttributes.DATABASE_OPERATION]: "subscribeToStream",
        [KurrentDBAttributes.DATABASE_USER]: "admin",
      });

      expect(parentSpan?.attributes).toMatchObject({
        [KurrentDBAttributes.KURRENT_DB_STREAM]: STREAM,
        [KurrentDBAttributes.SERVER_ADDRESS]: node.endpoints[0].address,
        [KurrentDBAttributes.SERVER_PORT]: node.endpoints[0].port.toString(),
        [KurrentDBAttributes.DATABASE_SYSTEM]: moduleName,
        [KurrentDBAttributes.DATABASE_OPERATION]: "appendToStream",
      });
    });

    test.only("events with non-json metadata are not traced in subscriptions", async () => {
      const defer = new Defer();
      const { KurrentDBClient, jsonEvent, binaryEvent } = await import(
        "@kurrent/db-client"
      );

      const STREAM = v4();

      const client = new KurrentDBClient(
        { endpoint: node.uri },
        { rootCertificate: node.certs.root },
        { username: "admin", password: "changeit" }
      );

      const handleError = jest.fn((error) => {
        defer.reject(error);
      });
      const handleEvent = jest.fn((event: ResolvedEvent) => {
        if (event.event?.streamId == STREAM) {
          subscription.unsubscribe();
        }
      });
      const handleEnd = jest.fn(defer.resolve);
      const handleConfirmation = jest.fn();

      const event1 = binaryEvent({
        type: "SomeType",
        data: Buffer.from("hello"),
        metadata: {
          "some-data": "some-value",
        },
      });
      const event2 = jsonEvent({
        type: "SomeType",
        data: {
          "some-data": "some-value",
        },
        metadata: 2,
      });

      await client.appendToStream(STREAM, [event1, event2]);

      const subscription = client
        .subscribeToStream(STREAM, {
          credentials: {
            username: "admin",
            password: "changeit",
          },
        })
        .on("error", handleError)
        .on("data", handleEvent)
        .on("end", handleEnd)
        .on("confirmation", handleConfirmation);

      await delay(500);
      await defer.promise;

      const spans = memoryExporter.getFinishedSpans();

      const parentSpans = spans.filter(
        (span) => span.name === KurrentDBAttributes.STREAM_APPEND
      );

      const childSpans = spans.filter(
        (span) => span.name === KurrentDBAttributes.STREAM_SUBSCRIBE
      );

      expect(handleConfirmation).toHaveBeenCalledTimes(1);

      expect(parentSpans.length).toBe(1);

      expect(childSpans).toBeDefined();

      expect(childSpans).toHaveLength(1);

      expect(
        childSpans[0].attributes[KurrentDBAttributes.KURRENT_DB_EVENT_ID]
      ).toBe(event1.id);
      expect(
        childSpans[0].attributes[KurrentDBAttributes.KURRENT_DB_EVENT_TYPE]
      ).toBe(event1.type);
    });
  });

  describe("persistent subscriptions", () => {
    test("should create child span in persistent subscription to stream", async () => {
      const {
        KurrentDBClient,
        jsonEvent,
        persistentSubscriptionToStreamSettingsFromDefaults,
        START,
      } = await import("@kurrent/db-client");

      const STREAM = v4();
      const GROUP = v4();

      const client = new KurrentDBClient(
        { endpoint: node.uri },
        { rootCertificate: node.certs.root },
        { username: "admin", password: "changeit" }
      );

      await client.createPersistentSubscriptionToStream(
        STREAM,
        GROUP,
        persistentSubscriptionToStreamSettingsFromDefaults({
          startFrom: START,
        })
      );

      const defer = new Defer();

      const handleError = jest.fn((error) => {
        defer.reject(error);
      });
      const handleEvent = jest.fn(async (event: ResolvedEvent) => {
        if (event.event) {
          await subscription.ack(event);
          defer.resolve();
        }
      });
      const handleEnd = jest.fn(defer.resolve);
      const onConfirmation = jest.fn();

      const subscription = client
        .subscribeToPersistentSubscriptionToStream(STREAM, GROUP)
        .on("error", handleError)
        .on("data", handleEvent)
        .on("confirmation", onConfirmation)
        .on("end", handleEnd);

      const event = jsonEvent({
        type: "SomeEvent",
        data: {},
      });

      await client.appendToStream(STREAM, event);

      await delay(500);
      await defer.promise;

      const spans = memoryExporter.getFinishedSpans();

      expect(handleEvent).toHaveBeenCalledTimes(1);

      const parentSpan = spans.find(
        (span) => span.name === KurrentDBAttributes.STREAM_APPEND
      );
      const childSpan = spans.find(
        (span) => span.name === KurrentDBAttributes.STREAM_SUBSCRIBE
      );

      expect(parentSpan).toBeDefined();
      expect(childSpan).toBeDefined();
      expect(parentSpan?.spanContext().spanId).toBe(childSpan?.parentSpanId);

      expect(childSpan?.attributes).toMatchObject({
        [KurrentDBAttributes.KURRENT_DB_STREAM]: STREAM,
        [KurrentDBAttributes.KURRENT_DB_EVENT_ID]: event.id,
        [KurrentDBAttributes.KURRENT_DB_EVENT_TYPE]: event.type,
        [KurrentDBAttributes.KURRENT_DB_SUBSCRIPTION_ID]: subscription.id,
        [KurrentDBAttributes.SERVER_ADDRESS]: node.endpoints[0].address,
        [KurrentDBAttributes.SERVER_PORT]: node.endpoints[0].port.toString(),
        [KurrentDBAttributes.DATABASE_SYSTEM]: moduleName,
        [KurrentDBAttributes.DATABASE_OPERATION]:
          "subscribeToPersistentSubscriptionToStream",
      });

      expect(parentSpan?.attributes).toMatchObject({
        [KurrentDBAttributes.KURRENT_DB_STREAM]: STREAM,
        [KurrentDBAttributes.SERVER_ADDRESS]: node.endpoints[0].address,
        [KurrentDBAttributes.SERVER_PORT]: node.endpoints[0].port.toString(),
        [KurrentDBAttributes.DATABASE_SYSTEM]: moduleName,
        [KurrentDBAttributes.DATABASE_OPERATION]: "appendToStream",
      });
    });

    test("should create child span in persistent subscription to all", async () => {
      const {
        KurrentDBClient,
        jsonEvent,
        persistentSubscriptionToAllSettingsFromDefaults,
        START,
      } = await import("@kurrent/db-client");

      const GROUP = v4();
      const STREAM = v4();

      const client = new KurrentDBClient(
        { endpoint: node.uri },
        { rootCertificate: node.certs.root },
        { username: "admin", password: "changeit" }
      );

      await client.createPersistentSubscriptionToAll(
        GROUP,
        persistentSubscriptionToAllSettingsFromDefaults({
          startFrom: START,
        }),
        {
          filter: streamNameFilter({
            prefixes: [STREAM],
          }),
        }
      );

      const defer = new Defer();

      const handleError = jest.fn((error) => {
        defer.reject(error);
      });
      const handleEvent = jest.fn(async (event: ResolvedEvent) => {
        if (event.event) {
          await subscription.ack(event);
        }

        if (event.event?.streamId == STREAM) {
          defer.resolve();
        }
      });
      const handleEnd = jest.fn(defer.resolve);
      const onConfirmation = jest.fn();

      const subscription = client
        .subscribeToPersistentSubscriptionToAll(GROUP, {
          credentials: {
            username: "admin",
            password: "changeit",
          },
        })
        .on("error", handleError)
        .on("data", handleEvent)
        .on("confirmation", onConfirmation)
        .on("end", handleEnd);

      const event = jsonEvent({
        type: "SomeEvent",
        data: {},
      });

      await client.appendToStream(STREAM, event);

      await delay(500);
      await defer.promise;

      const spans = memoryExporter.getFinishedSpans();

      const parentSpan = spans.find(
        (span) => span.name === KurrentDBAttributes.STREAM_APPEND
      );
      const childSpan = spans.find(
        (span) => span.name === KurrentDBAttributes.STREAM_SUBSCRIBE
      );

      expect(parentSpan).toBeDefined();
      expect(childSpan).toBeDefined();
      expect(parentSpan?.spanContext().spanId).toBe(childSpan?.parentSpanId);

      expect(childSpan?.attributes).toMatchObject({
        [KurrentDBAttributes.KURRENT_DB_STREAM]: STREAM,
        [KurrentDBAttributes.KURRENT_DB_EVENT_ID]: event.id,
        [KurrentDBAttributes.KURRENT_DB_EVENT_TYPE]: event.type,
        [KurrentDBAttributes.KURRENT_DB_SUBSCRIPTION_ID]: subscription.id,
        [KurrentDBAttributes.SERVER_ADDRESS]: node.endpoints[0].address,
        [KurrentDBAttributes.SERVER_PORT]: node.endpoints[0].port.toString(),
        [KurrentDBAttributes.DATABASE_SYSTEM]: moduleName,
        [KurrentDBAttributes.DATABASE_OPERATION]:
          "subscribeToPersistentSubscriptionToAll",
        [KurrentDBAttributes.DATABASE_USER]: "admin",
      });

      expect(parentSpan?.attributes).toMatchObject({
        [KurrentDBAttributes.KURRENT_DB_STREAM]: STREAM,
        [KurrentDBAttributes.SERVER_ADDRESS]: node.endpoints[0].address,
        [KurrentDBAttributes.SERVER_PORT]: node.endpoints[0].port.toString(),
        [KurrentDBAttributes.DATABASE_SYSTEM]: moduleName,
        [KurrentDBAttributes.DATABASE_OPERATION]: "appendToStream",
      });
    });
  });
});
