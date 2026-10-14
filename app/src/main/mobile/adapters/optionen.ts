import type { JsonObject, JsonValue, StartOptionsData, ThemePayload } from '../../../mobile-shared/vertrag';
import type { MobileRouteHandlers } from '../http/server';

/**
 * Paket 10 projects `awb:sitz-wahl-daten` / `einstellungenDatenJetzt()`
 * (main.ts:4518, :5688) into this contract and obtains the four theme fields
 * from `themaPayload()` (thema.ts:404). No model registry is re-read here.
 */
export interface OptionsForMobile {
  /** `einstellungenDatenJetzt()` / `awb:sitz-wahl-daten` — main.ts:4518/:5688. */
  sessionOptions(): Promise<StartOptionsData> | StartOptionsData;
  /** `themaPayload()` — app/src/main/thema.ts:404. */
  theme(): Promise<ThemePayload> | ThemePayload;
}

/** Seit Paket 10 routet der Server `GET /session-options` selbst. */
export type SessionOptionsHandlers = Pick<MobileRouteHandlers, 'GET /session-options'>;

export function createSessionOptionsHandlers(source: OptionsForMobile): SessionOptionsHandlers {
  return {
    'GET /session-options': async () => ({ data: await source.sessionOptions() as unknown as JsonValue }),
  };
}

/** Used by Paket 10's GET /bootstrap aggregator; validates that no fifth theme field is invented. */
export async function mobileTheme(source: OptionsForMobile): Promise<ThemePayload> {
  const theme = await source.theme();
  for (const field of ['thema', 'wirksam', 'akzent', 'akzentText'] as const) {
    if (!theme[field]) throw new Error(`themaPayload is missing ${field}`);
  }
  return theme as ThemePayload & JsonObject;
}
