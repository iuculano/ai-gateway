export const ACTOR_TYPE_CODES = {
  unknown: 0x00,
  user: 0x01,
  api_key: 0x02,
  system: 0x03,
} as const;

export type ActorType = keyof typeof ACTOR_TYPE_CODES;

/**
 * Reads an actor's type out of its id.
 *
 * @param id
 * A user or API key id.
 *
 * @returns
 * The actor type, or undefined for an id that wasn't made for an actor.
 */
export function getActorType(id: string): ActorType | undefined {
  // The last hex character is the last 4 bits - aka the type.
  const data = Number.parseInt(id.slice(-1), 16);

  // See if whatever we've grabbed matches a known actor type.
  for (const [type, code] of Object.entries(ACTOR_TYPE_CODES)) {
    if (data === code) {
      return type as ActorType;
    }
  }

  return undefined;
}

/**
 * Generates a new actor id with the specified type.
 *
 * @param type
 * The kind of actor the id is for.
 *
 * @returns
 * A new actor id with the specified type.
 */
export function generateActorId(type: ActorType): string {
  // Can just replace the last hex digit with the actor type.
  return Bun.randomUUIDv7().slice(0, -1) + ACTOR_TYPE_CODES[type].toString(16);
}
