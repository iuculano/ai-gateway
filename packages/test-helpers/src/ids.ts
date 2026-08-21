/**
 * Identifiers every unit tier shares.
 *
 * Fixed rather than generated so a failure message names the same organization
 * in gateway-backend as it does in @repo/auth, and so the two suites cannot
 * drift onto different literals for what is meant to be the same tenant.
 *
 * Table-specific ids stay with the fixtures that build those rows - only the
 * three that more than one workspace needs live here.
 */
export const ORGANIZATION_ID = '01912d3f-9b4a-7c3d-8e2f-000000000001';
export const USER_ID = '01912d3f-9b4a-7c3d-8e2f-000000000002';
export const KEY_ID = '01912d3f-9b4a-7c3d-8e2f-000000000003';
