/*
import { pgTable, uuid, text, jsonb } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { logs } from './logs';


Inference logs.
export const logPayloads = pgTable('log_payloads', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  log_id: uuid('log_id').notNull().references(() => logs.id, { onDelete: 'cascade' }),
  request: jsonb('jsonb_request').$type<Record<string, unknown>>(),
  response: jsonb('jsonb_response').$type<Record<string, unknown>>(),

  // Currently unused.
  // For storing this data in object storage like S3 instead of the database.
  object_ref: text('object_ref'),
});
*/