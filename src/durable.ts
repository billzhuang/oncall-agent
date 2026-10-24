import type { AlertEpisodeKey } from "./intake";

/**
 * Durable Object namespaces in the configured jurisdiction (`eu` in production), so Investigation state from
 * EU Orgs stays in EU storage. workerd cannot run jurisdictions, so tests set DO_JURISDICTION to "".
 * Always address Durable Objects through this module, and by name (Lifecycle needs named ids).
 */
export function euNamespace<T extends Rpc.DurableObjectBranded | undefined>(
  env: Env,
  ns: DurableObjectNamespace<T>,
): DurableObjectNamespace<T> {
  return env.DO_JURISDICTION ? ns.jurisdiction(env.DO_JURISDICTION as DurableObjectJurisdiction) : ns;
}

/** Durable Object name for an Alert episode key. Org names cannot contain ':', and the group comes last. */
export function episodeName(key: AlertEpisodeKey): string {
  return `${key.org}:${key.monitorId}:${key.group}`;
}

/** The Investigation Durable Object that hosts the Alert episode `(org, monitor, group)`. */
export function investigationStub(env: Env, key: AlertEpisodeKey) {
  return euNamespace(env, env.INVESTIGATION).getByName(episodeName(key));
}

/** The singleton Coordinator. */
export function coordinatorStub(env: Env) {
  return euNamespace(env, env.COORDINATOR).getByName("coordinator");
}
