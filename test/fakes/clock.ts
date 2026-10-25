/**
 * The controlled business clock behind `ports().now()`. Timers (Lifecycle jobs, alarms) stay on real time;
 * every decision reads this clock.
 */
export function fakeClock(start: number = Date.UTC(2026, 5, 1, 10, 0, 0)) {
  let t = start;
  return {
    now: (): number => t,
    advance(ms: number): void {
      t += ms;
    },
    set(ms: number): void {
      t = ms;
    },
  };
}
export type FakeClock = ReturnType<typeof fakeClock>;
