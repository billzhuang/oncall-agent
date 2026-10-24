/** A fake external system: handles requests addressed to its host. */
export interface FakeService {
  handle(request: Request): Promise<Response>;
}

/**
 * The fake outbound network: routes `ports().fetch` by host to a fake service.
 * A request to any other host is recorded in `unexpected` and throws, so nothing leaks out of a test.
 */
export function router(routes: Record<string, FakeService>) {
  const unexpected: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const service = routes[new URL(request.url).host];
    if (!service) {
      unexpected.push(request.url);
      throw new Error(`unexpected outbound request to ${request.url}`);
    }
    return service.handle(request);
  };
  return { fetch, unexpected };
}
