import { describe, expect, test } from "bun:test";
import {
  bookTickOptions,
  compact,
  countdown,
  percent,
  signed,
  tick,
} from "./format";

describe("book tick labels", () => {
  const labels = (reference: number, szDecimals: number, current = "raw") =>
    bookTickOptions(reference, szDecimals, current).map((o) => o.label);

  test("name each grouping by its price step at the current price", () => {
    expect(labels(84_777, 5)).toEqual(["1", "2", "5", "10", "100", "1,000"]);
    expect(labels(371.62, 3)).toEqual(["0.01", "0.02", "0.05", "0.1", "1", "10"]);
  });

  test("hide groupings no coarser than the exchange tick, except the selected one", () => {
    expect(labels(0.006345, 0)).toEqual(["0.000001", "0.00001", "0.0001"]);
    expect(
      bookTickOptions(0.006345, 0, "5:2").map((o) => o.value),
    ).toContain("5:2");
  });

  test("fall back to descriptive names before a price exists", () => {
    expect(labels(Number.NaN, 5)[0]).toBe("Full precision");
  });
});

describe("number formatting", () => {
  test("values that round to zero read as zero, without a sign", () => {
    expect(percent(-0.0000001)).toBe("0.00%");
    expect(percent(-0.00000001, 4)).toBe("0.0000%");
    expect(signed(-0.001)).toBe("0.00");
    expect(signed(12.345)).toBe("+12.35");
  });

  test("abbreviations keep fixed decimals in a column", () => {
    expect(compact(90_900_000)).toBe("90.90M");
    expect(compact(157_000_000)).toBe("157.00M");
    expect(compact(512)).toBe("512");
  });

  test("a spread takes the decimals of the price it belongs to", () => {
    expect(tick(1, 84_777, 5)).toBe("1");
    expect(tick(0.03, 371.62, 3)).toBe("0.03");
  });

  test("the funding countdown keeps a fixed width", () => {
    expect(countdown(9 * 60_000 + 31_000)).toBe("09:31");
    expect(countdown(0)).toBe("00:00");
  });
});
