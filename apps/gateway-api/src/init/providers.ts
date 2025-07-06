import { db } from '../clients/drizzle';
import { providers } from '../db/schema/providers';


import { openai } from '@ai-sdk/openai';

openai.transcriptionModel('')