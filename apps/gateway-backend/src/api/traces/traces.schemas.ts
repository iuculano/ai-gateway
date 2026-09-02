import { createSchema } from '@repo/hono';
import { z } from 'zod';

// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/collector/trace/v1/trace_service.proto
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/examples/trace.json

const signedInt64Schema = z.union([z.string().regex(/^-?\d+$/), z.number().int()]);

const unsignedInt64Schema = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]);

// Bitfields
const uint32Schema = z.number().int().min(0).max(0xffff_ffff);

// Seems mandated by spec that these ids are exactly this shape, you can't use
// something like a UUID.
const traceIdSchema = z.string().regex(/^[0-9a-fA-F]{32}$/);
const spanIdSchema = z.string().regex(/^[0-9a-fA-F]{16}$/);

// Seemingly valid for this to just be empty string... or even omitted.
const parentSpanIdSchema = z.union([z.literal(''), spanIdSchema]);

type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
  bytesValue?: string;
};

type KeyValue = {
  key: string;
  value?: AnyValue;
};

let KeyValueSchema: z.ZodType<KeyValue>;

const AnyValueSchema: z.ZodType<AnyValue> = z.lazy(() =>
  z.object({
    stringValue: z.string().optional(),
    boolValue: z.boolean().optional(),
    intValue: signedInt64Schema.optional(),
    doubleValue: z.number().optional(),

    arrayValue: z
      .object({
        values: z.array(AnyValueSchema).optional(),
      })
      .optional(),

    kvlistValue: z
      .object({
        values: z.array(KeyValueSchema).optional(),
      })
      .optional(),

    // Normal protobuf bytes fields are base64 in OTLP/JSON.
    // traceId and spanId are the exceptions and are hex.
    bytesValue: z.string().optional(),
  }),
);

KeyValueSchema = z.object({
  key: z.string().min(1),
  value: AnyValueSchema.optional(),
});

const ResourceSchema = z.object({
  attributes: z.array(KeyValueSchema).default([]),
  droppedAttributesCount: uint32Schema.optional(),
});

const SpanEventSchema = z.object({
  timeUnixNano: unsignedInt64Schema,
  name: z.string().min(1),
  attributes: z.array(KeyValueSchema).default([]),
  droppedAttributesCount: uint32Schema.optional(),
});

const SpanLinkSchema = z.object({
  traceId: traceIdSchema,
  spanId: spanIdSchema,
  traceState: z.string().optional(),
  attributes: z.array(KeyValueSchema).default([]),
  droppedAttributesCount: uint32Schema.optional(),
  flags: uint32Schema.optional(),
});

const SpanStatusSchema = z.object({
  message: z.string().optional(),

  // 0 = unset, 1 = OK, 2 = error.
  code: z.number().int().nonnegative().optional(),
});

const SpanSchema = z.object({
  traceId: traceIdSchema,
  spanId: spanIdSchema,
  traceState: z.string().optional(),
  parentSpanId: parentSpanIdSchema.optional(),
  flags: uint32Schema.optional(),

  name: z.string().min(1),

  // 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer.
  kind: z.number().int().nonnegative().optional(),

  startTimeUnixNano: unsignedInt64Schema,
  endTimeUnixNano: unsignedInt64Schema,

  attributes: z.array(KeyValueSchema).default([]),
  droppedAttributesCount: uint32Schema.optional(),

  events: z.array(SpanEventSchema).default([]),
  droppedEventsCount: uint32Schema.optional(),

  links: z.array(SpanLinkSchema).default([]),
  droppedLinksCount: uint32Schema.optional(),

  status: SpanStatusSchema.optional(),
});

// The actual OTEL nomenclature for this is "ExportTraceServiceRequest"
export const createTraceBody = z.object({
  resourceSpans: z
    .array(
      z.object({
        resource: ResourceSchema.optional(),

        scopeSpans: z
          .array(
            z.object({
              scope: z
                .object({
                  name: z.string().optional(),
                  version: z.string().optional(),
                  attributes: z.array(KeyValueSchema).default([]),
                  droppedAttributesCount: uint32Schema.optional(),
                })
                .optional(),
              spans: z.array(SpanSchema).default([]),
              schemaUrl: z.string().optional(),
            }),
          )
          .default([]),

        schemaUrl: z.string().optional(),
      }),
    )
    .default([]),
});

const createTraceResponse = z.union([
  z.strictObject({}), // literally {} for 200 OK
  z.object({
    partialSuccess: z.object({
      rejectedSpans: z.string().regex(/^\d+$/),
      errorMessage: z.string().optional(),
    }),
  }),
]);

const createTrace = createSchema({
  body: createTraceBody,
  response: createTraceResponse,
});

export type CreateTraceRequest = z.infer<typeof createTrace.body>;
export type CreateTraceResponse = z.infer<typeof createTrace.response>;

export default {
  createTrace,
};
