import Schemas, { type CreateTraceRequest, type CreateTraceResponse } from './traces.schemas';

/**
 * Accepts an OTLP trace export.
 */
async function createTrace(_request: CreateTraceRequest): Promise<CreateTraceResponse> {
  return Schemas.createTrace.response.parse({});
}

export default {
  createTrace,
};
