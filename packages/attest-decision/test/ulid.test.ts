import { describe, it, expect } from "vitest";
import { ulid, monotonicUlidFactory } from "../src/index.js";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ULID", () => {
  it("is 26 Crockford-base32 chars", () => {
    expect(ulid()).toMatch(CROCKFORD);
  });

  it("encodes the timestamp in the first 10 chars", () => {
    const t = 1_758_499_800_000;
    const gen = monotonicUlidFactory(() => t);
    // Same ms -> identical time prefix.
    expect(gen().slice(0, 10)).toBe(gen().slice(0, 10));
  });

  it("is monotonic within the same millisecond", () => {
    const gen = monotonicUlidFactory(() => 1000);
    const ids = Array.from({ length: 1000 }, () => gen());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it("increases across milliseconds", () => {
    let t = 1000;
    const gen = monotonicUlidFactory(() => t);
    const a = gen();
    t = 2000;
    const b = gen();
    expect(b > a).toBe(true);
  });

  it("stays monotonic if the clock goes backwards", () => {
    let t = 5000;
    const gen = monotonicUlidFactory(() => t);
    const a = gen();
    t = 1; // clock regression
    const b = gen();
    expect(b > a).toBe(true);
  });
});
