import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import {
  pinSchema,
  renamePinSchema,
  tokenSchema,
  validate,
} from "../src/schemas.js";

describe("schema validation", () => {
  it("preserves defaults and inferred output types", () => {
    const pin = validate(pinSchema, { cid: "test-cid", public: true });
    const name: string = pin.name;
    expect(name).toBe("Untitled");

    const token = validate(tokenSchema, {
      name: "  Test token  ",
      scopes: ["pins:read"],
    });
    const expiresInDays: number = token.expiresInDays;
    expect(expiresInDays).toBe(30);
    expect(token.name).toBe("Test token");
  });

  it("rejects invalid input with an explicit HTTP 400 error", () => {
    expect.assertions(3);
    try {
      validate(pinSchema, { cid: "test-cid", public: false });
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPException);
      if (!(error instanceof HTTPException)) throw error;
      expect(error.status).toBe(400);
      expect(error.message).not.toBe("");
    }
  });

  it("preserves strict object validation and string transforms", () => {
    expect(validate(renamePinSchema, { name: "  Renamed  " })).toEqual({
      name: "Renamed",
    });
    expect(() =>
      validate(renamePinSchema, { name: "Renamed", extra: true }),
    ).toThrow(HTTPException);
    expect(() => validate(renamePinSchema, { name: "  " })).toThrow(
      HTTPException,
    );
  });
});
